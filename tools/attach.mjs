// Starts the editor inside an Electron app whose CSP blocks WebAssembly, by
// clearing the policy over the app's debugging port.
//
//   1. quit the app
//   2. "C:\path\to\App.exe" --remote-debugging-port=9222
//   3. node attach.mjs
//
// --port 9222  --dir <folder>  --list  --target <n|substring>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 || i + 1 >= args.length ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const port = Number(opt('port', 9222));
const here = path.dirname(fileURLToPath(import.meta.url));

function findAssets() {
  const candidates = [opt('dir', null), here, path.join(here, '..', 'dist', 'CrazyCodeEditor'), path.join(here, '..', 'dist'), process.cwd()].filter(Boolean);
  for (const dir of candidates) {
    const js = path.join(dir, 'crazy.js');
    const pack = path.join(dir, 'crazy-runtime.pack');
    if (fs.existsSync(js) && fs.existsSync(pack)) return { dir, js, pack };
  }
  console.error('Could not find crazy.js and crazy-runtime.pack.');
  console.error('Looked in:\n  ' + candidates.join('\n  '));
  console.error('Pass --dir <folder> to say where they are.');
  process.exit(1);
}

async function targets() {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/list`);
  } catch {
    console.error(`Nothing is listening on port ${port}.`);
    console.error('Quit the app completely (check the system tray), then relaunch it as:');
    console.error(`  & "C:\\path\\to\\App.exe" --remote-debugging-port=${port}`);
    process.exit(1);
  }
  return (await res.json()).filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
}

/** Smallest possible DevTools-protocol client. */
class Client {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!p) return;
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else {
        for (const w of this.waiters.splice(0)) {
          if (w.method === msg.method) w.resolve(msg.params);
          else this.waiters.push(w);
        }
      }
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('could not open the debugging connection'));
    });
    return new Client(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ method, resolve });
      setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const assets = findAssets();
  const pages = await targets();
  if (!pages.length) {
    console.error('The app is listening, but exposes no inspectable page.');
    process.exit(1);
  }
  if (has('list')) {
    pages.forEach((t, i) => console.log(`[${i}] ${t.title}\n    ${t.url}`));
    return;
  }

  let page = pages[0];
  const want = opt('target', null);
  if (want !== null) {
    page = /^\d+$/.test(want) ? pages[Number(want)] : pages.find((t) => t.url.includes(want) || t.title.includes(want));
    if (!page) {
      console.error(`No page matched --target ${want}. Run with --list to see them.`);
      process.exit(1);
    }
  } else if (pages.length > 1) {
    console.log(`This app has ${pages.length} pages; using the first. Use --list and --target to pick another.`);
  }
  console.log(`Page:    ${page.title || page.url}`);
  console.log(`Files:   ${assets.dir}`);

  // Serve the runtime pack over loopback so the editor needs no file dialog.
  const packBytes = fs.readFileSync(assets.pack);
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(packBytes);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const packUrl = `http://127.0.0.1:${server.address().port}/crazy-runtime.pack`;

  const client = await Client.connect(page.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  // The policy is bound to the document, so it only lifts on the next load.
  await client.send('Page.setBypassCSP', { enabled: true });
  console.log('Policy:  cleared for this page (restored when the app restarts)');
  const loaded = client.once('Page.loadEventFired', 60000);
  await client.send('Page.reload', { ignoreCache: false });
  await loaded;
  await sleep(400);

  const allowed = await client.evaluate(
    `WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => true, () => false)`,
  );
  if (!allowed) {
    console.error('WebAssembly is still refused after the reload. Report this with the app name.');
    server.close();
    client.close();
    process.exit(1);
  }
  console.log('Python:  WebAssembly is available');

  await client.evaluate(`globalThis.__CRAZY_DEV_PACK_URL__ = ${JSON.stringify(packUrl)}; 0`, false);
  await client.evaluate(fs.readFileSync(assets.js, 'utf8'), false);

  const deadline = Date.now() + 120000;
  let status = 'starting';
  while (Date.now() < deadline) {
    status = await client.evaluate(`globalThis.__crazyApp ? __crazyApp.status() : 'loading'`).catch(() => 'loading');
    if (status === 'ready' || status === 'blocked') break;
    await sleep(400);
  }
  const mode = await client.evaluate(`globalThis.__crazyApp ? __crazyApp.mode() : '?'`).catch(() => '?');
  console.log(`Editor:  ${status}${status === 'ready' ? ` (${mode} mode)` : ''}`);
  if (status === 'ready') console.log('\nThe editor is running in the app. Your files are saved inside it.');
  else console.log('\nThe editor did not finish starting. Open the app DevTools console to see why.');

  await sleep(1500); // let any late pack fetch finish
  server.close();
  client.close();
  process.exit(status === 'ready' ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
