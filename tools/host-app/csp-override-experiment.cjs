// Does rewriting the CSP over the DevTools protocol (what Local Overrides does)
// unblock wasm and workers? http host with a header, file:// host with a meta tag.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');

const PROBE = `new Promise(r => setTimeout(async () => {
  const out = {};
  try { await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); out.wasm = 'ok'; } catch (e) { out.wasm = 'blocked'; }
  try { const u = URL.createObjectURL(new Blob(['self.postMessage(1)'], {type:'text/javascript'})); await new Promise((res, rej) => { const w = new Worker(u); w.onmessage = () => { w.terminate(); res(); }; w.onerror = () => rej(); setTimeout(rej, 1500); }); out.worker = 'ok'; } catch (e) { out.worker = 'blocked'; }
  try { new Function('1'); out.eval = 'ok'; } catch (e) { out.eval = 'blocked'; }
  r(JSON.stringify(out));
}, 0))`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>csp http host</title></head><body>http host with CSP header</body></html>`;

async function probe(win) {
  return win.webContents.executeJavaScript(PROBE);
}

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self'");
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/app`;

  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL(url);
  console.log('http host, header CSP, before override      ->', await probe(win));

  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  dbg.on('message', async (_e, method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const headers = (params.responseHeaders ?? []).filter((h) => !/^content-security-policy/i.test(h.name));
    if (params.responseStatusCode) {
      const body = await dbg.sendCommand('Fetch.getResponseBody', { requestId: params.requestId }).catch(() => null);
      let b64 = body?.body ?? '';
      if (body && !body.base64Encoded) {
        // meta-tag CSP: strip it from the document itself
        b64 = Buffer.from(body.body.replace(/<meta[^>]+content-security-policy[^>]*>/gi, '')).toString('base64');
      } else if (body && body.base64Encoded) {
        b64 = Buffer.from(Buffer.from(body.body, 'base64').toString('utf8').replace(/<meta[^>]+content-security-policy[^>]*>/gi, '')).toString('base64');
      }
      await dbg.sendCommand('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: params.responseStatusCode, responseHeaders: headers, body: b64 });
    } else {
      await dbg.sendCommand('Fetch.continueRequest', { requestId: params.requestId });
    }
  });
  await dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response', resourceType: 'Document' }] });
  await win.loadURL(url);
  console.log('http host, header CSP, after header override  ->', await probe(win));

  // file:// host with meta CSP
  await win.loadFile(path.join(__dirname, 'index-csp.html'));
  console.log('file host, meta CSP, with content override     ->', await probe(win));
  dbg.detach();
  await win.loadFile(path.join(__dirname, 'index-csp.html'));
  console.log('file host, meta CSP, no override               ->', await probe(win));
  server.close();
  app.exit(0);
});
