import type { Host } from '../boot/mount';
import type { Environment } from '../boot/probe';
import { MainThreadPython, PythonWorker, type PythonHost, type RunOutcome } from '../runtime/bridge';
import { PyJsHost } from '../runtime/pyjs-host';
import { MAIN_THREAD_TIME_LIMIT } from '../runtime/core';
import { packFile } from '../runtime/pack';
import { acceptRaw, loadCachedPack, loadDevPack, pickPackFile } from '../runtime/loader';
import type { Pack } from '../runtime/pack';
import { kvDelete, kvGet, kvSet } from '../runtime/store';
import { Editor, type LspClient } from '../editor/editor';
import { Terminal } from '../terminal/terminal';
import { Workspace } from './workspace';
import { loadSettings, saveSettings, type Settings } from './settings';
import { applyTerminalTheme, applyUiTheme, TERMINAL_THEMES, UI_THEMES, terminalTheme, uiTheme } from './themes';
import { APP_CSS } from '../ui/styles';
import { buildLayout, type LayoutRefs } from '../ui/layout';
import { Dialogs } from '../ui/dialogs';
import { Palette, type PaletteItem } from '../ui/palette';
import { FileTree } from '../ui/tree';
import { TabBar } from '../ui/tabs';
import { ProblemsView } from '../ui/problems';
import { openSettings } from '../ui/settings-panel';
import { Repl } from '../ui/repl';
import { icon } from '../ui/icons';
import { readZip, writeZip } from '../util/zip';

/** Modules the built-in interpreter provides. */
const BUILT_IN_MODULES = ['math', 'random', 'json', 'time', 'sys', 'os', 'string', 'itertools', 'functools', 'collections', 'statistics', 'copy', 're', 'heapq', 'bisect', 'datetime'];

interface Command {
  id: string;
  label: string;
  keys?: string;
  run: () => void;
  when?: () => boolean;
}

type PyStatus = 'blocked' | 'no-runtime' | 'starting' | 'ready' | 'running' | 'waiting' | 'crashed';
// worker: Pyodide in a worker. main: Pyodide on the UI thread. pyjs: the JS interpreter.
export type RuntimeMode = 'worker' | 'main' | 'pyjs';

export class App {
  private ws = new Workspace();
  private settings!: Settings;
  private L!: LayoutRefs;
  private dialogs!: Dialogs;
  private palette!: Palette;
  private editor!: Editor;
  private tree!: FileTree;
  private tabs!: TabBar;
  private terminal!: Terminal;
  private repl!: Repl;
  private problems!: ProblemsView;
  private runWorker!: PythonHost;
  private lspWorker!: PythonHost;
  readonly mode: RuntimeMode;
  private lspClient!: LspClient & { ready: boolean };
  private pack: Pack | null = null;
  private status: PyStatus = 'starting';
  private commands = new Map<string, Command>();
  private st = {} as Record<string, HTMLElement>;
  private runSeq = 0;
  private lspSyncTimer = 0;
  private pendingLspSync = new Map<string, string>();
  private packPickerClose: (() => void) | null = null;

  constructor(
    private host: Host,
    private env: Environment,
  ) {
    this.mode = !env.wasm ? 'pyjs' : env.blobWorker ? 'worker' : 'main';
  }

  async start(): Promise<void> {
    this.settings = await loadSettings();
    const style = this.host.doc.createElement('style');
    style.textContent = APP_CSS;
    this.host.head.appendChild(style);
    this.applyThemes();
    await this.ws.load();
    this.L = await buildLayout(this.host);
    this.dialogs = new Dialogs(this.L.app);
    this.palette = new Palette(this.L.app);
    this.buildWorkers();
    this.buildPanels();
    this.buildEditor();
    this.buildSidebar();
    this.buildStatusbar();
    this.registerCommands();
    this.bindKeys();
    this.ws.on((e) => this.onWorkspaceEvent(e));
    this.tree.render();
    this.tabs.render();
    this.openActive();
    this.L.runBtn.onclick = () => this.run();
    this.L.stopBtn.onclick = () => this.stop();
    (this.L.toolbar.querySelector('[data-cmd=palette]') as HTMLButtonElement).onclick = () => this.openPalette();
    (this.L.toolbar.querySelector('[data-cmd=settings]') as HTMLButtonElement).onclick = () => this.openSettings();
    (this.L.toolbar.querySelector('[data-cmd=oneline]') as HTMLButtonElement).onclick = () => void this.oneline();
    this.exposeTestApi();
    this.welcomeDone = this.maybeShowWelcome();
    await this.bootRuntime();
  }

  // welcome
  private welcomeDone: Promise<void> = Promise.resolve();
  private welcomeClose: (() => void) | null = null;

  private async maybeShowWelcome(): Promise<void> {
    let seen = false;
    try {
      seen = !!(await kvGet<boolean>('welcome-seen'));
    } catch {}
    if (seen) return;
    await this.showWelcome();
  }

  showWelcome(): Promise<void> {
    return new Promise((resolve) => {
      const packages = this.pack?.index.requested ?? ['numpy', 'matplotlib'];
      const builtIn = this.mode === 'pyjs';
      const close = this.dialogs.modal(
        'Welcome to CrazyCodeEditor',
        (body, foot, closeFn) => {
          body.className += ' helpdoc welcome';
          body.innerHTML = `
<h3>Run code</h3>
<p><kbd>F5</kbd> or <kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs the open file. Output, plots and errors appear in the panel below. Click a traceback line to jump to it. <kbd>Ctrl</kbd>+<kbd>\`</kbd> opens a REPL that shares variables with your last run.</p>
${builtIn ? `<h3>Which Python is running</h3>
<p>This app forbids WebAssembly, so the editor is using its own Python interpreter, written in JavaScript and carried inside the file you pasted. Nothing else had to be downloaded. Everyday Python works; <code>input()</code> pauses properly and Stop is instant. "Help: About the built-in interpreter" lists what differs.</p>` : `<h3>input() works a little differently</h3>
<p>This app can't pause Python mid-run, so when your program asks for input it stops, shows the prompt inline, and after you answer it <b>replays from the start</b> with your answers filled in. Output you already saw is not repeated and random numbers stay the same, so it looks like one continuous run. Programs that write files or use the clock before an <code>input()</code> will do that part twice.</p>`}
<h3>Your files</h3>
<p>The Explorer on the left is a private project stored inside this app. Python sees it as a real folder, so <code>open("data.txt")</code> and <code>import helper</code> work between your files. Nothing is written to your real disk unless you use Export. Everything is saved automatically.</p>
<h3>Modules</h3>
${builtIn ? `<p>Ready to import: ${BUILT_IN_MODULES.map((m) => `<span class="pk">${m}</span>`).join('')}</p>` : `<p>Bundled and ready to import: ${packages.map((p) => `<span class="pk">${p}</span>`).join('')} <span class="pk">the standard library</span>. <code>plt.show()</code> draws inline in the output.</p>`}
<p>There is no internet access, so <code>pip install</code> does not work.</p>
<h3>Handy keys</h3>
<table>
<tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd></td><td>Every command, searchable</td></tr>
<tr><td><kbd>Ctrl</kbd>+<kbd>P</kbd></td><td>Jump to a file</td></tr>
<tr><td><kbd>Ctrl</kbd>+<kbd>Space</kbd></td><td>Autocomplete (it also pops up as you type)</td></tr>
${builtIn ? '' : `<tr><td><kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd></td><td>Format with Black</td></tr>
<tr><td><kbd>F12</kbd></td><td>Go to definition</td></tr>`}
<tr><td><kbd>Ctrl</kbd>+<kbd>,</kbd></td><td>Settings: themes, font size, autocomplete</td></tr>
</table>
<p style="margin-top:10px;color:var(--fgMuted)">Avoid <kbd>Ctrl</kbd>+<kbd>W</kbd> and <kbd>Ctrl</kbd>+<kbd>R</kbd>: the app you pasted into usually owns those (close window, reload). Your work is saved either way. Reopen this page any time with "Help: Welcome" in the command palette.</p>`;
          const again = document.createElement('label');
          again.style.cssText = 'display:flex;align-items:center;gap:6px;margin-right:auto;font-size:12px;color:var(--fgMuted)';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = true;
          again.append(cb, "Don't show this again");
          const go = document.createElement('button');
          go.className = 'btn primary';
          go.textContent = 'Get started';
          go.onclick = () => {
            if (cb.checked) void kvSet('welcome-seen', true).catch(() => {});
            closeFn();
          };
          foot.append(again, go);
          setTimeout(() => go.focus());
        },
        { wide: true },
      );
      this.welcomeClose = () => {
        close();
        this.welcomeClose = null;
        resolve();
      };
      // the modal can also close on Escape, so poll
      const poll = window.setInterval(() => {
        if (!this.L.app.querySelector('.welcome')) {
          clearInterval(poll);
          this.welcomeClose = null;
          resolve();
        }
      }, 200);
    });
  }

  // runtime
  private buildWorkers(): void {
    const runEvents = {
      out: (stream: 'stdout' | 'stderr', text: string) => this.terminal.write(stream, text),
      image: (png: ArrayBuffer) => {
        this.L.showPanel('output');
        this.terminal.image(png);
      },
      waitInput: () => this.onBlockingInput(),
      filesChanged: (files: Record<string, string>) => this.onFilesChanged(files),
      fatal: (m: string) => {
        this.terminal.write('stderr', `\n[python crashed] ${m}\n`);
        this.setStatus('crashed');
      },
      log: (t: string) => console.log('[crazy:run]', t),
    };
    if (this.mode === 'pyjs') {
      // no wasm: use the JS interpreter
      const py = new PyJsHost({
        ...runEvents,
        waitInput: undefined,
        requestInput: async () => {
          this.setStatus('waiting');
          const line = await this.terminal.readLine();
          if (this.status === 'waiting') this.setStatus('running');
          return line;
        },
      });
      this.runWorker = py;
      this.lspWorker = py;
    } else if (this.mode === 'main') {
      // no blob workers: one Pyodide on the main thread does both jobs
      const py = new MainThreadPython(runEvents);
      this.runWorker = py;
      this.lspWorker = py;
    } else {
      this.runWorker = new PythonWorker('run', runEvents);
      this.lspWorker = new PythonWorker('lsp', {
        log: (t) => console.log('[crazy:lsp]', t),
        fatal: (m) => console.error('[crazy:lsp]', m),
      });
    }
    const call = <T,>(method: string, params: Record<string, unknown>) => this.lspWorker.lsp<T>(method, params);
    this.lspClient = {
      ready: false,
      complete: (code, line, col, path) => call('complete', { code, line, col, path }),
      detail: (code, line, col, path, name) => call('detail', { code, line, col, path, name }),
      hover: (code, line, col, path) => call('hover', { code, line, col, path }),
      lint: (code, path) => call('lint', { code, path }),
    };
  }

  private async bootRuntime(): Promise<void> {
    if (this.mode === 'pyjs') {
      // nothing to load, it's in the bundle
      await this.startWorkers();
      return;
    }
    this.setStatus('starting', 'Looking for runtime…');
    let pack = await loadCachedPack();
    if (!pack) {
      try {
        pack = await loadDevPack();
      } catch (e: any) {
        this.dialogs.toast(`Dev pack failed: ${e.message}`, 'warning');
      }
    }
    if (!pack) {
      this.setStatus('no-runtime');
      pack = await this.askForPack();
    }
    this.pack = pack;
    await this.startWorkers();
  }

  private async askForPack(): Promise<Pack> {
    await this.welcomeDone;
    return new Promise((resolve) => {
      this.packPickerClose = this.dialogs.modal('Python runtime needed', (body, foot) => {
        body.innerHTML = `<p>This app has not seen the Python runtime yet. Pick <b>crazy-runtime.pack</b> from the CrazyCodeEditor folder (the one next to crazy.js). You only do this once per app; it is cached afterwards.</p>`;
        const table = document.createElement('table');
        table.className = 'boot-table';
        const rows: Array<[string, string, boolean]> = [
          ['Electron', this.env.electron ?? 'not detected', !!this.env.electron],
          ['WebAssembly', String(this.env.wasm), this.env.wasm],
          ['Workers', String(this.env.blobWorker), this.env.blobWorker],
          ['Blocking stdin (SharedArrayBuffer)', this.env.sharedArrayBuffer ? 'yes' : 'no, using replay mode', true],
          ['IndexedDB cache', String(this.env.indexedDB), this.env.indexedDB],
        ];
        for (const [k, v, ok] of rows) {
          const tr = document.createElement('tr');
          const a = document.createElement('td');
          a.textContent = k;
          const b = document.createElement('td');
          b.textContent = v;
          b.className = ok ? 'ok' : 'bad';
          tr.append(a, b);
          table.appendChild(tr);
        }
        body.appendChild(table);
        const msg = document.createElement('div');
        msg.className = 'boot-msg';
        body.appendChild(msg);
        const pick = document.createElement('button');
        pick.className = 'btn primary';
        pick.textContent = 'Choose crazy-runtime.pack…';
        pick.onclick = async () => {
          pick.disabled = true;
          msg.className = 'boot-msg';
          try {
            const raw = await pickPackFile();
            if (!raw) throw new Error('No file chosen.');
            msg.textContent = `Unpacking ${(raw.byteLength / 1048576).toFixed(1)} MB…`;
            const pack = await acceptRaw(raw);
            this.packPickerClose?.();
            this.packPickerClose = null;
            resolve(pack);
          } catch (e: any) {
            msg.textContent = e.message;
            msg.className = 'boot-msg err';
            pick.disabled = false;
          }
        };
        const later = document.createElement('button');
        later.className = 'btn';
        later.textContent = 'Not now (edit only)';
        later.onclick = () => {
          this.packPickerClose?.();
          this.packPickerClose = null;
          this.terminal.system('No runtime loaded. Use "Python: Load runtime pack" from the command palette when ready.');
        };
        foot.append(later, pick);
      });
    });
  }

  private async startWorkers(): Promise<void> {
    if (!this.pack && this.mode !== 'pyjs') return;
    if (this.mode === 'main' && !this.mainThreadCanStart()) return;
    this.setStatus('starting', 'Starting Python…');
    this.lspClient.ready = false;
    const t0 = performance.now();
    const [run] = this.mode === 'worker'
      ? await Promise.all([
          this.runWorker.start(this.pack),
          this.lspWorker.start(this.pack).then((info) => {
            this.lspClient.ready = true;
            this.syncLspAll();
            return info;
          }),
        ])
      : [await this.runWorker.start(this.pack)];
    if (this.mode !== 'worker') {
      this.lspClient.ready = true;
      this.syncLspAll();
    }
    this.syncRunAll();
    this.setStatus('ready');
    if (this.mode === 'pyjs') {
      this.terminal.system(`Python ${run.python} ready in ${Math.round(performance.now() - t0)} ms · built-in interpreter`);
      this.terminal.system("This app blocks WebAssembly, so CrazyCodeEditor is using its own Python interpreter written in JavaScript. Everyday Python works, input() pauses properly and Stop is instant. See \"Help: About the built-in interpreter\" for what differs.");
    } else {
      const pk = this.pack?.index.requested?.length ? ` · packages: ${this.pack.index.requested.join(', ')}` : '';
      const mt = this.mode === 'main' ? ' · UI-thread mode' : '';
      this.terminal.system(`Python ${run.python.split(' ')[0]} ready in ${Math.round(performance.now() - t0)} ms · ${this.runWorker.blockingStdin ? 'blocking stdin' : 'replay stdin'}${pk}${mt}`);
      if (this.mode === 'main') {
        this.terminal.system(`This app forbids background workers, so programs run on the UI thread: the app pauses while a program runs, output appears when it finishes, and a ${MAIN_THREAD_TIME_LIMIT}-second watchdog stops runaway loops.`);
      }
    }
    this.repl.reset();
    this.repl.setEnabled(true);
  }

  // Some hosts only allow eval() during the paste itself, so stash the asm
  // script and let the next paste eval it (main.ts).
  private mainThreadCanStart(): boolean {
    const g = globalThis as any;
    if (typeof g._createPyodideModule === 'function' || this.env.evalAllowed) return true;
    this.cacheAsmForNextPaste();
    this.setStatus('no-runtime', 'Paste crazy.js again');
    this.terminal.system('Runtime saved. This app only lets scripts load during the paste itself, so paste crazy.js into the console once more to start Python.');
    this.dialogs.modal('One more paste', (body, foot, close) => {
      body.innerHTML = `<p>The runtime is saved in this app now. Its security policy only allows loading scripts while a paste is being evaluated, so Python cannot start from here.</p><p><b>Paste crazy.js into the console again</b> and Python will be ready. Your files are kept.</p>`;
      const ok = document.createElement('button');
      ok.className = 'btn primary';
      ok.textContent = 'OK';
      ok.onclick = close;
      foot.appendChild(ok);
    });
    return false;
  }

  private cacheAsmForNextPaste(): void {
    if (!this.pack) return;
    try {
      const text = new TextDecoder().decode(packFile(this.pack, 'pyodide.asm.js'));
      localStorage.setItem(`crazy-asm:${__VERSION__}`, text);
    } catch (e) {
      console.warn('[crazy] could not cache pyodide.asm.js', e);
    }
  }

  // interpreter information
  showInterpreterInfo(): void {
    const viaMeta = !!this.env.cspMeta;
    const isFile = location.protocol === 'file:';
    this.dialogs.modal(
      'About the built-in interpreter',
      (body, foot, close) => {
        body.className += ' helpdoc pyjsinfo';
        body.innerHTML = `
<p>This app's security policy forbids WebAssembly, so the real CPython build cannot load here. Instead the editor is running a Python interpreter written in JavaScript that ships inside <code>crazy.js</code>. No extra files, no downloads, no permissions.</p>
<h3>What works</h3>
<p>Numbers (with unlimited-size integers), strings and f-strings, lists, tuples, dicts, sets, slicing, comprehensions, loops, functions with defaults and <code>*args</code>/<code>**kwargs</code>, closures, lambdas, classes with inheritance, <code>super()</code>, properties and dunder methods, exceptions, generators, <code>with</code>, decorators, reading and writing files in your project, and importing your own modules.</p>
<h3>Modules included</h3>
<p>${BUILT_IN_MODULES.map((m) => `<span class="pk">${m}</span>`).join('')}</p>
<h3>What is missing</h3>
<p>NumPy, matplotlib and anything else built from C are not available, because those are the very WebAssembly parts this app blocks. Black formatting and the 1-line button also need full CPython. <code>async</code>/<code>await</code> and complex numbers are not supported. Long loops run slower than CPython would.</p>
<h3>If you want the full CPython instead</h3>
<p>${
          viaMeta
            ? 'This app sets its policy in a <code>&lt;meta&gt;</code> tag, which DevTools can remove: Sources → Overrides → pick a folder → then right-click the page document → <b>Override content</b>, delete the <code>&lt;meta http-equiv="Content-Security-Policy" …&gt;</code> line, save, reload and paste again.'
            : isFile
              ? 'This app injects its policy from its own process, which DevTools overrides cannot reach. The optional <code>attach.mjs</code> in the CrazyCodeEditor folder can clear it, but it needs Node.js installed, so the built-in interpreter is the self-contained option.'
              : 'DevTools → Network → right-click the page request → <b>Override headers</b> → set <code>content-security-policy</code> to something permissive, then reload and paste again.'
        }</p>`;
        const ok = document.createElement('button');
        ok.className = 'btn primary';
        ok.textContent = 'Got it';
        ok.onclick = close;
        foot.appendChild(ok);
      },
      { wide: true },
    );
  }

  private setStatus(s: PyStatus, text?: string): void {
    this.status = s;
    const suffix = this.mode === 'main' ? ' (UI thread)' : this.mode === 'pyjs' ? ' (built-in)' : '';
    const labels: Record<PyStatus, string> = { blocked: 'Python blocked by host', 'no-runtime': 'No runtime', starting: 'Starting Python…', ready: `Python ${this.runWorker?.python.split(' ')[0] || ''}${suffix}`, running: this.mode === 'main' ? 'Running (app paused)…' : 'Running…', waiting: 'Waiting for input', crashed: 'Python crashed' };
    if (this.st.python) {
      this.st.python.querySelector('.txt')!.textContent = text ?? labels[s];
      this.st.python.querySelector('.dot')!.classList.toggle('busy', s === 'starting' || s === 'running');
    }
    this.L.runBtn.disabled = s !== 'ready';
    this.L.stopBtn.disabled = !(s === 'running' || s === 'waiting');
    this.L.statusbar.classList.toggle('idle', s !== 'ready' && s !== 'running' && s !== 'waiting');
    this.repl?.setEnabled(s === 'ready');
  }

  // run / stop
  async run(path?: string): Promise<void> {
    path = path ?? this.ws.active ?? undefined;
    if (!path) return this.dialogs.toast('Open a Python file to run it.', 'warning');
    if (this.status === 'running' || this.status === 'waiting') return;
    if (this.status !== 'ready') return this.dialogs.toast('Python is not ready yet.', 'warning');
    if (!path.endsWith('.py')) return this.dialogs.toast(`${path} is not a Python file.`, 'warning');
    if (this.settings.saveBeforeRun) this.saveAll(false);
    this.L.showPanel('output');
    if (this.settings.clearOnRun) this.terminal.clear();
    this.syncRunAll();
    const seq = ++this.runSeq;
    const code = this.ws.content(path);
    const stdin: string[] = [];
    let suppress = 0;
    let suppressImages = 0;
    const seed = Math.floor(Math.random() * 2 ** 31);
    this.terminal.system(`▶ ${path}`);
    this.setStatus('running');
    const t0 = performance.now();
    let outcome: RunOutcome;
    for (;;) {
      outcome = await this.runWorker.run(code, path, stdin, suppress, suppressImages, seed);
      if (seq !== this.runSeq) return;
      if (!outcome.needInput) break;
      // replay mode: get the line, run again with it
      this.setStatus('waiting');
      const line = await this.terminal.readLine();
      if (seq !== this.runSeq) return;
      if (line === null) {
        this.terminal.system('■ interrupted');
        this.setStatus('ready');
        return;
      }
      stdin.push(line);
      suppress = outcome.needInput.emitted;
      suppressImages = outcome.needInput.images;
      this.setStatus('running');
    }
    const ms = Math.round(performance.now() - t0);
    if (outcome.stopped) return;
    this.terminal.system(outcome.ok ? `✓ finished in ${ms} ms` : `✗ exited with code ${outcome.exit} after ${ms} ms`);
    this.setStatus('ready');
  }

  private onBlockingInput(): void {
    // worker is parked in Atomics.wait until we answer
    this.setStatus('waiting');
    void this.terminal.readLine().then((line) => {
      this.runWorker.answerInput(line);
      if (line === null) this.stop();
      else this.setStatus('running');
    });
  }

  async stop(): Promise<void> {
    if (!this.pack && this.mode !== 'pyjs') return;
    this.runSeq++;
    this.terminal.cancelInput();
    this.runWorker.stop();
    this.terminal.system('■ stopped, restarting Python…');
    this.setStatus('starting', 'Restarting Python…');
    this.lspClient.ready = this.mode !== 'main';
    const info = await this.runWorker.start(this.pack);
    if (this.mode === 'main') {
      this.lspClient.ready = true;
      this.syncLspAll();
    }
    this.syncRunAll();
    this.repl.reset();
    this.setStatus('ready');
    this.terminal.system(`Python ${info.python.split(' ')[0]} ready`);
  }

  // workspace sync
  private syncRunAll(): void {
    if (this.runWorker.running) this.runWorker.syncFiles(this.ws.snapshot(), []);
  }

  private syncLspAll(): void {
    if (this.lspWorker.running) this.lspWorker.syncFiles(this.ws.snapshot(), []);
  }

  private queueLspSync(path: string, text: string): void {
    this.pendingLspSync.set(path, text);
    clearTimeout(this.lspSyncTimer);
    this.lspSyncTimer = window.setTimeout(() => {
      if (this.lspWorker.running) this.lspWorker.syncFiles(Object.fromEntries(this.pendingLspSync), []);
      this.pendingLspSync.clear();
    }, 600);
  }

  private onFilesChanged(files: Record<string, string>): void {
    // files the program wrote; don't clobber unsaved edits
    let n = 0;
    for (const [path, content] of Object.entries(files)) {
      if (this.ws.isDirty(path)) continue;
      if (this.ws.files.get(path) === content) continue;
      this.ws.write(path, content);
      if (path === this.ws.active && this.editor.text !== content) this.editor.setText(content);
      else this.editor.forget(path);
      n++;
    }
    if (n) this.dialogs.toast(`${n} file${n > 1 ? 's' : ''} written by your program`, 'info', 2500);
  }

  private onWorkspaceEvent(e: { type: string; changed?: string[]; deleted?: string[]; path?: string }): void {
    if (e.type === 'files') {
      this.tree.render();
      this.tabs.render();
      const changed: Record<string, string> = {};
      for (const p of e.changed ?? []) changed[p] = this.ws.content(p);
      const deleted = e.deleted ?? [];
      if (Object.keys(changed).length || deleted.length) {
        this.runWorker.syncFiles(changed, deleted);
        this.lspWorker.syncFiles(changed, deleted);
      }
      for (const d of deleted) {
        this.editor.forget(d);
        this.problems.remove(d);
      }
      this.updateTitle();
    } else if (e.type === 'tabs') {
      this.tabs.render();
      this.tree.render();
      this.openActive();
    } else if (e.type === 'dirty') {
      this.tabs.render();
      this.tree.render();
      this.updateTitle();
    }
  }

  // editor
  private buildEditor(): void {
    this.editor = new Editor(
      this.L.editorHost,
      this.lspClient,
      {
        run: () => void this.run(),
        save: () => this.save(),
        format: () => void this.format(),
        gotoDefinition: () => void this.gotoDefinition(),
      },
      {
        onChange: (path, text) => {
          this.ws.setDraft(path, text);
          this.queueLspSync(path, text);
        },
        onCursor: (line, col) => {
          if (this.st.pos) this.st.pos.textContent = `Ln ${line}, Col ${col}`;
        },
        onDiagnostics: (path, diags) => {
          this.problems.set(path, diags, (pos) => {
            const l = this.editor.view.state.doc.lineAt(pos);
            return { line: l.number, col: pos - l.from + 1 };
          });
          this.updateProblemBadge();
        },
      },
      this.settings,
      uiTheme(this.settings.theme),
    );
    this.editor.applySettings(this.settings, uiTheme(this.settings.theme));
  }

  private openActive(): void {
    const path = this.ws.active;
    if (!path) {
      this.editor.clear();
      this.L.editorEmpty.hidden = false;
      this.updateTitle();
      return;
    }
    if (this.editor.currentPath !== path || this.editor.text !== this.ws.content(path)) {
      if (this.editor.currentPath) this.ws.cursors.set(this.editor.currentPath, this.editor.cursorOffset);
      this.editor.open(path, this.ws.content(path), uiTheme(this.settings.theme), this.ws.cursors.get(path));
    }
    this.L.editorEmpty.hidden = true;
    this.updateTitle();
  }

  private updateTitle(): void {
    const p = this.ws.active;
    this.L.title.textContent = p ? `${p}${this.ws.isDirty(p) ? ' •' : ''}` : '';
  }

  save(path?: string): void {
    path = path ?? this.ws.active ?? undefined;
    if (!path) return;
    if (path === this.editor.currentPath && this.settings.formatOnSave && path.endsWith('.py')) {
      void this.format().then(() => this.ws.save(path!, this.editor.text));
      return;
    }
    this.ws.save(path, path === this.editor.currentPath ? this.editor.text : undefined);
  }

  saveAll(toast = true): void {
    const dirty = this.ws.dirtyFiles();
    for (const p of dirty) this.ws.save(p, p === this.editor.currentPath ? this.editor.text : undefined);
    if (toast && dirty.length) this.dialogs.toast(`Saved ${dirty.length} file${dirty.length > 1 ? 's' : ''}`, 'success', 1500);
  }

  async format(): Promise<void> {
    const path = this.editor.currentPath;
    if (!path || !path.endsWith('.py')) return;
    if (!this.lspClient.ready) return this.dialogs.toast('Formatter not ready yet.', 'warning');
    try {
      const r = await this.lspWorker.lsp<{ code?: string; error?: string }>('format', { code: this.editor.text, line_length: this.settings.lineLength });
      if (r.error) return this.dialogs.toast(r.error, 'error');
      if (r.code !== undefined && r.code !== this.editor.text) this.editor.replaceAll(r.code);
    } catch (e: any) {
      this.dialogs.toast(`Format failed: ${e.message}`, 'error');
    }
  }

  async gotoDefinition(): Promise<void> {
    const path = this.editor.currentPath;
    if (!path || !this.lspClient.ready) return;
    const { line, col } = this.editor.cursorLineCol;
    try {
      const defs = await this.lspWorker.lsp<Array<{ path: string | null; line: number | null; col: number | null; name: string }>>('goto', { code: this.editor.text, line, col, path });
      const d = defs.find((x) => x.path && x.line);
      if (!d) return this.dialogs.toast('No definition found.', 'info', 2000);
      const rel = d.path!.startsWith('/workspace/') ? d.path!.slice('/workspace/'.length) : null;
      if (!rel || !this.ws.files.has(rel)) return this.dialogs.toast(`Defined in ${d.path!.split('/').pop()} (library)`, 'info', 2500);
      this.openAt(rel, d.line!, (d.col ?? 0) + 1);
    } catch (e: any) {
      this.dialogs.toast(`Go to definition failed: ${e.message}`, 'error');
    }
  }

  // writes <name>_oneline.py
  async oneline(): Promise<void> {
    const path = this.ws.active;
    if (!path || !path.endsWith('.py')) return this.dialogs.toast('Open a Python file first.', 'warning');
    if (!this.lspClient.ready) return this.dialogs.toast('Python is not ready yet.', 'warning');
    const code = path === this.editor.currentPath ? this.editor.text : this.ws.content(path);
    try {
      const r = await this.lspWorker.lsp<{ code?: string; error?: string; lines?: number; chars?: number; fallbacks?: Array<[number, string, string]>; whole?: boolean }>('oneline', { code, path });
      if (r.error || !r.code) return this.dialogs.toast(r.error ?? 'Could not one-line this file.', 'error');
      const target = path.replace(/\.py$/, '_oneline.py');
      this.ws.write(target, r.code);
      this.editor.forget(target);
      this.ws.openFile(target);
      const fb = r.fallbacks ?? [];
      let msg = `${path}: ${r.lines} lines → 1 line, ${r.chars} characters.`;
      if (r.whole) msg += ' The rewrite did not compile, so the whole file is wrapped in exec().';
      else if (fb.length) msg += ` ${fb.length} statement${fb.length > 1 ? 's' : ''} used exec(): ${fb.slice(0, 3).map(([ln, kind, why]) => `${kind} at line ${ln} (${why})`).join(', ')}${fb.length > 3 ? ', …' : ''}.`;
      else msg += ' Every statement was rewritten as an expression, no exec() needed.';
      this.dialogs.toast(msg, r.whole ? 'warning' : 'success', 9000);
    } catch (e: any) {
      this.dialogs.toast(`One-line failed: ${e.message}`, 'error');
    }
  }

  openAt(path: string, line: number, col = 1): void {
    if (!this.ws.files.has(path)) return;
    this.ws.openFile(path);
    this.editor.gotoLine(line, col);
  }

  // sidebar
  private buildSidebar(): void {
    this.tree = new FileTree(
      this.ws,
      {
        open: (p) => this.ws.openFile(p),
        newFile: (dir) => void this.newFile(dir),
        newFolder: (dir) => void this.newFolder(dir),
        rename: (p) => void this.renamePath(p),
        delete: (p) => void this.deletePath(p),
        run: (p) => void this.run(p),
      },
      (x, y, items) => this.dialogs.contextMenu(x, y, items),
    );
    this.L.treeHost.appendChild(this.tree.el);
    const a = this.L.sidebarActions;
    const b1 = this.L.iconButton('newFile', 'New file (Ctrl+N)');
    b1.onclick = () => void this.newFile(this.activeDir());
    const b2 = this.L.iconButton('newFolder', 'New folder');
    b2.onclick = () => void this.newFolder(this.activeDir());
    const b3 = this.L.iconButton('import', 'Import files or a zip');
    b3.onclick = () => void this.importFiles();
    const b4 = this.L.iconButton('export', 'Export workspace as zip');
    b4.onclick = () => void this.exportZip();
    const b5 = this.L.iconButton('collapse', 'Collapse folders');
    b5.onclick = () => {
      this.ws.expanded.clear();
      this.tree.render();
    };
    a.append(b1, b2, b3, b4, b5);
    this.tabs = new TabBar(this.ws, { activate: (p) => this.ws.setActive(p), close: (p) => this.closeTab(p) });
    this.L.tabsHost.appendChild(this.tabs.el);
  }

  private activeDir(): string {
    const p = this.ws.active;
    return p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  }

  private validName(dir: string, isFolder = false) {
    return (v: string): string | null => {
      if (!v) return 'Enter a name';
      if (/[\\:*?"<>|]/.test(v) || v.startsWith('/') || v.includes('//') || v.split('/').some((s) => s === '.' || s === '..' || s === '')) return 'Invalid name';
      const full = dir ? `${dir}/${v}` : v;
      if (this.ws.exists(full)) return `${full} already exists`;
      if (!isFolder && !/\.[A-Za-z0-9]+$/.test(v)) return null;
      return null;
    };
  }

  async newFile(dir = ''): Promise<void> {
    const name = await this.dialogs.prompt('New file', { message: dir ? `In folder ${dir}/` : 'Use folder/name.py to create folders.', value: 'untitled.py', placeholder: 'name.py', ok: 'Create', validate: this.validName(dir), selectRange: [0, 8] });
    if (!name) return;
    const path = dir ? `${dir}/${name}` : name;
    this.ws.create(path, '');
    this.ws.openFile(path);
  }

  async newFolder(dir = ''): Promise<void> {
    const name = await this.dialogs.prompt('New folder', { message: dir ? `In folder ${dir}/` : '', placeholder: 'folder', ok: 'Create', validate: this.validName(dir, true) });
    if (!name) return;
    this.ws.createFolder(dir ? `${dir}/${name}` : name);
  }

  async renamePath(path: string): Promise<void> {
    const i = path.lastIndexOf('/');
    const dir = i === -1 ? '' : path.slice(0, i);
    const base = path.slice(i + 1);
    const dot = base.lastIndexOf('.');
    const name = await this.dialogs.prompt('Rename', { value: base, ok: 'Rename', validate: (v) => (v === base ? null : this.validName(dir)(v)), selectRange: [0, dot > 0 ? dot : base.length] });
    if (!name || name === base) return;
    const to = dir ? `${dir}/${name}` : name;
    const wasActive = this.ws.active === path;
    if (this.editor.currentPath === path) this.ws.setDraft(path, this.editor.text);
    this.ws.rename(path, to);
    this.editor.renamePath(path, to);
    this.problems.remove(path);
    if (wasActive) this.openActive();
  }

  async deletePath(path: string): Promise<void> {
    const isDir = !this.ws.files.has(path);
    const ok = await this.dialogs.confirm(`Delete ${isDir ? 'folder' : 'file'}`, `Delete ${path}${isDir ? ' and everything in it' : ''}? This cannot be undone.`, { ok: 'Delete', danger: true });
    if (!ok) return;
    this.ws.delete(path);
  }

  closeTab(path: string): void {
    if (this.editor.currentPath === path) this.ws.cursors.set(path, this.editor.cursorOffset);
    this.ws.closeFile(path);
  }

  async importFiles(): Promise<void> {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.py,.txt,.md,.json,.csv,.zip,.toml,.cfg,.ini,.yaml,.yml';
    input.style.display = 'none';
    document.documentElement.appendChild(input);
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      input.remove();
      let n = 0;
      for (const f of files) {
        if (f.name.endsWith('.zip')) {
          try {
            const entries = await readZip(await f.arrayBuffer());
            const dec = new TextDecoder();
            for (const e of entries) {
              if (e.name.includes('__MACOSX') || e.name.endsWith('/')) continue;
              this.ws.write(e.name.replace(/^\.?\//, ''), dec.decode(e.data));
              n++;
            }
          } catch (e: any) {
            this.dialogs.toast(`${f.name}: ${e.message}`, 'error');
          }
        } else {
          this.ws.write(f.name, await f.text());
          n++;
        }
      }
      this.dialogs.toast(`Imported ${n} file${n === 1 ? '' : 's'}`, 'success');
    };
    input.click();
  }

  async exportZip(): Promise<void> {
    this.saveAll(false);
    const enc = new TextEncoder();
    const data = writeZip(this.ws.sortedPaths().map((p) => ({ name: p, data: enc.encode(this.ws.files.get(p)!) })));
    const name = `workspace-${new Date().toISOString().slice(0, 10)}.zip`;
    const g = globalThis as any;
    if (typeof g.showSaveFilePicker === 'function') {
      try {
        const handle = await g.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }] });
        const w = await handle.createWritable();
        await w.write(data);
        await w.close();
        this.dialogs.toast('Workspace exported', 'success');
        return;
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(new Blob([data], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // panels
  private buildPanels(): void {
    this.terminal = new Terminal({
      onLink: (path, line) => this.openAt(path, line),
      onInterrupt: () => {
        if (this.status === 'running' || this.status === 'waiting') void this.stop();
      },
    });
    this.terminal.el.classList.add('js-output');
    this.L.panelViews.output.appendChild(this.terminal.el);
    this.repl = new Repl((line) => this.runWorker.repl(line).then((r) => ({ status: r.status, value: r.value, error: r.error })));
    this.repl.setEnabled(false);
    this.L.panelViews.repl.appendChild(this.repl.el);
    this.problems = new ProblemsView((path, line, col) => this.openAt(path, line, col));
    this.L.panelViews.problems.appendChild(this.problems.el);
    const clear = this.L.iconButton('clear', 'Clear output');
    clear.onclick = () => (this.L.activePanel === 'repl' ? this.repl.term.clear() : this.terminal.clear());
    const hide = this.L.iconButton('close', 'Hide panel (Ctrl+J)');
    hide.onclick = () => this.L.togglePanel();
    this.L.panelActions.append(clear, hide);
  }

  private updateProblemBadge(): void {
    const { errors, warnings } = this.problems.counts();
    const b = this.L.problemsBadge;
    b.hidden = errors + warnings === 0;
    b.textContent = String(errors + warnings);
    b.classList.toggle('warn', errors === 0);
    if (this.st.problems) this.st.problems.querySelector('.txt')!.textContent = `${errors} ${warnings}`;
  }

  // status bar
  private buildStatusbar(): void {
    const mk = (key: string, name: Parameters<typeof icon>[0] | null, text: string, opts: { btn?: () => void; right?: boolean; optional?: boolean; dot?: boolean } = {}) => {
      const el = document.createElement('div');
      el.className = 'st' + (opts.btn ? ' btn' : '') + (opts.right ? ' right' : '') + (opts.optional ? ' optional' : '');
      if (opts.dot) {
        const d = document.createElement('span');
        d.className = 'dot';
        el.appendChild(d);
      }
      if (name) el.appendChild(icon(name));
      const t = document.createElement('span');
      t.className = 'txt';
      t.textContent = text;
      el.appendChild(t);
      if (opts.btn) el.onclick = opts.btn;
      this.L.statusbar.appendChild(el);
      this.st[key] = el;
    };
    mk('python', null, 'Starting Python…', { dot: true, btn: () => (this.mode === 'pyjs' ? this.showInterpreterInfo() : this.L.showPanel('output')) });
    mk('problems', 'warning', '0 0', { btn: () => this.L.showPanel('problems'), optional: true });
    mk('stdin', null, this.mode === 'pyjs' || this.env.sharedArrayBuffer ? 'stdin: blocking' : 'stdin: replay', { optional: true });
    mk('pos', null, 'Ln 1, Col 1', { right: true, btn: () => this.gotoLinePrompt() });
    mk('spaces', null, `Spaces: ${this.settings.tabSize}`, { optional: true, btn: () => this.openSettings() });
    mk('theme', null, this.settings.theme, { optional: true, btn: () => this.pickTheme() });
    this.st.stdin.title = this.mode === 'pyjs' || this.env.sharedArrayBuffer ? 'input() pauses the program until you answer' : 'input() re-runs the program with your answers (no SharedArrayBuffer in this host)';
  }

  private async gotoLinePrompt(): Promise<void> {
    const v = await this.dialogs.prompt('Go to line', { placeholder: 'line[:column]', validate: (s) => (/^\d+(:\d+)?$/.test(s) ? null : 'Enter a line number') });
    if (!v) return;
    const [l, c] = v.split(':').map(Number);
    this.editor.gotoLine(l, c || 1);
  }

  // settings / themes
  private applyThemes(): void {
    const r = this.host.styleRoot;
    applyUiTheme(r, uiTheme(this.settings.theme));
    applyTerminalTheme(r, terminalTheme(this.settings.terminalTheme));
    r.style.setProperty('--editor-font-size', `${this.settings.fontSize}px`);
    r.style.setProperty('--term-font-size', `${this.settings.terminalFontSize}px`);
  }

  applySettings(s: Settings): void {
    this.settings = s;
    void saveSettings(s);
    this.applyThemes();
    this.editor.applySettings(s, uiTheme(s.theme));
    if (this.st.spaces) this.st.spaces.querySelector('.txt')!.textContent = `Spaces: ${s.tabSize}`;
    if (this.st.theme) this.st.theme.querySelector('.txt')!.textContent = s.theme;
  }

  openSettings(): void {
    openSettings(this.dialogs, this.settings, {
      change: (s) => this.applySettings(s),
      exportWorkspace: () => void this.exportZip(),
      importWorkspace: () => void this.importFiles(),
      resetWorkspace: () => void this.resetWorkspace(),
      forgetRuntime: () => void this.forgetRuntime(),
    });
  }

  private pickTheme(): void {
    this.palette.open(
      UI_THEMES.map((t) => ({ id: t.name, label: t.name, detail: t.dark ? 'dark' : 'light', run: () => this.applySettings({ ...this.settings, theme: t.name }) })),
      { placeholder: 'Editor theme' },
    );
  }

  private pickTerminalTheme(): void {
    this.palette.open(
      TERMINAL_THEMES.map((t) => ({ id: t.name, label: t.name, run: () => this.applySettings({ ...this.settings, terminalTheme: t.name }) })),
      { placeholder: 'Terminal theme' },
    );
  }

  private async resetWorkspace(): Promise<void> {
    const ok = await this.dialogs.confirm('Reset workspace', 'Delete every file in this workspace and start fresh? Export a zip first if you want to keep them.', { ok: 'Delete everything', danger: true });
    if (!ok) return;
    for (const p of this.ws.sortedPaths()) this.ws.delete(p);
    for (const f of [...this.ws.folders]) this.ws.delete(f);
    this.ws.create('main.py', 'print("Hello, world!")\n');
    this.ws.openFile('main.py');
  }

  private async forgetRuntime(): Promise<void> {
    await kvDelete('runtime-pack').catch(() => {});
    this.dialogs.toast('Cached runtime removed. You will be asked for crazy-runtime.pack next time.', 'info', 5000);
  }

  private async loadRuntimeNow(): Promise<void> {
    if (this.status === 'blocked') return this.dialogs.toast('This host blocks Python (strict CSP).', 'error');
    if (this.pack) return this.dialogs.toast('Runtime already loaded.', 'info');
    this.pack = await this.askForPack();
    await this.startWorkers();
  }

  // commands & keys
  private registerCommands(): void {
    const add = (id: string, label: string, run: () => void, keys?: string, when?: () => boolean) => this.commands.set(id, { id, label, run, keys, when });
    add('run', 'Python: Run current file', () => void this.run(), 'F5');
    add('stop', 'Python: Stop / restart interpreter', () => void this.stop(), undefined, () => this.status !== 'blocked' && !!this.pack);
    add('repl', 'Python: Focus REPL', () => (this.L.showPanel('repl'), this.repl.focus()), 'Ctrl+`');
    add('loadRuntime', 'Python: Load runtime pack…', () => void this.loadRuntimeNow());
    add('forgetRuntime', 'Python: Forget cached runtime pack', () => void this.forgetRuntime());
    add('save', 'File: Save', () => this.save(), 'Ctrl+S');
    add('saveAll', 'File: Save all', () => this.saveAll(), 'Ctrl+Shift+S');
    add('newFile', 'File: New file', () => void this.newFile(this.activeDir()), 'Ctrl+N');
    add('newFolder', 'File: New folder', () => void this.newFolder(this.activeDir()));
    add('rename', 'File: Rename current file', () => this.ws.active && void this.renamePath(this.ws.active), 'F2');
    add('deleteFile', 'File: Delete current file', () => this.ws.active && void this.deletePath(this.ws.active));
    add('closeTab', 'File: Close tab', () => this.ws.active && this.closeTab(this.ws.active), 'Ctrl+Alt+W');
    add('nextTab', 'View: Next tab', () => this.cycleTab(1), 'Ctrl+Tab');
    add('prevTab', 'View: Previous tab', () => this.cycleTab(-1), 'Ctrl+Shift+Tab');
    add('quickOpen', 'Go to file…', () => this.quickOpen(), 'Ctrl+P');
    add('gotoLine', 'Go to line…', () => void this.gotoLinePrompt(), 'Ctrl+G');
    add('gotoDef', 'Go to definition', () => void this.gotoDefinition(), 'F12');
    add('format', 'Format document (Black)', () => void this.format(), 'Shift+Alt+F');
    add('oneline', 'Fun: Compile current file into one line', () => void this.oneline());
    add('import', 'Workspace: Import files or zip…', () => void this.importFiles());
    add('export', 'Workspace: Export as zip…', () => void this.exportZip());
    add('resetWs', 'Workspace: Reset (delete all files)', () => void this.resetWorkspace());
    add('sidebar', 'View: Toggle sidebar', () => this.L.toggleSidebar(), 'Ctrl+B');
    add('panel', 'View: Toggle bottom panel', () => this.L.togglePanel(), 'Ctrl+J');
    add('output', 'View: Show output', () => this.L.showPanel('output'));
    add('problems', 'View: Show problems', () => this.L.showPanel('problems'), 'Ctrl+Shift+M');
    add('clearOutput', 'View: Clear output', () => this.terminal.clear());
    add('theme', 'Preferences: Editor theme…', () => this.pickTheme(), 'Ctrl+K Ctrl+T');
    add('termTheme', 'Preferences: Terminal theme…', () => this.pickTerminalTheme());
    add('settings', 'Preferences: Settings', () => this.openSettings(), 'Ctrl+,');
    add('fontUp', 'Preferences: Increase font size', () => this.applySettings({ ...this.settings, fontSize: Math.min(32, this.settings.fontSize + 1) }));
    add('fontDown', 'Preferences: Decrease font size', () => this.applySettings({ ...this.settings, fontSize: Math.max(9, this.settings.fontSize - 1) }));
    add('wrap', 'Preferences: Toggle word wrap', () => this.applySettings({ ...this.settings, wordWrap: !this.settings.wordWrap }), 'Alt+Z');
    add('palette', 'Show all commands', () => this.openPalette(), 'Ctrl+Shift+P');
    add('welcome', 'Help: Welcome page', () => void this.showWelcome());
    add('pyjsinfo', 'Help: About the built-in interpreter', () => this.showInterpreterInfo(), undefined, () => this.mode === 'pyjs');
    add('exit', 'CrazyCodeEditor: Close editor (return to host app)', () => void this.exit());
  }

  private cycleTab(dir: number): void {
    const open = this.ws.open;
    if (!open.length || !this.ws.active) return;
    const i = open.indexOf(this.ws.active);
    this.ws.setActive(open[(i + dir + open.length) % open.length]);
  }

  openPalette(): void {
    const items: PaletteItem[] = [...this.commands.values()].filter((c) => !c.when || c.when()).map((c) => ({ id: c.id, label: c.label, keys: c.keys, run: c.run }));
    this.palette.open(items, { placeholder: 'Type a command' });
  }

  quickOpen(): void {
    const items: PaletteItem[] = this.ws.sortedPaths().map((p) => ({ id: p, label: p.slice(p.lastIndexOf('/') + 1), detail: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : undefined, run: () => this.ws.openFile(p) }));
    this.palette.open(items, { placeholder: 'Go to file' });
  }

  private async exit(): Promise<void> {
    const ok = await this.dialogs.confirm('Close CrazyCodeEditor', 'Your files stay saved in this app. Paste crazy.js again to come back.', { ok: 'Close' });
    if (!ok) return;
    this.saveAll(false);
    await this.ws.persist();
    this.runWorker.stop();
    this.lspWorker.stop();
    this.host.unmount();
  }

  private chord: string | null = null;

  private bindKeys(): void {
    this.L.app.addEventListener(
      'keydown',
      (e) => {
        const overlay = this.dialogs.isOpen || this.palette.isOpen;
        if (e.key === 'Escape' && this.palette.isOpen) {
          this.palette.close();
          return;
        }
        if (overlay) return;
        const combo = comboOf(e);
        if (this.chord) {
          const full = `${this.chord} ${combo}`;
          this.chord = null;
          const cmd = [...this.commands.values()].find((c) => c.keys === full);
          if (cmd) {
            e.preventDefault();
            e.stopPropagation();
            cmd.run();
          }
          return;
        }
        if (combo === 'Ctrl+K') {
          this.chord = 'Ctrl+K';
          e.preventDefault();
          e.stopPropagation();
          setTimeout(() => (this.chord = null), 1500);
          return;
        }
        // Editor-local keys are handled by CodeMirror when it has focus.
        const inEditor = this.editor.view.hasFocus;
        const editorOwned = new Set(['F5', 'Ctrl+Enter', 'Ctrl+S', 'Shift+Alt+F', 'F12']);
        if (inEditor && editorOwned.has(combo)) return;
        const cmd = [...this.commands.values()].find((c) => c.keys === combo) ?? (combo === 'Ctrl+Enter' ? this.commands.get('run') : undefined);
        if (cmd && (!cmd.when || cmd.when())) {
          e.preventDefault();
          e.stopPropagation();
          cmd.run();
        }
      },
      { capture: true },
    );
  }

  // test hooks
  private exposeTestApi(): void {
    (globalThis as any).__crazyApp = {
      version: __VERSION__,
      status: () => this.status,
      setText: (t: string) => this.editor.setText(t),
      getText: () => this.editor.text,
      run: () => this.run(),
      stop: () => this.stop(),
      terminalText: () => this.terminal.text,
      waitingForInput: () => this.terminal.waitingForInput,
      answer: (line: string) => {
        const input = this.terminal.el.querySelector('input.term-input') as HTMLInputElement | null;
        if (!input) return false;
        input.value = line;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      },
      lsp: (method: string, params: Record<string, unknown>) => this.lspWorker.lsp(method, params),
      oneline: () => this.oneline(),
      dismissWelcome: () => {
        (this.L.app.querySelector('.welcome')?.closest('.card')?.querySelector('.btn.primary') as HTMLButtonElement | null)?.click();
      },
      welcomeOpen: () => !!this.L.app.querySelector('.welcome'),
      images: () => this.terminal.el.querySelectorAll('img.term-img').length,
      packages: () => this.pack?.index.requested ?? [],
      mode: () => this.mode,
      welcomeDone: () => Promise.race([this.welcomeDone.then(() => 'resolved'), new Promise((r) => setTimeout(() => r('pending'), 1500))]),
      kv: (k: string) => Promise.race([kvGet(k).then((v) => 'value=' + JSON.stringify(v)), new Promise((r) => setTimeout(() => r('pending'), 1500))]),
      interpreterInfoOpen: () => !!this.L.app.querySelector('.pyjsinfo'),
      closeDialogs: () => this.L.app.querySelectorAll('.overlay .card .btn.primary').forEach((b) => (b as HTMLButtonElement).click()),
      lspReady: () => this.lspClient.ready,
      repl: (line: string) => this.runWorker.repl(line),
      command: (id: string) => this.commands.get(id)?.run(),
      workspace: () => this.ws,
      settings: () => this.settings,
      applySettings: (s: Partial<Settings>) => this.applySettings({ ...this.settings, ...s }),
      openFile: (p: string) => this.ws.openFile(p),
      createFile: (p: string, c: string) => this.ws.create(p, c),
      writeFile: (p: string, c: string) => this.ws.write(p, c),
      deleteFile: (p: string) => this.ws.exists(p) && this.ws.delete(p),
      problems: () => this.problems.counts(),
    };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k === '`' || k === '~') k = '`';
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}
