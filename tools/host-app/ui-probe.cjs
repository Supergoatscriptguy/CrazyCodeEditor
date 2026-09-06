// Measures toolbar button geometry and hit-testing.
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const dist = path.join(__dirname, '../../dist');
protocol.registerSchemesAsPrivileged([{ scheme: 'crazydev', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }]);

app.whenReady().then(async () => {
  protocol.handle('crazydev', (req) => net.fetch(pathToFileURL(path.join(dist, new URL(req.url).pathname.replace(/^\/+/, ''))).href));
  const win = new BrowserWindow({ width: 1200, height: 800, show: false, paintWhenInitiallyHidden: true, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(__dirname, 'index.html'));
  const js = (s) => win.webContents.executeJavaScript(s);
  await js(`globalThis.__CRAZY_DEV_PACK_URL__ = 'crazydev://pack/crazy-runtime.pack';`);
  await js(fs.readFileSync(path.join(dist, 'crazy.js'), 'utf8'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !(await js(`!!globalThis.__crazyApp`)); i++) await sleep(200);
  await sleep(800);
  await js(`globalThis.__crazyApp.dismissWelcome?.(); 0`).catch(() => {});
  await sleep(300);

  const report = await js(`(() => {
    const root = globalThis.__crazyHost.root;
    const doc = globalThis.__crazyHost.doc;
    const out = { toolbar: null, buttons: [], gutters: null };
    const tb = root.querySelector('.toolbar');
    const r = tb.getBoundingClientRect();
    const cs = globalThis.__crazyHost.win.getComputedStyle(tb);
    const w = globalThis.__crazyHost.win;
    const appRect = globalThis.__crazyHost.app.getBoundingClientRect();
    out.toolbar = { top: r.top, height: r.height, display: cs.display, alignItems: cs.alignItems, overflow: cs.overflow };
    out.frame = {
      appTop: appRect.top, appHeight: Math.round(appRect.height),
      innerHeight: w.innerHeight, scrollY: w.scrollY,
      bodyTop: doc.body.getBoundingClientRect().top,
      overlayTop: globalThis.__crazyHost.element.getBoundingClientRect().top,
      hostInnerHeight: window.innerHeight,
    };
    const appEl = globalThis.__crazyHost.app;
    const as = w.getComputedStyle(appEl);
    out.app = {
      isToolbarParent: tb.parentElement === appEl,
      offsetTopOfToolbar: tb.offsetTop,
      offsetParent: tb.offsetParent ? (tb.offsetParent.id || tb.offsetParent.tagName) : null,
      clientHeight: appEl.clientHeight, offsetHeight: appEl.offsetHeight,
      paddingTop: as.paddingTop, borderTop: as.borderTopWidth, justifyContent: as.justifyContent,
      transform: as.transform, position: as.position, top: as.top,
      scrollingElTop: doc.scrollingElement ? doc.scrollingElement.scrollTop : -1,
      docElTop: doc.documentElement.getBoundingClientRect().top,
      appScrollTop: appEl.scrollTop,
    };
    out.appChildren = [...globalThis.__crazyHost.app.children].map((el) => {
      const cr = el.getBoundingClientRect();
      const s2 = w.getComputedStyle(el);
      return { cls: el.className || el.tagName, top: cr.top, height: Math.round(cr.height), position: s2.position, marginTop: s2.marginTop, flex: s2.flex };
    });
    for (const b of root.querySelectorAll('.toolbar .tb-btn')) {
      const br = b.getBoundingClientRect();
      const bs = globalThis.__crazyHost.win.getComputedStyle(b);
      // hit-test at several heights
      const hits = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => {
        const el = doc.elementFromPoint(br.left + br.width / 2, br.top + br.height * f);
        return el === b || b.contains(el) ? 'hit' : (el ? el.className || el.tagName : 'null');
      });
      out.buttons.push({
        label: (b.textContent || b.title).trim().slice(0, 12),
        top: Math.round(br.top), height: Math.round(br.height), width: Math.round(br.width),
        display: bs.display, alignSelf: bs.alignSelf, hits,
      });
    }
    const g = root.querySelector('.cm-gutters');
    if (g) {
      const gr = g.getBoundingClientRect();
      const gcs = globalThis.__crazyHost.win.getComputedStyle(g);
      const content = root.querySelector('.cm-content').getBoundingClientRect();
      out.gutters = { width: Math.round(gr.width), borderRight: gcs.borderRightWidth + ' ' + gcs.borderRightColor, contentLeft: Math.round(content.left - gr.right) };
    }
    return JSON.stringify(out, null, 1);
  })()`);
  console.log(report);
  app.exit(0);
});
