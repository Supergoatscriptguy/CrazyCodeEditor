// Full-window overlay. The UI lives in an about:blank iframe so host CSS and
// key handlers can't reach it; shadow DOM is the fallback.

export interface Host {
  /** Overlay element in the host document. */
  element: HTMLElement;
  mode: 'iframe' | 'shadow';
  /** Document and window our UI lives in. */
  doc: Document;
  win: Window & typeof globalThis;
  /** Where <style> elements go. */
  head: HTMLElement | ShadowRoot;
  /** Element that carries the CSS custom properties (themes, fonts). */
  styleRoot: HTMLElement;
  /** Container to query the UI from (iframe body or shadow root). */
  root: HTMLElement | ShadowRoot;
  app: HTMLDivElement;
  onResize(cb: (w: number, h: number) => void): void;
  unmount(): void;
}

const HOST_ID = 'crazy-code-editor-host';

const OVERLAY_STYLE = 'all:initial;position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;outline:none;transform:none;z-index:2147483647;display:block;overflow:hidden;background:#1e1e1e;';
const FRAME_STYLE = 'all:initial;position:absolute;inset:0;width:100%;height:100%;border:0;outline:none;margin:0;padding:0;display:block;background:#1e1e1e;color-scheme:dark;';
const BASE_CSS = `
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #1e1e1e; }
*, *::before, *::after { box-sizing: border-box; }
/* clip, not hidden: hidden is still a scroll container and focus can scroll it */
#app { position: fixed; inset: 0; display: flex; flex-direction: column; overflow: hidden; overflow: clip; }
`;

// host drag regions (custom title bars) swallow clicks even through the overlay
const HOST_PATCH_CSS = '*{-webkit-app-region:no-drag !important}';

export function mount(): Host {
  const prev = (globalThis as any).__crazyHost as Host | undefined;
  if (prev) prev.unmount();

  const element = document.createElement('div');
  element.id = HOST_ID;
  element.setAttribute('style', OVERLAY_STYLE);
  // Attach to <html>, not <body>: SPA routers that replace body cannot take us down.
  document.documentElement.appendChild(element);

  let mode: Host['mode'] = 'iframe';
  let doc: Document = document;
  let win: Window & typeof globalThis = window;
  let head: HTMLElement | ShadowRoot;
  let styleRoot: HTMLElement;
  let root: HTMLElement | ShadowRoot;
  const cleanups: Array<() => void> = [];

  try {
    const frame = document.createElement('iframe');
    frame.setAttribute('style', FRAME_STYLE);
    frame.setAttribute('title', 'CrazyCodeEditor');
    element.appendChild(frame);
    const fdoc = frame.contentDocument;
    const fwin = frame.contentWindow as (Window & typeof globalThis) | null;
    if (!fdoc || !fwin) throw new Error('no iframe document');
    fdoc.open();
    fdoc.write('<!doctype html><html><head><meta charset="utf-8"><title>CrazyCodeEditor</title></head><body></body></html>');
    fdoc.close();
    doc = fdoc;
    win = fwin;
    head = fdoc.head;
    styleRoot = fdoc.documentElement;
    root = fdoc.body;
  } catch (e) {
    console.warn('[crazy] iframe host unavailable, using shadow DOM', e);
    mode = 'shadow';
    element.innerHTML = '';
    const shadow = element.attachShadow({ mode: 'open' });
    head = shadow;
    styleRoot = element;
    root = shadow;
    // keep the host's bubble listeners from seeing our events
    const stop = (e: Event) => e.stopPropagation();
    for (const type of ['keydown', 'keyup', 'keypress', 'wheel', 'contextmenu', 'copy', 'cut', 'paste', 'drop', 'dragover', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup']) {
      element.addEventListener(type, stop);
      cleanups.push(() => element.removeEventListener(type, stop));
    }
  }

  const base = doc.createElement('style');
  base.textContent = BASE_CSS;
  head.appendChild(base);
  const app = doc.createElement('div');
  app.id = 'app';
  root.appendChild(app);

  // for browsers without overflow:clip
  const unscroll = () => {
    if (app.scrollTop !== 0 || app.scrollLeft !== 0) {
      app.scrollTop = 0;
      app.scrollLeft = 0;
    }
  };
  app.addEventListener('scroll', unscroll, true);
  doc.addEventListener('focusin', unscroll, true);

  // If the host removes us, put us back.
  const observer = new MutationObserver(() => {
    if (!element.isConnected) document.documentElement.appendChild(element);
  });
  observer.observe(document.documentElement, { childList: true });

  // our state autosaves; the host's beforeunload prompt is just noise
  const unloadBlocker = (e: Event) => e.stopImmediatePropagation();
  window.addEventListener('beforeunload', unloadBlocker, { capture: true });

  const hostPatch = document.createElement('style');
  hostPatch.textContent = HOST_PATCH_CSS;
  document.documentElement.appendChild(hostPatch);

  // Hide the host's own scrollbars so the overlay gets the whole viewport.
  const htmlStyle = document.documentElement.style;
  const prevOverflow = htmlStyle.getPropertyValue('overflow');
  const prevOverflowPriority = htmlStyle.getPropertyPriority('overflow');
  htmlStyle.setProperty('overflow', 'hidden', 'important');

  const resizeCbs: Array<(w: number, h: number) => void> = [];
  const ro = new ResizeObserver(() => {
    const r = element.getBoundingClientRect();
    for (const cb of resizeCbs) cb(r.width, r.height);
  });
  ro.observe(element);

  const host: Host = {
    element,
    mode,
    doc,
    win,
    head,
    styleRoot,
    root,
    app,
    onResize(cb) {
      resizeCbs.push(cb);
    },
    unmount() {
      observer.disconnect();
      ro.disconnect();
      for (const c of cleanups) c();
      window.removeEventListener('beforeunload', unloadBlocker, { capture: true });
      htmlStyle.setProperty('overflow', prevOverflow, prevOverflowPriority);
      hostPatch.remove();
      element.remove();
      if ((globalThis as any).__crazyHost === host) delete (globalThis as any).__crazyHost;
    },
  };
  (globalThis as any).__crazyHost = host;
  return host;
}
