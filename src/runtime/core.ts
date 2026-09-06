// The Python runtime, shared by the worker and UI-thread hosts.
import type { ToWorker, FromWorker, WorkerRole } from './protocol';
import runtimePy from './python/runtime.py';
import lspPy from './python/lsp.py';
import onelinePy from './python/oneline.py';

declare const loadPyodide: typeof import('pyodide').loadPyodide;
type Pyodide = Awaited<ReturnType<typeof loadPyodide>>;

export const INDEX_URL = 'https://crazy.invalid/pyodide/';

export interface RuntimeEnv {
  post(m: FromWorker, transfer?: Transferable[]): void;
  /** Evaluates pyodide.asm.js so that the global _createPyodideModule exists. */
  evalScript(source: Uint8Array<ArrayBuffer>): void;
  /** True on the UI thread: no Atomics.wait for stdin, run-time watchdog on. */
  mainThread: boolean;
}

export interface Runtime {
  handle(msg: ToWorker): Promise<void>;
}

/** Seconds a program may run on the UI thread before the watchdog stops it. */
export const MAIN_THREAD_TIME_LIMIT = 60;

function contentType(name: string): string {
  if (name.endsWith('.wasm')) return 'application/wasm';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.js')) return 'text/javascript';
  return 'application/octet-stream';
}

// serves Pyodide's file fetches from the in-memory pack
function installFetchPatch(): void {
  const g = globalThis as any;
  if (g.__crazyFetchPatched) return;
  g.__crazyFetchPatched = true;
  const original = g.fetch.bind(g);
  g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(INDEX_URL)) {
      const name = url.slice(INDEX_URL.length).split(/[?#]/)[0];
      const data: Uint8Array<ArrayBuffer> | undefined = g.__crazyPackFiles?.[name];
      if (!data) return Promise.resolve(new Response(null, { status: 404, statusText: 'not in pack' }));
      return Promise.resolve(new Response(data, { status: 200, headers: { 'Content-Type': contentType(name) } }));
    }
    return original(input, init);
  }) as typeof fetch;
}

export function createRuntime(env: RuntimeEnv): Runtime {
  const post = env.post;
  const log = (text: string) => post({ type: 'log', text });

  let role: WorkerRole = 'run';
  let pyodide: Pyodide | null = null;
  let files: Record<string, Uint8Array<ArrayBuffer>> = {};
  let stdinI32: Int32Array | null = null;
  let stdinBytes: Uint8Array | null = null;

  // replay mode: how much output this run has emitted / still has to suppress
  let emitted = 0;
  let suppress = 0;
  let images = 0;
  let suppressImages = 0;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

  function emit(stream: 'stdout' | 'stderr', text: string): void {
    if (!text) return;
    if (suppress > 0) {
      if (text.length <= suppress) {
        suppress -= text.length;
        emitted += text.length;
        return;
      }
      text = text.slice(suppress);
      emitted += suppress;
      suppress = 0;
    }
    emitted += text.length;
    post({ type: 'out', stream, text });
  }

  function emitImage(bytes: any): void {
    let arr: Uint8Array;
    if (bytes && typeof bytes.toJs === 'function') {
      arr = bytes.toJs();
      bytes.destroy?.();
    } else arr = bytes as Uint8Array;
    images++;
    if (suppressImages > 0) {
      suppressImages--;
      return;
    }
    const copy = new Uint8Array(arr).buffer;
    post({ type: 'image', png: copy }, [copy]);
  }

  /** Blocking line read via SharedArrayBuffer (worker only). Returns null on EOF. */
  function blockingReadLine(): string | null {
    if (!stdinI32 || !stdinBytes) return null;
    Atomics.store(stdinI32, 0, 0);
    post({ type: 'waitInput', prompt: '' });
    Atomics.wait(stdinI32, 0, 0);
    const state = Atomics.load(stdinI32, 0);
    if (state === 2) return null;
    const len = Atomics.load(stdinI32, 1);
    return new TextDecoder().decode(stdinBytes.slice(0, len));
  }

  /** Loads bundled Pyodide packages (numpy, matplotlib, ...) that `code` imports. */
  async function loadPackagesFor(code: string, report: boolean): Promise<void> {
    if (!pyodide || !/\bimport\b/.test(code)) return;
    try {
      await pyodide.loadPackagesFromImports(code, {
        messageCallback: () => {},
        errorCallback: (m: string) => {
          if (report) emit('stderr', `[package] ${m}\n`);
        },
      });
    } catch (e: any) {
      if (report) emit('stderr', `[package] ${e?.message ?? e}\n`);
    }
  }

  const py = (name: string) => pyodide!.globals.get(name);
  const call = (name: string, ...args: unknown[]) => {
    const fn = py(name);
    try {
      return fn(...args);
    } finally {
      fn.destroy?.();
    }
  };

  async function init(msg: Extract<ToWorker, { type: 'init' }>): Promise<void> {
    const t0 = performance.now();
    role = msg.role;
    for (const [name, [off, len]] of Object.entries(msg.files)) {
      files[name] = new Uint8Array(msg.buffer as ArrayBuffer, msg.base + off, len);
    }
    (globalThis as any).__crazyPackFiles = files;
    if (msg.stdinBuffer && !env.mainThread) {
      stdinI32 = new Int32Array(msg.stdinBuffer, 0, 2);
      stdinBytes = new Uint8Array(msg.stdinBuffer, 8);
    }
    installFetchPatch();

    if (typeof (globalThis as any)._createPyodideModule !== 'function') env.evalScript(files['pyodide.asm.js']);

    // MPLBACKEND=Agg: figures are rendered to PNG and sent to the UI.
    pyodide = await loadPyodide({ indexURL: INDEX_URL, env: { MPLBACKEND: 'Agg', HOME: '/home/pyodide' } });
    pyodide.setStdout({ write: (buf: Uint8Array) => (emit('stdout', decoders.stdout.decode(buf, { stream: true })), buf.length), isatty: false });
    pyodide.setStderr({ write: (buf: Uint8Array) => (emit('stderr', decoders.stderr.decode(buf, { stream: true })), buf.length), isatty: false });

    const sitePackages: string = pyodide.runPython('import site; site.getsitepackages()[0]');
    for (const name of Object.keys(files)) {
      if (name.startsWith('wheels/') && name.endsWith('.whl')) {
        pyodide.unpackArchive(files[name], 'zip', { extractDir: sitePackages });
      }
    }
    pyodide.FS.mkdirTree('/workspace');

    if (role === 'run' || role === 'both') {
      pyodide.runPython(runtimePy);
      if (stdinI32) py('_stdin').blocking_reader = blockingReadLine;
      call('_crazy_set_image_emitter', emitImage);
      call('_crazy_repl', (t: string) => emit('stdout', t), (t: string) => emit('stderr', t));
      if (env.mainThread) call('_crazy_set_time_limit', MAIN_THREAD_TIME_LIMIT);
    }
    if (role === 'lsp' || role === 'both') {
      pyodide.runPython(onelinePy);
      pyodide.runPython(lspPy);
    }

    const python: string = pyodide.runPython('import sys; sys.version');
    post({ type: 'ready', python, loadMs: Math.round(performance.now() - t0) });

    if (role === 'lsp' || role === 'both') {
      const t1 = performance.now();
      pyodide.runPython('warmup()');
      log(`lsp warm in ${(performance.now() - t1).toFixed(0)} ms`);
    }
  }

  function syncFiles(msg: Extract<ToWorker, { type: 'syncFiles' }>): void {
    if (!pyodide) return;
    if (role === 'run' || role === 'both') {
      call('_crazy_write_files', JSON.stringify(msg.files), JSON.stringify(msg.deleted));
      return;
    }
    const FS = pyodide.FS as any;
    for (const rel of msg.deleted) {
      const p = '/workspace/' + rel;
      try {
        const info = FS.analyzePath(p);
        if (info.exists) {
          if (FS.isDir(info.object.mode)) rmTree(FS, p);
          else FS.unlink(p);
        }
      } catch {}
    }
    for (const [rel, content] of Object.entries(msg.files)) {
      const p = '/workspace/' + rel;
      FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
      FS.writeFile(p, content);
    }
  }

  function rmTree(FS: any, p: string): void {
    for (const name of FS.readdir(p)) {
      if (name === '.' || name === '..') continue;
      const child = p + '/' + name;
      if (FS.isDir(FS.stat(child).mode)) rmTree(FS, child);
      else FS.unlink(child);
    }
    FS.rmdir(p);
  }

  async function run(msg: Extract<ToWorker, { type: 'run' }>): Promise<void> {
    if (!pyodide) return post({ type: 'done', id: msg.id, ok: false, exit: 1, ms: 0 });
    const t0 = performance.now();
    emitted = 0;
    suppress = msg.suppress;
    images = 0;
    suppressImages = msg.suppressImages;
    await loadPackagesFor(msg.code, true);
    const result: { ok?: boolean; exit?: number; needInput?: string } = JSON.parse(call('_crazy_run', msg.code, msg.filename, msg.seed, msg.stdin));
    emit('stdout', decoders.stdout.decode());
    emit('stderr', decoders.stderr.decode());
    const ms = Math.round(performance.now() - t0);
    if (result.needInput !== undefined) {
      post({ type: 'needInput', id: msg.id, prompt: result.needInput, emitted, images });
      return;
    }
    collectChanges();
    post({ type: 'done', id: msg.id, ok: !!result.ok, exit: result.exit ?? 0, ms });
  }

  function collectChanges(): void {
    if (!pyodide) return;
    const changed = JSON.parse(call('_crazy_collect_changes'));
    if (Object.keys(changed).length) post({ type: 'filesChanged', files: changed });
  }

  async function repl(msg: Extract<ToWorker, { type: 'repl' }>): Promise<void> {
    if (!pyodide) return;
    emitted = 0;
    suppress = 0;
    suppressImages = 0;
    await loadPackagesFor(msg.line, true);
    const stdin = py('_stdin');
    stdin.in_repl = true;
    stdin.lines = pyodide.toPy([]);
    call('_crazy_prepare_plots');
    const console = py('_repl');
    const fut = console.push(msg.line);
    const status = fut.syntax_check as 'incomplete' | 'complete' | 'syntax-error';
    try {
      if (status === 'incomplete') {
        post({ type: 'replResult', id: msg.id, status });
        return;
      }
      if (status === 'syntax-error') {
        post({ type: 'replResult', id: msg.id, status, error: fut.formatted_error });
        return;
      }
      let value = '';
      try {
        const r = await fut;
        value = call('_crazy_repl_display', r);
        if (r && typeof r.destroy === 'function') r.destroy();
      } catch {
        post({ type: 'replResult', id: msg.id, status, error: fut.formatted_error ?? 'error' });
        return;
      }
      call('_crazy_flush_figures');
      collectChanges();
      post({ type: 'replResult', id: msg.id, status, value });
    } finally {
      fut.destroy?.();
      console.destroy();
      stdin.destroy();
    }
  }

  let dispatchFn: any = null;
  async function lsp(msg: Extract<ToWorker, { type: 'lsp' }>): Promise<void> {
    if (!pyodide) return post({ type: 'lspResult', id: msg.id, error: 'not ready' });
    if (typeof msg.params.code === 'string') await loadPackagesFor(msg.params.code, false);
    if (!dispatchFn) dispatchFn = py('dispatch');
    const r = JSON.parse(dispatchFn(msg.method, JSON.stringify(msg.params)));
    post({ type: 'lspResult', id: msg.id, result: r.result, error: r.error });
  }

  return {
    async handle(msg: ToWorker): Promise<void> {
      try {
        switch (msg.type) {
          case 'init':
            await init(msg);
            break;
          case 'syncFiles':
            syncFiles(msg);
            break;
          case 'run':
            await run(msg);
            break;
          case 'repl':
            await repl(msg);
            break;
          case 'lsp':
            await lsp(msg);
            break;
        }
      } catch (e: any) {
        post({ type: 'fatal', message: e?.stack ?? String(e) });
      }
    },
  };
}
