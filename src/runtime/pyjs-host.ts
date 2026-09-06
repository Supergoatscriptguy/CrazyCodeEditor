// PythonHost backed by the JS interpreter. No pack, no workers.
import { PyJsRuntime, SUPPORTED_MODULES } from '../pyjs';
import type { Pack } from './pack';
import type { BridgeEvents, PythonHost, RunOutcome } from './bridge';
import type { FromWorker, WorkerRole } from './protocol';

export class PyJsHost implements PythonHost {
  readonly role: WorkerRole = 'both';
  readonly mainThread = true;
  /** input() genuinely suspends the program here, so no replay is needed. */
  readonly blockingStdin = true;
  python = '';
  private runtime: PyJsRuntime | null = null;
  private replBuffer = '';

  constructor(private events: BridgeEvents & { requestInput?: (prompt: string) => Promise<string | null> }) {}

  get running(): boolean {
    return this.runtime !== null;
  }

  get modules(): string[] {
    return SUPPORTED_MODULES;
  }

  start(_pack: Pack | null): Promise<{ python: string; loadMs: number }> {
    const t0 = performance.now();
    this.runtime = new PyJsRuntime({
      write: (text, stream) => this.events.out?.(stream, text),
      requestInput: async (prompt) => {
        // echo the prompt here; waitInput is the SAB path and would race
        if (prompt) this.events.out?.('stdout', prompt);
        return (await this.events.requestInput?.(prompt)) ?? null;
      },
      yieldToUi: () => new Promise((r) => setTimeout(r, 0)),
    });
    this.python = '3.12 (built-in)';
    return Promise.resolve({ python: this.python, loadMs: Math.round(performance.now() - t0) });
  }

  stop(): void {
    this.runtime?.stop();
    this.runtime = null;
    this.replBuffer = '';
  }

  syncFiles(files: Record<string, string>, deleted: string[] = []): void {
    this.runtime?.setFiles(files, deleted);
  }

  async run(code: string, filename: string): Promise<RunOutcome> {
    const rt = this.runtime;
    if (!rt) return { ok: false, exit: 1, ms: 0 };
    rt.reset();
    const t0 = performance.now();
    const result = await rt.run(code, filename);
    const changed = rt.takeChangedFiles();
    if (Object.keys(changed).length) this.events.filesChanged?.(changed);
    return { ok: result.ok, exit: result.exit, ms: Math.round(performance.now() - t0), stopped: result.exit === 130 };
  }

  async repl(line: string): Promise<Extract<FromWorker, { type: 'replResult' }>> {
    const rt = this.runtime;
    if (!rt) return { type: 'replResult', id: 0, status: 'complete', error: 'Python is not running' };
    const r = await rt.repl(line, this.replBuffer);
    if (r.status === 'incomplete') {
      this.replBuffer = this.replBuffer ? this.replBuffer + '\n' + line : line;
      return { type: 'replResult', id: 0, status: 'incomplete' };
    }
    this.replBuffer = '';
    const changed = rt.takeChangedFiles();
    if (Object.keys(changed).length) this.events.filesChanged?.(changed);
    return { type: 'replResult', id: 0, status: r.status, value: r.value, error: r.error };
  }

  async lsp<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const rt = this.runtime;
    if (!rt) throw new Error('Python is not running');
    const code = String(params.code ?? '');
    switch (method) {
      case 'complete':
        return rt.complete(code, Number(params.line ?? 1), Number(params.col ?? 0)) as unknown as T;
      case 'detail': {
        const before = (code.split(/\r?\n/)[Number(params.line ?? 1) - 1] ?? '').slice(0, Number(params.col ?? 0));
        const dotted = /([A-Za-z_][\w.]*)\.\w*$/.exec(before);
        return rt.detail(String(params.name ?? ''), dotted ? dotted[1] : null) as unknown as T;
      }
      case 'lint':
        return rt.lint(code) as unknown as T;
      case 'hover':
        return null as unknown as T;
      case 'goto':
        return [] as unknown as T;
      case 'format':
        return { error: 'Black is not bundled with the built-in interpreter. Full CPython is needed for formatting.' } as unknown as T;
      case 'oneline':
        return { error: 'The one-liner needs full CPython (it uses the ast module).' } as unknown as T;
    }
    throw new Error(`unsupported request: ${method}`);
  }

  answerInput(_line: string | null): void {
    // Input arrives through the requestInput callback instead.
  }
}
