// DOM skeleton, splitters, responsive rules.
import type { Host } from '../boot/mount';
import { kvGet, kvSet } from '../runtime/store';
import { icon, ICONS } from './icons';

export interface LayoutRefs {
  app: HTMLDivElement;
  toolbar: HTMLDivElement;
  runBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  title: HTMLDivElement;
  sidebar: HTMLDivElement;
  sidebarActions: HTMLDivElement;
  treeHost: HTMLDivElement;
  center: HTMLDivElement;
  tabsHost: HTMLDivElement;
  editorHost: HTMLDivElement;
  editorEmpty: HTMLDivElement;
  panel: HTMLDivElement;
  panelTabs: Record<'output' | 'repl' | 'problems', HTMLButtonElement>;
  panelViews: Record<'output' | 'repl' | 'problems', HTMLDivElement>;
  problemsBadge: HTMLSpanElement;
  panelActions: HTMLDivElement;
  statusbar: HTMLDivElement;
  toolButton(name: keyof typeof ICONS, label: string, title: string, cls?: string): HTMLButtonElement;
  iconButton(name: keyof typeof ICONS, title: string): HTMLButtonElement;
  showPanel(tab?: 'output' | 'repl' | 'problems'): void;
  togglePanel(): void;
  toggleSidebar(force?: boolean): void;
  activePanel: 'output' | 'repl' | 'problems';
}

interface LayoutState {
  sidebarRatio: number;
  panelRatio: number;
  sidebarHidden: boolean;
  panelHidden: boolean;
  panelTab: 'output' | 'repl' | 'problems';
}

const LAYOUT_KEY = 'layout';

export async function buildLayout(host: Host): Promise<LayoutRefs> {
  const app = host.app;
  const state: LayoutState = { sidebarRatio: 0.2, panelRatio: 0.3, sidebarHidden: false, panelHidden: false, panelTab: 'output', ...((await kvGet<Partial<LayoutState>>(LAYOUT_KEY).catch(() => undefined)) ?? {}) };
  let persistTimer = 0;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => void kvSet(LAYOUT_KEY, state).catch(() => {}), 300);
  };

  const toolButton = (name: keyof typeof ICONS, label: string, title: string, cls = ''): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = `tb-btn ${cls}`;
    b.title = title;
    b.appendChild(icon(name));
    if (label) {
      const t = document.createElement('span');
      t.className = 'txt';
      t.textContent = label;
      b.appendChild(t);
    }
    return b;
  };
  const iconButton = (name: keyof typeof ICONS, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'ib';
    b.title = title;
    b.appendChild(icon(name));
    return b;
  };

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  const sidebarBtn = toolButton('sidebar', '', 'Toggle sidebar (Ctrl+B)');
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.appendChild(icon('python'));
  brand.append('CrazyCodeEditor');
  const runBtn = toolButton('run', 'Run', 'Run current file (F5 / Ctrl+Enter)', 'primary');
  runBtn.classList.add('js-run');
  const stopBtn = toolButton('stop', 'Stop', 'Stop the program (restarts Python)', 'danger');
  stopBtn.classList.add('js-stop');
  const onelineBtn = toolButton('collapse', '1-line', 'Compile the current file into a one-line duplicate (for fun)');
  onelineBtn.dataset.cmd = 'oneline';
  const title = document.createElement('div');
  title.className = 'tb-title';
  const paletteBtn = toolButton('palette', '', 'Command palette (Ctrl+Shift+P)');
  const panelBtn = toolButton('panel', '', 'Toggle panel (Ctrl+J)');
  const settingsBtn = toolButton('gear', '', 'Settings (Ctrl+,)');
  toolbar.append(sidebarBtn, brand, runBtn, stopBtn, onelineBtn, title, paletteBtn, panelBtn, settingsBtn);

  // Main
  const main = document.createElement('div');
  main.className = 'main';
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  const sbHead = document.createElement('div');
  sbHead.className = 'sb-head';
  sbHead.textContent = 'Explorer';
  const sidebarActions = document.createElement('div');
  sidebarActions.className = 'actions';
  sbHead.appendChild(sidebarActions);
  const treeHost = document.createElement('div');
  treeHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column';
  sidebar.append(sbHead, treeHost);

  const splitV = document.createElement('div');
  splitV.className = 'splitter v';
  const center = document.createElement('div');
  center.className = 'center';
  const editorArea = document.createElement('div');
  editorArea.className = 'editor-area';
  const tabsHost = document.createElement('div');
  const editorHost = document.createElement('div');
  editorHost.className = 'editor-host';
  const editorEmpty = document.createElement('div');
  editorEmpty.className = 'editor-empty';
  editorEmpty.innerHTML = `<div class="big">No file open</div><div>Pick a file in the Explorer, or press <kbd>Ctrl</kbd>+<kbd>N</kbd> for a new one.</div><div><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> shows every command.</div>`;
  editorHost.appendChild(editorEmpty);
  editorArea.append(tabsHost, editorHost);

  const splitH = document.createElement('div');
  splitH.className = 'splitter h';
  const panel = document.createElement('div');
  panel.className = 'panel';
  const panelHead = document.createElement('div');
  panelHead.className = 'panel-head';
  const panelBody = document.createElement('div');
  panelBody.className = 'panel-body';
  const panelTabs = {} as LayoutRefs['panelTabs'];
  const panelViews = {} as LayoutRefs['panelViews'];
  const problemsBadge = document.createElement('span');
  problemsBadge.className = 'badge';
  problemsBadge.hidden = true;
  for (const [key, label] of [['output', 'Output'], ['repl', 'REPL'], ['problems', 'Problems']] as const) {
    const b = document.createElement('button');
    b.className = 'panel-tab';
    b.textContent = label;
    if (key === 'problems') b.appendChild(problemsBadge);
    b.onclick = () => showPanel(key);
    panelHead.appendChild(b);
    panelTabs[key] = b;
    const v = document.createElement('div');
    v.className = 'panel-view';
    v.hidden = true;
    panelBody.appendChild(v);
    panelViews[key] = v;
  }
  const panelActions = document.createElement('div');
  panelActions.className = 'actions';
  panelHead.appendChild(panelActions);
  panel.append(panelHead, panelBody);
  center.append(editorArea, splitH, panel);
  main.append(sidebar, splitV, center);

  const statusbar = document.createElement('div');
  statusbar.className = 'statusbar';
  app.append(toolbar, main, statusbar);

  // panel/sidebar visibility
  const refs = {
    app, toolbar, runBtn, stopBtn, title, sidebar, sidebarActions, treeHost, center, tabsHost, editorHost, editorEmpty, panel,
    panelTabs, panelViews, problemsBadge, panelActions, statusbar, toolButton, iconButton, activePanel: state.panelTab,
  } as LayoutRefs;

  function showPanel(tab?: 'output' | 'repl' | 'problems'): void {
    if (tab) {
      state.panelTab = tab;
      refs.activePanel = tab;
      for (const k of ['output', 'repl', 'problems'] as const) {
        panelTabs[k].classList.toggle('active', k === tab);
        panelViews[k].hidden = k !== tab;
      }
    }
    state.panelHidden = false;
    panel.hidden = false;
    splitH.hidden = false;
    persist();
  }
  function togglePanel(): void {
    state.panelHidden = !state.panelHidden;
    panel.hidden = state.panelHidden;
    splitH.hidden = state.panelHidden;
    persist();
  }
  function toggleSidebar(force?: boolean): void {
    state.sidebarHidden = force === undefined ? !state.sidebarHidden : !force;
    sidebar.hidden = state.sidebarHidden;
    splitV.hidden = state.sidebarHidden;
    persist();
  }
  refs.showPanel = showPanel;
  refs.togglePanel = togglePanel;
  refs.toggleSidebar = toggleSidebar;
  showPanel(state.panelTab);
  if (state.panelHidden) togglePanel();
  if (state.sidebarHidden) toggleSidebar(false);
  sidebarBtn.onclick = () => toggleSidebar();
  panelBtn.onclick = () => togglePanel();
  paletteBtn.dataset.cmd = 'palette';
  settingsBtn.dataset.cmd = 'settings';

  // sizes are ratios of the window
  const applySizes = (w: number, h: number) => {
    const sbw = Math.round(Math.max(140, Math.min(w * 0.6, w * state.sidebarRatio)));
    const ph = Math.round(Math.max(80, Math.min(h * 0.8, h * state.panelRatio)));
    app.style.setProperty('--sidebar-w', `${sbw}px`);
    app.style.setProperty('--panel-h', `${ph}px`);
    app.classList.toggle('narrow', w < 900);
    app.classList.toggle('tiny', w < 600);
    if (w < 900 && !state.sidebarHidden && !narrowAutoHid) {
      narrowAutoHid = true;
      sidebar.hidden = true;
      splitV.hidden = true;
    } else if (w >= 900 && narrowAutoHid) {
      narrowAutoHid = false;
      sidebar.hidden = state.sidebarHidden;
      splitV.hidden = state.sidebarHidden;
    }
  };
  let narrowAutoHid = false;
  let size = { w: host.element.clientWidth, h: host.element.clientHeight };
  host.onResize((w, h) => {
    size = { w, h };
    applySizes(w, h);
  });
  applySizes(size.w, size.h);

  const drag = (splitter: HTMLDivElement, onMove: (e: PointerEvent) => void) => {
    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add('active');
      const move = (ev: PointerEvent) => onMove(ev);
      const up = () => {
        splitter.classList.remove('active');
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
        persist();
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
    });
  };
  drag(splitV, (e) => {
    const r = main.getBoundingClientRect();
    state.sidebarRatio = Math.max(0.1, Math.min(0.6, (e.clientX - r.left) / size.w));
    applySizes(size.w, size.h);
  });
  drag(splitH, (e) => {
    const r = center.getBoundingClientRect();
    state.panelRatio = Math.max(0.1, Math.min(0.8, (r.bottom - e.clientY) / size.h));
    applySizes(size.w, size.h);
  });

  // In narrow mode the sidebar overlays: clicking the editor dismisses it.
  center.addEventListener('pointerdown', () => {
    if (app.classList.contains('narrow') && !sidebar.hidden) {
      sidebar.hidden = true;
      splitV.hidden = true;
      narrowAutoHid = true;
    }
  });
  sidebarBtn.onclick = () => {
    if (app.classList.contains('narrow')) {
      sidebar.hidden = !sidebar.hidden;
      narrowAutoHid = sidebar.hidden;
    } else toggleSidebar();
  };

  return refs;
}
