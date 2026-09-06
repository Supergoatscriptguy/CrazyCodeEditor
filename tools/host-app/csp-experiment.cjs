// What can a DevTools console evaluation do on a strict-CSP page?
// node tools/host-app/run-experiment.mjs csp-experiment.cjs
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(__dirname, 'index-csp.html'));
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Runtime.enable');
  const evalIn = async (expression, opts = {}) => {
    const r = await dbg.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true, ...opts });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0];
    return r.result.value;
  };
  const tests = {
    'sync new WebAssembly.Module during eval': `(() => { try { globalThis.__m = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])); return 'ok'; } catch (e) { return 'fail: ' + e.message; } })()`,
    'async WebAssembly.compile started during eval': `WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => 'ok', e => 'fail: ' + e.message)`,
    'sync eval / new Function during eval': `(() => { try { return new Function('return "ok"')(); } catch (e) { return 'fail: ' + e.message; } })()`,
    'deferred (setTimeout) WebAssembly.instantiate(precompiled module)': `new Promise(r => setTimeout(() => { try { WebAssembly.instantiate(globalThis.__m, {}).then(() => r('ok'), e => r('fail: ' + e.message)); } catch (e) { r('throw: ' + e.message); } }, 0))`,
    'deferred (setTimeout) new WebAssembly.Module': `new Promise(r => setTimeout(() => { try { new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])); r('ok'); } catch (e) { r('fail: ' + e.message); } }, 0))`,
    'deferred (setTimeout) new Function': `new Promise(r => setTimeout(() => { try { r(new Function('return "ok"')()); } catch (e) { r('fail: ' + e.message); } }, 0))`,
    'deferred (promise .then) new Function': `Promise.resolve().then(() => { try { return new Function('return "ok"')(); } catch (e) { return 'fail: ' + e.message; } })`,
    'sync blob Worker during eval': `(() => { try { const u = URL.createObjectURL(new Blob(['self.postMessage(1)'], {type:'text/javascript'})); const w = new Worker(u); w.terminate(); return 'ok (constructed)'; } catch (e) { return 'fail: ' + e.message; } })()`,
    'sync blob <script> during eval': `new Promise(r => { const s = document.createElement('script'); s.onload = () => r('ok'); s.onerror = () => r('fail: blocked'); s.src = URL.createObjectURL(new Blob(['globalThis.__blobScriptRan = 1'], {type:'text/javascript'})); document.head.appendChild(s); setTimeout(() => r('timeout'), 1500); })`,
    'about:blank iframe eval (deferred)': `new Promise(r => { const f = document.createElement('iframe'); document.body.appendChild(f); setTimeout(() => { try { r(f.contentWindow.eval('"ok"')); } catch (e) { r('fail: ' + e.message); } }, 0); })`,
    'localStorage quota probe (chars)': `(() => { try { const k='__q'; let n=0; const chunk='x'.repeat(1<<20); localStorage.removeItem(k); let s=''; for (let i=0;i<12;i++){ try { s+=chunk; localStorage.setItem(k, s); n=s.length; } catch(e){ break; } } localStorage.removeItem(k); return n + ' chars (' + (n/1048576).toFixed(1) + ' M)'; } catch (e) { return 'fail: ' + e.message; } })()`,
  };
  for (const [name, expr] of Object.entries(tests)) {
    let v;
    try {
      v = await evalIn(expr);
    } catch (e) {
      v = 'ERR: ' + e.message;
    }
    console.log(`${name.padEnd(70)} -> ${v}`);
  }
  app.exit(0);
});
