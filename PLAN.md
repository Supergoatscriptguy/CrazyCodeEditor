# CrazyCodeEditor — design notes

Paste `crazy.js` into the DevTools console of an Electron app and it becomes a
Python IDE. No network, no installs. Everything comes from the paste or from
files on the same flash drive.

## Goals

- One console paste, any Electron renderer with DevTools open.
- Real Python where possible (CPython via Pyodide), a fallback where not.
- A proper editor: file tree, tabs, completion, lint, format, run/stop, stdin,
  REPL, palette, themes, persistent workspace.
- Take over the host window cleanly and survive its re-renders.
- Portable: a folder on a flash drive, nothing written next to it.

Not in scope: pip over the network, a debugger, native GUI toolkits.

## Decisions

| | choice | why |
|---|---|---|
| interpreter | Pyodide (CPython 3.12, wasm) | the only real CPython with a full stdlib |
| fallback | own interpreter in JS (`src/pyjs`) | see CSP below |
| editor | CodeMirror 6 | one bundle, no worker files |
| bundling | TypeScript + esbuild, one IIFE | nothing to load at runtime |
| host isolation | about:blank iframe (shadow DOM fallback) | host CSS and key handlers can't reach in |
| delivery | `crazy.js` + `crazy-runtime.pack` | Pyodide is ~20 MB, too big to paste |
| pack cache | IndexedDB, per host origin | pick the pack once per app |
| execution | blob worker; UI thread if workers are blocked | |
| language tools | Jedi, pyflakes, Black as wheels in the pack | |

## How the pieces fit

```
crazy.js
  boot/      probe the host, mount the overlay
  app/       App, workspace, settings, themes
  editor/    CodeMirror
  terminal/  ANSI parser + terminal view
  ui/        layout, tree, tabs, palette, dialogs, repl, problems
  runtime/   pack format, IndexedDB store, loader, worker bridge, runtime core
  pyjs/      the JS interpreter
crazy-runtime.pack
  pyodide core, python_stdlib.zip, pyodide-lock.json, wheels, numpy, matplotlib
```

Pyodide fetches its files relative to `indexURL`; the runtime patches `fetch`
to answer those requests from the pack held in memory, and evaluates
`pyodide.asm.js` itself so `loadPyodide` skips its own script loading. Wheels
are unzipped into site-packages; distribution packages (numpy, matplotlib) load
lazily through `loadPackagesFromImports` because they sit in the pack under the
file names the lock file expects.

## Things that weren't obvious

**stdin.** A default Electron renderer has no `SharedArrayBuffer`, so a worker
can't block on `input()`. When a program asks for input, the run ends, the
prompt shows inline, and after the answer the program is replayed from the
start with the answers so far. Output already shown is suppressed, images are
counted the same way, and `random` is seeded per run so replays match. Where
SAB does exist the worker blocks for real. The JS interpreter doesn't need any
of this: its evaluator is generator-based, so `input()` just suspends.

**Host isolation.** The first version used a shadow DOM host with a
capture-phase event blocker on `window`. That also blocked our own listeners
(Enter in the input prompt did nothing). An iframe isolates events without
blocking anything. Two more traps found later: `overflow: hidden` on the app
shell is still a scroll container and focus can scroll it a few pixels for
good (`overflow: clip` fixes that), and custom Electron title bars marked
`-webkit-app-region: drag` swallow clicks through the overlay, so the host
document gets `* { -webkit-app-region: no-drag }` while the editor is up.

**CSP.** Measured with the experiments in `tools/host-app/`:

- The DevTools console exemption covers `eval` but not WebAssembly compilation
  or blob workers. Nothing pasted can run Pyodide under
  `script-src` without `wasm-unsafe-eval`.
- DevTools Local Overrides can rewrite a meta-tag CSP or an HTTP header, but
  not a header injected by the app's own main process on a `file://` page.
  `Page.setBypassCSP` over the debugging protocol can (`tools/attach.mjs`),
  but that needs Node, which breaks the premise.
- So where wasm is refused the editor uses its own interpreter. Code pasted
  into the console is compiled once and then runs forever, so an interpreter
  that never calls `eval` works under any policy. Brython and Skulpt don't
  qualify; both eval generated JS at run time.

**Paste hygiene.** The bundle goes through clipboards. A raw `U+FFFF` in a
regex literal got mangled and broke the paste; the build now fails if
`dist/crazy.js` contains any non-ASCII character.

**UI-thread mode.** Hosts that allow `unsafe-eval` but not blob workers run
Pyodide on the main thread. Some only allow `eval` during the paste, so
`pyodide.asm.js` is cached in localStorage and evaluated at the start of the
next paste. A `sys.settrace` watchdog stops runaway loops after 60 s.

**Testing.** `tools/host-app/` is a throwaway Electron host with variants:
default, strict CSP (meta), header CSP on `file://`, `unsafe-eval` without
workers, Node integration. `npm run smoke:all` drives the real UI through all
of them in hidden windows. `tools/test-pyjs.mjs` runs programs through the JS
interpreter and diffs stdout against CPython's output. `ELECTRON_RUN_AS_NODE`
leaks from VS Code terminals and breaks `electron`; always launch through
`tools/host-app/run.mjs`.

## Still open

- Vim/Emacs keymaps, split editor
- signature help popup while typing arguments
- try/with/break support in the one-liner
- undo history across re-pastes, find in files, rename symbol
- the JS interpreter: `async`/`await`, complex numbers, more of `datetime`
- real-disk workspace when Node integration is exposed
- testing on more real host apps
