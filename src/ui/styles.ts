// All UI CSS. Colors come from the theme variables.
export const APP_CSS = `
#app {
  --mono: "Cascadia Code", "Cascadia Mono", Consolas, "JetBrains Mono", "Fira Code", Menlo, "DejaVu Sans Mono", monospace;
  --ui: system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --sidebar-w: 240px;
  --panel-h: 220px;
  font-family: var(--ui);
  font-size: 13px;
  line-height: 1.4;
  color: var(--fg);
  background: var(--bg);
}
html { background: var(--bg); }
button, input, select { font: inherit; color: inherit; }
button { background: none; border: 0; padding: 0; cursor: pointer; color: inherit; }
*:focus { outline: none; }
.btn:focus-visible, .ib:focus-visible, .tb-btn:focus-visible, .field input:focus-visible, .field select:focus-visible, .dialog-input:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.cm-editor.cm-focused, .cm-editor .cm-content:focus, .term:focus, .tree:focus, .tabs:focus { outline: none !important; }
.icon { display: inline-flex; width: 16px; height: 16px; vertical-align: middle; flex: none; }
.icon svg { width: 100%; height: 100%; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--fg) 20%, transparent); border-radius: 5px; border: 2px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background-color: color-mix(in srgb, var(--fg) 35%, transparent); }
::-webkit-scrollbar-corner { background: transparent; }

/* toolbar */
.toolbar { display: flex; align-items: center; gap: 4px; height: 36px; padding: 0 8px; background: var(--bgBar); border-bottom: 1px solid var(--border); flex: none; -webkit-app-region: no-drag; }
.toolbar .brand { display: flex; align-items: center; gap: 6px; font-weight: 600; margin-right: 8px; color: var(--fg); }
.toolbar .brand .icon { color: var(--accent); }
.tb-btn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px; border-radius: 4px; color: var(--fg); white-space: nowrap; }
.tb-btn:hover { background: var(--bgHover); }
.tb-btn:disabled { opacity: .4; cursor: default; background: none; }
.tb-btn.primary { background: var(--accent); color: var(--accentFg); }
.tb-btn.primary:hover { filter: brightness(1.1); }
.tb-btn.danger { color: var(--error); }
.tb-btn .key { font-size: 11px; opacity: .6; margin-left: 2px; }
.tb-title { flex: 1; text-align: center; color: var(--fgMuted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 8px; }
.tb-spacer { flex: 1; }

/* layout */
.main { flex: 1; display: flex; min-height: 0; position: relative; }
.sidebar { width: var(--sidebar-w); min-width: 140px; max-width: 60vw; flex: none; display: flex; flex-direction: column; background: var(--bgAlt); border-right: 1px solid var(--border); min-height: 0; }
.sidebar[hidden] { display: none; }
.sb-head { display: flex; align-items: center; height: 32px; padding: 0 8px 0 14px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--fgMuted); flex: none; }
.sb-head .actions { margin-left: auto; display: flex; gap: 2px; opacity: 0; transition: opacity .1s; }
.sidebar:hover .sb-head .actions, .sb-head .actions:focus-within { opacity: 1; }
.ib { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 4px; color: var(--fg); }
.ib:hover { background: var(--bgHover); }
.tree { flex: 1; overflow: auto; padding: 2px 0 20px; user-select: none; }
.tree-row { display: flex; align-items: center; gap: 4px; height: 24px; padding-right: 8px; white-space: nowrap; cursor: pointer; color: var(--fg); }
.tree-row:hover { background: var(--bgHover); }
.tree-row.active { background: color-mix(in srgb, var(--accent) 25%, transparent); }
.tree-row .chev { width: 16px; height: 16px; display: inline-flex; flex: none; color: var(--fgMuted); }
.tree-row .icon { color: var(--fgMuted); }
.tree-row.folder .icon { color: var(--warning); }
.tree-row .name { overflow: hidden; text-overflow: ellipsis; }
.tree-row .dirty { width: 8px; height: 8px; border-radius: 50%; background: var(--fg); margin-left: auto; flex: none; opacity: .8; }
.tree-row input { flex: 1; min-width: 0; height: 20px; background: var(--bg); border: 1px solid var(--accent); border-radius: 2px; padding: 0 4px; font: inherit; }
.tree-empty { padding: 12px 14px; color: var(--fgMuted); font-size: 12px; line-height: 1.5; }
.splitter { flex: none; background: transparent; position: relative; z-index: 2; }
.splitter.v { width: 5px; margin: 0 -2px; cursor: col-resize; }
.splitter.h { height: 5px; margin: -2px 0; cursor: row-resize; }
.splitter:hover, .splitter.active { background: var(--accent); opacity: .6; transition: background .15s .15s; }
.center { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.editor-area { flex: 1; display: flex; flex-direction: column; min-height: 0; position: relative; }
.editor-host { flex: 1; min-height: 0; position: relative; }
.editor-host .cm-editor { position: absolute; inset: 0; }
.editor-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--fgMuted); background: var(--bg); }
.editor-empty .big { font-size: 20px; color: var(--fg); opacity: .6; }
.editor-empty kbd { font-family: var(--ui); background: var(--bgAlt); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 1px 6px; font-size: 11px; }

/* tabs */
.tabs { display: flex; height: 35px; background: var(--bgBar); border-bottom: 1px solid var(--border); overflow-x: auto; overflow-y: hidden; flex: none; scrollbar-width: none; }
.tabs::-webkit-scrollbar { display: none; }
.tab { display: flex; align-items: center; gap: 6px; padding: 0 8px 0 12px; height: 100%; border-right: 1px solid var(--border); color: var(--fgMuted); cursor: pointer; white-space: nowrap; user-select: none; border-top: 1px solid transparent; }
.tab .icon { color: var(--fgMuted); }
.tab:hover { background: var(--bgHover); }
.tab.active { background: var(--bg); color: var(--fg); border-top-color: var(--accent); }
.tab .x { display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center; border-radius: 3px; opacity: 0; }
.tab:hover .x, .tab.active .x { opacity: .7; }
.tab .x:hover { background: var(--bgHover); opacity: 1; }
.tab.dirty .x .icon { display: none; }
.tab.dirty .x::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--fg); }
.tab.dirty:hover .x::before { display: none; }
.tab.dirty:hover .x .icon { display: inline-flex; }

/* bottom panel */
.panel { height: var(--panel-h); min-height: 80px; max-height: 80vh; flex: none; display: flex; flex-direction: column; border-top: 1px solid var(--border); background: var(--bgAlt); min-width: 0; }
.panel[hidden] { display: none; }
.panel-head { display: flex; align-items: center; height: 32px; padding: 0 8px 0 4px; flex: none; gap: 2px; }
.panel-tab { padding: 0 10px; height: 100%; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--fgMuted); border-bottom: 1px solid transparent; }
.panel-tab.active { color: var(--fg); border-bottom-color: var(--accent); }
.panel-tab .badge { background: var(--error); color: #fff; font-size: 10px; border-radius: 8px; padding: 0 5px; min-width: 16px; text-align: center; font-weight: 600; }
.panel-tab .badge.warn { background: var(--warning); color: #000; }
.panel-tab .badge[hidden] { display: none; }
.panel-head .actions { margin-left: auto; display: flex; gap: 2px; align-items: center; }
.panel-body { flex: 1; min-height: 0; position: relative; }
.panel-view { position: absolute; inset: 0; display: flex; flex-direction: column; }
.panel-view[hidden] { display: none; }

/* terminal */
.term { flex: 1; min-height: 0; overflow: auto; background: var(--t-bg); color: var(--t-fg); font-family: var(--mono); font-size: var(--term-font-size); line-height: 1.45; padding: 6px 10px; cursor: text; }
.term::selection, .term *::selection { background: var(--t-sel); }
.term-line { white-space: pre-wrap; word-break: break-word; min-height: 1.45em; }
.term-system { color: var(--t-dim); font-style: italic; }
.term-stderr { color: var(--t-a9); }
.term-echo { color: var(--t-a14); }
.term-input { font: inherit; color: var(--t-fg); background: transparent; border: 0; outline: 0; padding: 0; margin: 0; width: 60%; min-width: 120px; caret-color: var(--t-cursor); }
.term-link { color: var(--t-a12); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.term-link:hover { color: var(--t-a14); }
.term-has-link { }
.term-img-line { padding: 6px 0; }
.term-img { display: block; max-width: min(100%, 640px); max-height: 420px; height: auto; border-radius: 4px; background: #fff; cursor: zoom-in; }
.term-img.full { max-width: 100%; max-height: none; cursor: zoom-out; }
.helpdoc h3 { margin: 14px 0 4px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--fgMuted); }
.helpdoc h3:first-child { margin-top: 0; }
.helpdoc p { margin: 4px 0; }
.helpdoc kbd { font-family: var(--ui); background: var(--bg); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; font-size: 11px; }
.helpdoc table { border-collapse: collapse; width: 100%; font-size: 12px; }
.helpdoc td { padding: 3px 6px 3px 0; border-bottom: 1px solid var(--border); }
.helpdoc td:first-child { white-space: nowrap; width: 1%; padding-right: 16px; }
.helpdoc code { font-family: var(--mono); background: var(--bg); padding: 0 4px; border-radius: 3px; }
.helpdoc .pk { display: inline-block; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; margin: 2px 4px 2px 0; font-family: var(--mono); font-size: 11px; }
.term-banner { padding: 6px 10px; background: color-mix(in srgb, var(--warning) 20%, var(--t-bg)); color: var(--fg); font-size: 12px; border-bottom: 1px solid var(--border); flex: none; }
.term-banner[hidden] { display: none; }

/* repl */
.repl-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--t-bg); }
.repl-wrap .term { flex: 1; }
.repl-line { display: flex; align-items: center; gap: 0; padding: 4px 10px 8px; font-family: var(--mono); font-size: var(--term-font-size); background: var(--t-bg); color: var(--t-fg); border-top: 1px dashed color-mix(in srgb, var(--t-fg) 15%, transparent); }
.repl-line .ps { color: var(--t-a10); white-space: pre; }
.repl-line input { flex: 1; background: transparent; border: 0; outline: 0; color: var(--t-fg); font: inherit; caret-color: var(--t-cursor); }
.repl-line input:disabled { opacity: .5; }
.repl-out .repl-in { color: var(--t-fg); }
.repl-out .repl-ps { color: var(--t-a10); }

/* problems */
.problems { flex: 1; overflow: auto; padding: 4px 0; font-size: 12px; }
.prob-file { padding: 4px 12px; color: var(--fgMuted); font-weight: 600; }
.prob-row { display: flex; align-items: center; gap: 8px; padding: 3px 12px 3px 20px; cursor: pointer; }
.prob-row:hover { background: var(--bgHover); }
.prob-row .icon { flex: none; }
.prob-row.error .icon { color: var(--error); }
.prob-row.warning .icon { color: var(--warning); }
.prob-row .pos { color: var(--fgMuted); margin-left: auto; font-variant-numeric: tabular-nums; }
.prob-empty { padding: 12px; color: var(--fgMuted); }

/* status bar */
.statusbar { display: flex; align-items: center; height: 22px; padding: 0 6px; background: var(--accent); color: var(--accentFg); font-size: 12px; flex: none; gap: 2px; }
.statusbar.idle { background: var(--bgBar); color: var(--fgMuted); border-top: 1px solid var(--border); }
.st { display: inline-flex; align-items: center; gap: 5px; height: 100%; padding: 0 6px; white-space: nowrap; border-radius: 3px; }
.st.btn { cursor: pointer; }
.st.btn:hover { background: color-mix(in srgb, currentColor 15%, transparent); }
.st .icon { width: 14px; height: 14px; }
.st.right { margin-left: auto; }
.st .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.st .dot.busy { animation: pulse 1s infinite; }
@keyframes pulse { 50% { opacity: .3; } }

/* overlays */
.overlay { position: absolute; inset: 0; z-index: 50; display: flex; align-items: flex-start; justify-content: center; background: rgba(0,0,0,.35); padding-top: 8vh; }
.overlay.center { align-items: center; padding-top: 0; }
.overlay[hidden] { display: none; }
.card { background: var(--bgAlt); color: var(--fg); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 12px 40px rgba(0,0,0,.45); width: min(560px, 92vw); max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; }
.card.wide { width: min(720px, 94vw); }
.card-head { padding: 14px 18px 6px; font-size: 15px; font-weight: 600; }
.card-body { padding: 8px 18px 14px; overflow: auto; line-height: 1.5; }
.card-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 18px 14px; border-top: 1px solid var(--border); }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 14px; border-radius: 4px; background: var(--bgHover); color: var(--fg); border: 1px solid var(--border); }
.btn:hover { filter: brightness(1.15); }
.btn.primary { background: var(--accent); color: var(--accentFg); border-color: transparent; }
.btn.danger { background: var(--error); color: #fff; border-color: transparent; }
.btn:disabled { opacity: .5; cursor: default; }
.field { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.field:last-child { border-bottom: 0; }
.field label { display: flex; flex-direction: column; gap: 2px; }
.field label small { color: var(--fgMuted); font-size: 11px; }
.field input[type=text], .field input[type=number], .field select, .dialog-input { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; height: 28px; min-width: 160px; }
.field input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent); }
.dialog-input { width: 100%; box-sizing: border-box; margin-top: 8px; }
.dialog-msg { white-space: pre-wrap; }
.dialog-err { color: var(--error); font-size: 12px; margin-top: 6px; min-height: 16px; }

.helpdoc h3 { margin: 14px 0 4px; font-size: 13px; }
.helpdoc p { margin: 6px 0; }
.helpdoc code { font-family: var(--mono); font-size: 12px; background: var(--bg); padding: 1px 4px; border-radius: 3px; }
.helpdoc kbd { font-family: var(--ui); background: var(--bg); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; font-size: 11px; }
.helpdoc table { border-collapse: collapse; font-size: 12px; }
.helpdoc td { padding: 2px 10px 2px 0; }
.helpdoc .pk { display: inline-block; font-family: var(--mono); font-size: 11px; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 0 7px; margin: 0 3px 3px 0; }
.helpdoc .codeblock { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-all; user-select: all; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; margin: 6px 0; }

/* palette */
.palette { width: min(600px, 92vw); background: var(--bgAlt); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; display: flex; flex-direction: column; max-height: 70vh; }
.palette input { background: var(--bg); border: 1px solid var(--accent); border-radius: 4px; margin: 8px; padding: 6px 10px; height: 32px; outline: none; }
.palette ul { list-style: none; margin: 0; padding: 0 0 6px; overflow: auto; }
.palette li { display: flex; align-items: center; gap: 10px; padding: 6px 14px; cursor: pointer; }
.palette li.sel { background: var(--accent); color: var(--accentFg); }
.palette li .lbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.palette li .lbl b { font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.palette li .det { opacity: .6; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
.palette li .keys { opacity: .7; font-size: 11px; font-family: var(--mono); }
.palette .none { padding: 12px 14px; color: var(--fgMuted); }

/* context menu */
.ctx { position: absolute; z-index: 60; min-width: 160px; background: var(--bgAlt); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.4); padding: 4px; }
.ctx button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border-radius: 4px; text-align: left; }
.ctx button:hover { background: var(--accent); color: var(--accentFg); }
.ctx hr { border: 0; border-top: 1px solid var(--border); margin: 4px 0; }

/* toast */
.toasts { position: absolute; right: 14px; bottom: 34px; z-index: 70; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.toast { background: var(--bgAlt); color: var(--fg); border: 1px solid var(--border); border-left: 3px solid var(--info); border-radius: 6px; padding: 8px 12px; box-shadow: 0 6px 20px rgba(0,0,0,.35); max-width: 380px; font-size: 12px; pointer-events: auto; animation: toast-in .15s ease-out; }
.toast.error { border-left-color: var(--error); }
.toast.warning { border-left-color: var(--warning); }
.toast.success { border-left-color: var(--success); }
@keyframes toast-in { from { transform: translateY(6px); opacity: 0; } }

/* boot */
.boot-table { border-collapse: collapse; font-size: 12px; width: 100%; margin: 6px 0 10px; }
.boot-table td { padding: 3px 8px; border-bottom: 1px solid var(--border); }
.boot-table td.ok { color: var(--success); } .boot-table td.bad { color: var(--error); }
.boot-msg { margin: 6px 0; }
.boot-msg.err { color: var(--error); }
.progress { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; margin: 8px 0; }
.progress > div { height: 100%; width: 40%; background: var(--accent); animation: slide 1.2s infinite linear; }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(260%); } }

/* responsive */
#app.narrow .sidebar { position: absolute; left: 0; top: 0; bottom: 0; z-index: 10; box-shadow: 4px 0 16px rgba(0,0,0,.3); }
#app.narrow .splitter.v { display: none; }
#app.narrow .tb-title { display: none; }
#app.tiny .panel { height: 50% !important; }
#app.tiny .tb-btn .txt { display: none; }
#app.tiny .statusbar .st.optional { display: none; }
`;
