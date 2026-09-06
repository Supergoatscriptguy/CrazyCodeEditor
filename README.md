# CrazyCodeEditor

Paste one file into the DevTools console of any Electron app and it becomes a
portable Python IDE with a real CPython interpreter (Pyodide). No installs, no
network, no CDNs. Carry it on a flash drive.

See [PLAN.md](PLAN.md) for the roadmap and design decisions.

## Using it

1. Open the Electron app and its DevTools console.
2. Paste the contents of `crazy.js` and press Enter.
3. When asked, pick `crazy-runtime.pack`. Each app asks only once; the runtime
   is cached in the app's IndexedDB afterwards.

## What you get

- CodeMirror editor with Python highlighting, VS Code-style shortcuts, multiple cursors, search and replace
- Autocomplete as you type (Jedi), with `print(|)`-style insertion for functions, hover docs, go to definition (F12)
- Live error underlines (pyflakes) and a Problems panel, Black formatting (Shift+Alt+F, optional format on save)
- Internal file tree with folders, tabs, rename, delete, import/export as zip. Files live in the app's storage and are mounted into Python's filesystem, so `open()` and imports between your files work. Nothing touches the real disk.
- Terminal-style output with ANSI colors, clickable tracebacks, inline `input()` prompts, and 12 terminal themes
- REPL that shares the interpreter with your last run
- Command palette (Ctrl+Shift+P), quick open (Ctrl+P), settings (Ctrl+,), 9 editor themes

### Packages
The runtime pack bundles NumPy and matplotlib (with their dependencies) from
the Pyodide distribution, plus Jedi, pyflakes and Black. Packages load lazily
the first time a program imports them. matplotlib uses the Agg backend and
`plt.show()` renders the figure inline in the output panel (click to toggle
full size). Any figure still open when the program ends is shown too.

To change the bundled set, edit `DEFAULT_PACKAGES` in
`tools/pack/build-pack.mjs` or run `node tools/pack/build-pack.mjs --packages numpy,pandas`.
Anything in the Pyodide distribution for the pinned version works; wheels are
downloaded once into `tools/pack/cache/`. There is no network at runtime, so
`pip install` and micropip do not work.

### Apps that block WebAssembly
Some apps (Discord, Slack, VS Code and others) ship a Content-Security-Policy
that forbids WebAssembly, so Pyodide cannot load. The DevTools console exemption
does **not** cover WebAssembly, and where the policy is injected by the app's own
process on a `file://` page, not even DevTools Local Overrides can lift it
(see the experiments in `tools/host-app/`).

The editor handles this by itself: it falls back to a **Python interpreter
written in JavaScript** that lives inside `crazy.js`. Nothing extra to download,
no runtime pack to pick, no permissions. The status bar reads
`Python 3.12 (built-in)` and "Help: About the built-in interpreter" explains the
differences.

| | Pyodide (normal) | Built-in interpreter |
|---|---|---|
| Needs | `crazy-runtime.pack`, WebAssembly | nothing but the paste |
| `input()` | replays the program with your answers | pauses the program properly |
| Stop | restarts the interpreter | immediate |
| NumPy, matplotlib | yes | no (they are compiled C) |
| Black formatting, 1-line button | yes | no |
| Speed | near CPython | slower, fine for teaching-sized work |

The built-in interpreter covers unlimited-size integers, strings and f-strings,
lists/tuples/dicts/sets, slicing, comprehensions, loops, functions with
defaults/`*args`/`**kwargs`, closures, lambdas, classes with inheritance,
`super()`, properties and dunder methods, exceptions, generators, `with`,
decorators, file reading and writing in your project, and importing your own
modules. Bundled modules: `math`, `random`, `json`, `time`, `sys`, `os`,
`string`, `itertools`, `functools`, `collections`, `statistics`, `copy`, `re`,
`heapq`, `bisect`, `datetime`. Not supported: `async`/`await` and complex
numbers.

Its source is in [src/pyjs/](src/pyjs/) (tokenizer, parser, object model,
generator-based evaluator, stdlib). `node tools/test-pyjs.mjs` runs it against a
suite of programs and compares output with CPython's;
`node tools/pyjs-run.mjs -c "print(1+1)"` runs a snippet.

#### Getting full CPython in a locked app anyway (optional)
If you want NumPy in such an app and have Node.js installed, `attach.mjs` in the
release folder clears the policy over the DevTools protocol: quit the app, start
it with `--remote-debugging-port=9222`, then run `node attach.mjs`. It reloads
the page once and starts the editor with no pasting. This needs Node, so it is
not the default path; the built-in interpreter is the self-contained one.

### The 1-line button
For fun, the toolbar's **1-line** button (or "Fun: Compile current file into one
line" in the palette) writes `<name>_oneline.py`: the same program on a single
physical line. It is a real rewrite, not a wrapper. Top-level simple statements
are joined with `;`, and compound statements become expressions: assignments
turn into walrus / `setattr` / `__setitem__`, `if` into a conditional
expression, `for` into a list comprehension, `while` into a comprehension over
`iter(lambda: bool(cond), False)`, `def` into a lambda (early returns become
nested conditionals), `class` into `type(...)`, `raise` into the
`(_ for _ in ()).throw(...)` trick. Whatever it cannot express (`try`, `with`,
generators, `break`/`continue`, `global`) is wrapped in `exec("...")` for just
that statement, and the toast tells you which ones. Run the result to check it
behaves the same.

### How `input()` works
A default Electron renderer has no `SharedArrayBuffer`, so a running program cannot pause for input. When your program calls `input()` and no answer is available yet, the run stops, an inline prompt appears in the output, and after you answer the program is replayed from the start with all answers so far. Output that was already shown is suppressed, and `random` is seeded per run so replays are identical. Where a host does expose `SharedArrayBuffer`, `input()` blocks for real instead. The status bar shows which mode is active.

### Keyboard shortcuts
| Keys | Action |
|---|---|
| F5 / Ctrl+Enter | Run current file |
| Ctrl+S / Ctrl+Shift+S | Save / save all |
| Ctrl+P / Ctrl+Shift+P | Quick open / command palette |
| Ctrl+Space | Trigger completion |
| Shift+Alt+F | Format with Black |
| F12 | Go to definition |
| Ctrl+/ | Toggle comment |
| Alt+Up/Down, Shift+Alt+Up/Down | Move / copy line |
| Ctrl+D | Select next occurrence |
| Ctrl+B / Ctrl+J | Toggle sidebar / bottom panel |
| Ctrl+\` | Focus REPL |
| Ctrl+N / F2 / Ctrl+Alt+W | New file / rename / close tab |
| Ctrl+, | Settings |
| Ctrl+K Ctrl+T | Pick editor theme |

Ctrl+W and Ctrl+R are left alone because Electron's own menu usually owns them (close window, reload).

## Developing

```
npm install
npm run build          # dist/crazy.js (the paste)
npm run pack           # dist/crazy-runtime.pack (Pyodide + bundled wheels)
npm run host           # throwaway Electron host, paste manually into its console
npm run host:inject    # same, but auto-injects crazy.js and serves the pack (no dialog)
npm run smoke          # headless end-to-end check, exit 0 on pass
npm run host:csp       # strict-CSP host variant
npm run host:node      # nodeIntegration host variant
npm run release        # dist/CrazyCodeEditor-<version>.zip
```

Bundled wheels live in `tools/pack/wheels/`. To refresh them:

```
python -m pip download jedi pyflakes black --only-binary=:all: --python-version 3.12 --implementation py --abi none --platform any --dest tools/pack/wheels
```

## Layout

- `src/boot/` environment probe and the overlay host (an about:blank iframe, so host shortcuts and CSS cannot interfere; shadow DOM fallback)
- `src/runtime/` pack format, IndexedDB cache, pack loader, worker bridge, the Python worker and its Python-side runner/LSP modules
- `src/app/` app orchestration, workspace model, settings, themes
- `src/editor/` CodeMirror setup, completion, lint, hover, keymap
- `src/terminal/` ANSI parser and terminal view
- `src/ui/` layout, tree, tabs, palette, dialogs, REPL, problems, settings panel
- `tools/host-app/` hostile throwaway Electron app used for testing
- `tools/pack/` runtime pack builder
