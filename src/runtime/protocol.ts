// Message types shared by the main thread and the workers.

export type WorkerRole = 'run' | 'lsp' | 'both';

export type ToWorker =
  | {
      type: 'init';
      role: WorkerRole;
      buffer: ArrayBuffer;
      base: number;
      files: Record<string, [number, number]>;
      stdinBuffer: SharedArrayBuffer | null;
    }
  | { type: 'syncFiles'; files: Record<string, string>; deleted: string[] }
  | { type: 'run'; id: number; code: string; filename: string; stdin: string[]; suppress: number; suppressImages: number; seed: number }
  | { type: 'repl'; id: number; line: string }
  | { type: 'lsp'; id: number; method: string; params: Record<string, unknown> };

export type FromWorker =
  | { type: 'log'; text: string }
  | { type: 'ready'; python: string; loadMs: number }
  | { type: 'out'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'image'; png: ArrayBuffer }
  | { type: 'needInput'; id: number; prompt: string; emitted: number; images: number }
  | { type: 'waitInput'; prompt: string }
  | { type: 'done'; id: number; ok: boolean; exit: number; ms: number }
  | { type: 'replResult'; id: number; status: 'incomplete' | 'complete' | 'syntax-error'; value?: string; error?: string }
  | { type: 'lspResult'; id: number; result?: unknown; error?: string }
  | { type: 'filesChanged'; files: Record<string, string> }
  | { type: 'fatal'; message: string };

// SharedArrayBuffer stdin layout (only used when SAB is available):
//   Int32[0] state: 0 = waiting, 1 = line ready, 2 = eof
//   Int32[1] byte length of the line
//   bytes 8.. utf-8 line data
export const STDIN_SAB_SIZE = 8 + 65536;
