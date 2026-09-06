import pyodideJs from 'virtual:pyodide-js';
import { probeEnvironment } from './boot/probe';
import { mount } from './boot/mount';
import { App } from './app/app';

// Console-evaluated code is exempt from CSP only while the evaluation runs,
// so anything that needs eval() happens here, before the first await.
const g = globalThis as any;
// no wasm means no Pyodide, so skip the setup (and the console errors)
let wasmAllowed = false;
try {
  new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  wasmAllowed = true;
} catch {
  console.info('[crazy] this app blocks WebAssembly; using the built-in Python interpreter');
}
if (wasmAllowed) {
  try {
    if (typeof g.loadPyodide !== 'function') (0, eval)(pyodideJs);
  } catch (e) {
    console.warn('[crazy] could not evaluate pyodide.js', e);
  }
  try {
    const asm = localStorage.getItem(`crazy-asm:${__VERSION__}`);
    if (asm && typeof g._createPyodideModule !== 'function') {
      (0, eval)(asm);
      g.__crazyAsmFromCache = true;
    }
  } catch (e) {
    console.warn('[crazy] cached pyodide.asm.js unusable', e);
  }
}

async function boot(): Promise<void> {
  const host = mount();
  const env = await probeEnvironment();
  console.log(`[crazy] v${__VERSION__} (pyodide ${__PYODIDE_VERSION__}) env=${JSON.stringify(env)}`);
  const app = new App(host, env);
  await app.start();
}

boot().catch((e) => {
  console.error('[crazy] boot failed', e);
});
