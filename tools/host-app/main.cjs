// Throwaway Electron host used to test CrazyCodeEditor injection.
// Flags:
//   --csp     load a page with a strict Content-Security-Policy meta tag
//   --node    enable nodeIntegration (contextIsolation off) in the renderer
//   --inject  auto-inject dist/crazy.js after load and serve dist/crazy-runtime.pack
//             over a custom protocol so no file dialog is needed during development
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const args = process.argv.slice(2);
const flags = { csp: args.includes('--csp'), cspeval: args.includes('--cspeval'), cspheader: args.includes('--cspheader'), hidden: args.includes('--hidden'), node: args.includes('--node'), inject: args.includes('--inject'), smoke: args.includes('--smoke'), nodev: args.includes('--nodev') };
const dist = path.join(__dirname, '../../dist');

protocol.registerSchemesAsPrivileged([{ scheme: 'crazydev', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }]);

app.whenReady().then(() => {
  if (flags.cspheader) {
    // CSP as a response header, the usual Electron recipe; applies to file:// too
    const { session } = require('electron');
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'";
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }

  protocol.handle('crazydev', (req) => {
    const name = new URL(req.url).pathname.replace(/^\/+/, '');
    return net.fetch(pathToFileURL(path.join(dist, name)).href);
  });

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: !flags.smoke && !flags.hidden,
    paintWhenInitiallyHidden: true,
    title: `Host app (${Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join(', ') || 'default'})`,
    webPreferences: {
      nodeIntegration: flags.node,
      contextIsolation: !flags.node,
      sandbox: !flags.node,
    },
  });
  win.loadFile(path.join(__dirname, flags.csp ? 'index-csp.html' : flags.cspeval ? 'index-csp-eval.html' : 'index.html'));
  if (!flags.smoke) win.webContents.openDevTools({ mode: 'right' });

  if (flags.inject || flags.smoke) {
    win.webContents.on('console-message', (_e, level, message) => {
      if (flags.smoke && !/Autofill\.|Electron Security Warning/.test(message)) console.log(`[renderer:${level}] ${message.slice(0, 600)}`);
    });
    win.webContents.on('did-finish-load', async () => {
      const src = fs.readFileSync(path.join(dist, 'crazy.js'), 'utf8');
      try {
        if (!flags.nodev) await win.webContents.executeJavaScript(`globalThis.__CRAZY_DEV_PACK_URL__ = 'crazydev://pack/crazy-runtime.pack';`);
        await win.webContents.executeJavaScript(src);
        if (flags.smoke) await require('./smoke.cjs')(win, app, flags);
      } catch (e) {
        console.error('inject failed:', e);
        if (flags.smoke) app.exit(1);
      }
    });
  }
});
