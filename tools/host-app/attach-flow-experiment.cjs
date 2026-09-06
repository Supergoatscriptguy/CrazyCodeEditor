// End-to-end test of the attach.mjs flow via the in-process debugger.
// Host mimics a file:// app with a header-injected CSP and no meta tag.
const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'";
const dist = path.join(__dirname, '../../dist');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });

  const win = new BrowserWindow({ width: 1100, height: 750, show: false, paintWhenInitiallyHidden: true, webPreferences: { contextIsolation: true, sandbox: true } });
  const page = path.join(__dirname, 'index.html');
  await win.loadFile(page);
  const js = (s) => win.webContents.executeJavaScript(s);
  const fail = (m) => {
    console.error('FAILED: ' + m);
    app.exit(1);
  };

  // serve the pack over loopback like attach.mjs does
  const packBytes = fs.readFileSync(path.join(dist, 'crazy-runtime.pack'));
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(packBytes);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const packUrl = `http://127.0.0.1:${server.address().port}/crazy-runtime.pack`;

  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Page.enable');
  await dbg.sendCommand('Page.setBypassCSP', { enabled: true });
  await win.loadFile(page);
  await sleep(300);

  const allowed = await js(`WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => true, () => false)`);
  console.log('wasm available after clearing the policy :', allowed);
  if (!allowed) return fail('wasm still blocked');

  await js(`globalThis.__CRAZY_DEV_PACK_URL__ = ${JSON.stringify(packUrl)}; 0`);
  await js(fs.readFileSync(path.join(dist, 'crazy.js'), 'utf8'));

  const deadline = Date.now() + 120000;
  let status = 'loading';
  while (Date.now() < deadline) {
    status = await js(`globalThis.__crazyApp ? __crazyApp.status() : 'loading'`).catch(() => 'loading');
    if (status === 'ready' || status === 'blocked') break;
    await sleep(400);
  }
  const mode = await js(`globalThis.__crazyApp ? __crazyApp.mode() : '?'`).catch(() => '?');
  console.log('editor status                           :', status, `(${mode} mode)`);
  console.log('pack fetched over loopback http          :', await js(`!!globalThis.__crazyApp`));
  if (status !== 'ready') return fail('editor did not become ready');

  // run something, including a bundled package
  await js(`__crazyApp.dismissWelcome?.(); 0`).catch(() => {});
  await js(`__crazyApp.setText('import numpy as np\\nprint("sum", int(np.arange(5).sum()))\\n'); 0`);
  await js(`__crazyApp.run(); 0`);
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const t = await js(`__crazyApp.terminalText()`);
    if (t.includes('sum 10')) {
      console.log('python program output                   : sum 10');
      console.log('PASS');
      server.close();
      dbg.detach();
      return app.exit(0);
    }
    if (t.includes('exited with code')) return fail('program errored:\n' + t.slice(-500));
    await sleep(500);
  }
  fail('program did not finish');
});
