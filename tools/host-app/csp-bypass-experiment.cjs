// file:// host with CSP injected via onHeadersReceived and no meta tag: what
// can still clear it? Tries Fetch header stripping and Page.setBypassCSP.
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'";

const PROBE = `new Promise(r => setTimeout(async () => {
  const out = {};
  try { await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); out.wasm = 'ok'; } catch (e) { out.wasm = 'blocked'; }
  try { const u = URL.createObjectURL(new Blob(['self.postMessage(1)'], {type:'text/javascript'})); await new Promise((res, rej) => { const w = new Worker(u); w.onmessage = () => { w.terminate(); res(); }; w.onerror = () => rej(); setTimeout(rej, 1500); }); out.worker = 'ok'; } catch (e) { out.worker = 'blocked'; }
  try { new Function('1'); out.eval = 'ok'; } catch (e) { out.eval = 'blocked'; }
  out.metas = document.querySelectorAll('meta[http-equiv]').length;
  r(JSON.stringify(out));
}, 0))`;

const probe = (win) => win.webContents.executeJavaScript(PROBE);

app.whenReady().then(async () => {
  // the usual Electron CSP recipe
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });

  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const page = path.join(__dirname, 'index.html'); // no meta CSP in this file
  await win.loadFile(page);
  console.log('1. file:// + header CSP, no meta (matches the user\'s app) ->', await probe(win));

  const dbg = win.webContents.debugger;
  dbg.attach('1.3');

  // 2. Can the Fetch domain even see / rewrite a file:// document response?
  let sawFileRequest = false;
  dbg.on('message', async (_e, method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    sawFileRequest = true;
    const headers = (params.responseHeaders ?? []).filter((h) => !/^content-security-policy/i.test(h.name));
    try {
      const body = await dbg.sendCommand('Fetch.getResponseBody', { requestId: params.requestId });
      await dbg.sendCommand('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200, responseHeaders: headers, body: body.body });
    } catch (err) {
      await dbg.sendCommand('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    }
  });
  await dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
  await win.loadFile(page);
  console.log('2. same, with Fetch header stripping                        ->', await probe(win), `(intercepted file:// request: ${sawFileRequest})`);
  await dbg.sendCommand('Fetch.disable');

  // 3. Page.setBypassCSP - the flag extensions use. Test before and after reload.
  await dbg.sendCommand('Page.enable');
  await dbg.sendCommand('Page.setBypassCSP', { enabled: true });
  console.log('3. Page.setBypassCSP(true), no reload                       ->', await probe(win));
  await win.loadFile(page);
  console.log('4. Page.setBypassCSP(true), after reload                    ->', await probe(win));

  // 5. Does it survive a navigation to a different document, and can we auto-inject?
  await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: 'globalThis.__injectedEarly = true;' });
  await win.loadFile(page);
  const injected = await win.webContents.executeJavaScript('!!globalThis.__injectedEarly');
  console.log('5. addScriptToEvaluateOnNewDocument works                   ->', injected);

  // 6. Turning it back off must restore enforcement (sanity check).
  await dbg.sendCommand('Page.setBypassCSP', { enabled: false });
  await win.loadFile(page);
  console.log('6. setBypassCSP(false) again                                ->', await probe(win));

  dbg.detach();
  app.exit(0);
});
