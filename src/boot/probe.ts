// What the host allows. Probes run from a timer so the console's CSP
// exemption doesn't hide the answer.

export interface Environment {
  electron: string | null;
  chrome: string | null;
  node: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
  indexedDB: boolean;
  blobWorker: boolean;
  wasm: boolean;
  evalAllowed: boolean;
  filePicker: boolean;
  cspMeta: string | null;
}

function ua(re: RegExp): string | null {
  const m = navigator.userAgent.match(re);
  return m ? m[1] : null;
}

function deferred<T>(fn: () => Promise<T> | T): Promise<T> {
  // Runs outside the console evaluation's call stack.
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        Promise.resolve(fn()).then(resolve, reject);
      } catch (e) {
        reject(e);
      }
    }, 0);
  });
}

async function probeBlobWorker(): Promise<boolean> {
  return deferred(
    () =>
      new Promise<boolean>((resolve) => {
        let url: string | null = null;
        try {
          url = URL.createObjectURL(new Blob(['self.postMessage(1)'], { type: 'text/javascript' }));
          const w = new Worker(url);
          const done = (ok: boolean) => {
            w.terminate();
            if (url) URL.revokeObjectURL(url);
            resolve(ok);
          };
          w.onmessage = () => done(true);
          w.onerror = () => done(false);
          setTimeout(() => done(false), 2000);
        } catch {
          resolve(false);
        }
      }),
  );
}

async function probeWasm(): Promise<boolean> {
  // Smallest valid wasm module: magic + version.
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  return deferred(async () => {
    try {
      await WebAssembly.compile(bytes);
      return true;
    } catch {
      return false;
    }
  });
}

async function probeEval(): Promise<boolean> {
  return deferred(() => {
    try {
      return new Function('return 1')() === 1;
    } catch {
      return false;
    }
  });
}

function probeNode(): boolean {
  try {
    const g = globalThis as any;
    return typeof g.require === 'function' && !!g.process?.versions?.electron;
  } catch {
    return false;
  }
}

export async function probeEnvironment(): Promise<Environment> {
  // once wasm is refused the rest don't matter, and each failed probe
  // logs a CSP error in the host console
  const wasm = await probeWasm();
  const [blobWorker, evalAllowed] = wasm ? await Promise.all([probeBlobWorker(), probeEval()]) : [false, false];
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
  return {
    electron: ua(/Electron\/([\d.]+)/),
    chrome: ua(/Chrome\/([\d.]+)/),
    node: probeNode(),
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: !!(globalThis as any).crossOriginIsolated,
    indexedDB: typeof indexedDB !== 'undefined',
    blobWorker,
    wasm,
    evalAllowed,
    filePicker: typeof (globalThis as any).showOpenFilePicker === 'function',
    cspMeta: meta ? meta.getAttribute('content') : null,
  };
}
