// Worker entry. pyodide.js is prepended at build time.
import { createRuntime } from './core';
import type { ToWorker } from './protocol';

declare function importScripts(...urls: string[]): void;

const runtime = createRuntime({
  post: (m, transfer) => (self as any).postMessage(m, transfer ?? []),
  evalScript: (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    importScripts(url);
    URL.revokeObjectURL(url);
  },
  mainThread: false,
});

self.onmessage = (ev: MessageEvent<ToWorker>) => void runtime.handle(ev.data);
