// Main-thread side of the runtime: in a worker, or on the UI thread where
// workers are forbidden.
import workerSource from 'virtual:worker';
import type { Pack } from './pack';
import { createRuntime, type Runtime } from './core';
import { STDIN_SAB_SIZE, type FromWorker, type ToWorker, type WorkerRole } from './protocol';

export interface RunOutcome {
  ok: boolean;
  exit: number;
  ms: number;
  /** Set when the program asked for input in replay mode. */
  needInput?: { prompt: string; emitted: number; images: number };
  stopped?: boolean;
}

export interface BridgeEvents {
  log?(text: string): void;
  /** Only used by the built-in interpreter, where input() really blocks. */
  requestInput?(prompt: string): Promise<string | null>;
  out?(stream: 'stdout' | 'stderr', text: string): void;
  image?(png: ArrayBuffer): void;
  waitInput?(): void;
  filesChanged?(files: Record<string, string>): void;
  fatal?(message: string): void;
}

export interface PythonHost {
  readonly role: WorkerRole;
  readonly mainThread: boolean;
  readonly blockingStdin: boolean;
  readonly running: boolean;
  python: string;
  start(pack: Pack | null): Promise<{ python: string; loadMs: number }>;
  stop(): void;
  syncFiles(files: Record<string, string>, deleted?: string[]): void;
  run(code: string, filename: string, stdin: string[], suppress: number, suppressImages: number, seed: number): Promise<RunOutcome>;
  repl(line: string): Promise<Extract<FromWorker, { type: 'replResult' }>>;
  lsp<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
  answerInput(line: string | null): void;
}

abstract class PythonBase implements PythonHost {
  protected nextId = 1;
  protected pendingRun = new Map<number, (r: RunOutcome) => void>();
  protected pendingRepl = new Map<number, (r: Extract<FromWorker, { type: 'replResult' }>) => void>();
  protected pendingLsp = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  protected readyResolve: ((info: { python: string; loadMs: number }) => void) | null = null;
  python = '';
  abstract readonly role: WorkerRole;
  abstract readonly mainThread: boolean;
  abstract readonly blockingStdin: boolean;
  abstract readonly running: boolean;
  abstract start(pack: Pack): Promise<{ python: string; loadMs: number }>;
  abstract stop(): void;
  answerInput(_line: string | null): void {}

  constructor(protected events: BridgeEvents) {}

  protected abstract send(msg: ToWorker): void;

  protected rejectAll(): void {
    for (const [, r] of this.pendingRun) r({ ok: false, exit: 130, ms: 0, stopped: true });
    this.pendingRun.clear();
    for (const [, r] of this.pendingRepl) r({ type: 'replResult', id: 0, status: 'complete', error: 'stopped' });
    this.pendingRepl.clear();
    for (const [, p] of this.pendingLsp) p.reject(new Error('stopped'));
    this.pendingLsp.clear();
  }

  syncFiles(files: Record<string, string>, deleted: string[] = []): void {
    if (!this.running) return;
    this.send({ type: 'syncFiles', files, deleted });
  }

  run(code: string, filename: string, stdin: string[], suppress: number, suppressImages: number, seed: number): Promise<RunOutcome> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pendingRun.set(id, resolve);
      this.send({ type: 'run', id, code, filename, stdin, suppress, suppressImages, seed });
    });
  }

  repl(line: string): Promise<Extract<FromWorker, { type: 'replResult' }>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pendingRepl.set(id, resolve);
      this.send({ type: 'repl', id, line });
    });
  }

  lsp<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pendingLsp.set(id, { resolve: resolve as (r: unknown) => void, reject });
      try {
        this.send({ type: 'lsp', id, method, params });
      } catch (e) {
        this.pendingLsp.delete(id);
        reject(e as Error);
      }
    });
  }

  protected handle(m: FromWorker): void {
    switch (m.type) {
      case 'log':
        this.events.log?.(m.text);
        break;
      case 'ready':
        this.python = m.python;
        this.readyResolve?.({ python: m.python, loadMs: m.loadMs });
        this.readyResolve = null;
        break;
      case 'out':
        this.events.out?.(m.stream, m.text);
        break;
      case 'image':
        this.events.image?.(m.png);
        break;
      case 'waitInput':
        this.events.waitInput?.();
        break;
      case 'needInput': {
        const r = this.pendingRun.get(m.id);
        this.pendingRun.delete(m.id);
        r?.({ ok: false, exit: 0, ms: 0, needInput: { prompt: m.prompt, emitted: m.emitted, images: m.images } });
        break;
      }
      case 'done': {
        const r = this.pendingRun.get(m.id);
        this.pendingRun.delete(m.id);
        r?.({ ok: m.ok, exit: m.exit, ms: m.ms });
        break;
      }
      case 'replResult': {
        const r = this.pendingRepl.get(m.id);
        this.pendingRepl.delete(m.id);
        r?.(m);
        break;
      }
      case 'lspResult': {
        const p = this.pendingLsp.get(m.id);
        this.pendingLsp.delete(m.id);
        if (!p) break;
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.result);
        break;
      }
      case 'filesChanged':
        this.events.filesChanged?.(m.files);
        break;
      case 'fatal':
        this.events.fatal?.(m.message);
        break;
    }
  }
}

export class PythonWorker extends PythonBase {
  readonly mainThread = false;
  private worker: Worker | null = null;
  private url: string | null = null;
  readonly stdinBuffer: SharedArrayBuffer | null;
  private stdinI32: Int32Array | null = null;
  private stdinBytes: Uint8Array | null = null;

  constructor(
    readonly role: WorkerRole,
    events: BridgeEvents,
  ) {
    super(events);
    this.stdinBuffer = role !== 'lsp' && typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(STDIN_SAB_SIZE) : null;
    if (this.stdinBuffer) {
      this.stdinI32 = new Int32Array(this.stdinBuffer, 0, 2);
      this.stdinBytes = new Uint8Array(this.stdinBuffer, 8);
    }
  }

  get blockingStdin(): boolean {
    return this.stdinBuffer !== null;
  }

  get running(): boolean {
    return this.worker !== null;
  }

  start(pack: Pack): Promise<{ python: string; loadMs: number }> {
    this.stop();
    this.url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    const w = new Worker(this.url, { name: `crazy-${this.role}` });
    this.worker = w;
    w.onmessage = (ev: MessageEvent<FromWorker>) => this.handle(ev.data);
    w.onerror = (ev) => this.events.fatal?.(`worker error: ${ev.message}`);
    const msg: ToWorker = { type: 'init', role: this.role, buffer: pack.buffer, base: pack.base, files: pack.index.files, stdinBuffer: this.stdinBuffer };
    return new Promise((resolve) => {
      this.readyResolve = resolve;
      w.postMessage(msg);
    });
  }

  stop(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.rejectAll();
  }

  protected send(msg: ToWorker): void {
    if (!this.worker) throw new Error('Python is not running');
    this.worker.postMessage(msg);
  }

  /** SAB mode only: hands a line to a blocked input() call. */
  answerInput(line: string | null): void {
    if (!this.stdinI32 || !this.stdinBytes) return;
    if (line === null) {
      Atomics.store(this.stdinI32, 0, 2);
    } else {
      const bytes = new TextEncoder().encode(line + '\n');
      const n = Math.min(bytes.length, this.stdinBytes.length);
      this.stdinBytes.set(bytes.subarray(0, n));
      Atomics.store(this.stdinI32, 1, n);
      Atomics.store(this.stdinI32, 0, 1);
    }
    Atomics.notify(this.stdinI32, 0);
  }
}

/** Runtime on the UI thread. Programs block the UI; a watchdog stops runaway loops. */
export class MainThreadPython extends PythonBase {
  readonly role: WorkerRole = 'both';
  readonly mainThread = true;
  readonly blockingStdin = false;
  private runtime: Runtime | null = null;
  private readyPromise: Promise<{ python: string; loadMs: number }> | null = null;

  get running(): boolean {
    return this.runtime !== null;
  }

  start(pack: Pack): Promise<{ python: string; loadMs: number }> {
    if (this.readyPromise) return this.readyPromise;
    this.runtime = createRuntime({
      post: (m) => this.handle(m),
      evalScript: (source) => {
        (0, eval)(new TextDecoder().decode(source));
      },
      mainThread: true,
    });
    const rt = this.runtime;
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
      void rt.handle({ type: 'init', role: 'both', buffer: pack.buffer, base: pack.base, files: pack.index.files, stdinBuffer: null });
    });
    return this.readyPromise;
  }

  stop(): void {
    // can't interrupt a running program here; just drop the instance
    this.runtime = null;
    this.readyPromise = null;
    this.rejectAll();
  }

  protected send(msg: ToWorker): void {
    const rt = this.runtime;
    if (!rt) throw new Error('Python is not running');
    // Defer runs a little so the UI can paint the "running" state first.
    if (msg.type === 'run') setTimeout(() => void rt.handle(msg), 40);
    else void rt.handle(msg);
  }
}
