// Drives the real UI end to end through the __crazyApp test hooks.
// Exit 0 on pass. Used by `npm run smoke` (see main.cjs).
module.exports = async function smoke(win, app, flags) {
  const js = (s) => win.webContents.executeJavaScript(s);
  const A = 'globalThis.__crazyApp';
  const log = (m) => console.log('[smoke] ' + m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (desc, expr, timeoutMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await js(expr)) return;
      await sleep(150);
    }
    throw new Error(`timeout waiting for ${desc}`);
  };
  const check = (cond, what) => {
    if (!cond) throw new Error('FAILED: ' + what);
    log('ok: ' + what);
  };
  try {
    await waitFor('app', `!!${A}`, 15000);
    if (flags.csp || flags.cspheader) {
      // no wasm: the JS interpreter should take over, no pack needed
      await sleep(500);
      if (await js(`${A}.welcomeOpen()`)) await js(`${A}.dismissWelcome()`);
      await waitFor('python ready', `${A}.status() === 'ready'`, 30000);
      check((await js(`${A}.mode()`)) === 'pyjs', 'built-in interpreter took over');
      const prog = [
        'import math',
        'class Greeter:',
        '    def __init__(self, name):',
        '        self.name = name',
        '    def hello(self):',
        '        return f"hi {self.name}"',
        'who = input("Name? ")',
        'print(Greeter(who).hello())',
        'print([x * x for x in range(5)], math.factorial(5), 2 ** 70)',
        'try:',
        '    1 / 0',
        'except ZeroDivisionError as e:',
        '    print("caught", e)',
        '',
      ].join('\n');
      await js(`${A}.setText(${JSON.stringify(prog)})`);
      await js(`${A}.run(); 0`);
      await waitFor('input prompt', `${A}.waitingForInput()`, 20000);
      check((await js(`${A}.terminalText()`)).includes('Name?'), 'input() prompted');
      await js(`${A}.answer("Ada")`);
      await waitFor('run finished', `${A}.status() === 'ready' && ${A}.terminalText().includes('caught')`, 30000);
      const out = await js(`${A}.terminalText()`);
      check(out.includes('hi Ada'), 'classes and f-strings work');
      check(out.includes('[0, 1, 4, 9, 16] 120 1180591620717411303424'), 'comprehensions and big integers work');
      check(out.includes('caught division by zero'), 'exceptions work');
      const comp = await js(`${A}.lsp('complete', {code: 'import math\\nmath.fac', line: 2, col: 8, path: 'main.py'})`);
      check(comp.some((c) => c.name === 'factorial'), 'completion works');
      const lint = await js(`${A}.lsp('lint', {code: 'def f(:\\n', path: 'main.py'})`);
      check(lint.length > 0 && lint[0].msg.includes('SyntaxError'), 'syntax errors reported');
      await js(`${A}.command('pyjsinfo')`);
      await sleep(300);
      check(await js(`${A}.interpreterInfoOpen()`), 'interpreter info page available');
      await js(`${A}.closeDialogs()`);
      log(`PASS (${flags.cspheader ? 'cspheader' : 'csp'}: built-in interpreter, no pack needed)`);
      app.exit(0);
      return;
    }
    if (flags.cspeval) {
      // Workers refused, eval allowed: Python must run on the UI thread.
      await sleep(500);
      if (await js(`${A}.welcomeOpen()`)) await js(`${A}.dismissWelcome()`);
      await waitFor('python ready (main thread)', `${A}.status() === 'ready'`, 120000);
      check((await js(`${A}.mode()`)) === 'main', 'mode is main thread');
      await js(`${A}.setText(${JSON.stringify('name = input("Name? ")\nprint("hi", name)\nimport json\nprint(json.dumps({"ok": True}))\n')})`);
      await js(`${A}.run(); 0`);
      await waitFor('prompt', `${A}.waitingForInput()`, 30000);
      await js(`${A}.answer("Eve")`);
      await waitFor('done', `${A}.status() === 'ready' && ${A}.terminalText().includes('"ok": true')`, 30000);
      check((await js(`${A}.terminalText()`)).includes('hi Eve'), 'input replay on main thread');
      await waitFor('lsp ready', `${A}.lspReady()`, 60000);
      const c = await js(`${A}.lsp('complete', {code: 'import json\\njson.du', line: 2, col: 7, path: 'main.py'})`);
      check(c.some((x) => x.name === 'dumps'), 'completion on main thread');
      await js(`${A}.setText('import time\\nwhile True:\\n    time.sleep(0.01)\\n')`);
      log('watchdog test skipped in smoke (would take 60 s)');
      log('PASS (cspeval: UI-thread mode)');
      app.exit(0);
      return;
    }
    if (flags.nodev) {
      await waitFor('ready', `['ready','starting'].includes(${A}.status())`, 15000);
      const t = await js(`${A}.terminalText()`);
      check(!t.includes('No runtime'), 'pack came from IndexedDB cache');
    }
    // Welcome page shows once per app; dismiss it if present (first run only).
    await sleep(500);
    if (await js(`${A}.welcomeOpen()`)) {
      log('welcome page shown, dismissing');
      await js(`${A}.dismissWelcome()`);
      await waitFor('welcome closed', `!${A}.welcomeOpen()`, 5000);
    }
    await waitFor('python ready', `${A}.status() === 'ready'`, 90000);
    log((await js(`${A}.terminalText()`)).trim().split('\n').pop());
    check((await js(`${A}.packages()`)).includes('numpy'), 'pack declares numpy');

    // 1. plain run
    await js(`${A}.setText(${JSON.stringify('import sys\nprint("Hello from", sys.version.split()[0])\nprint("\\x1b[31mred\\x1b[0m")\n')})`);
    await js(`${A}.run(); 0`);
    await waitFor('run done', `${A}.status() === 'ready' && ${A}.terminalText().includes('finished')`, 30000);
    let out = await js(`${A}.terminalText()`);
    check(out.includes('Hello from 3.'), 'program output');
    check(out.includes('red'), 'ansi text rendered');

    // 2. input() via replay, with random seeded per run
    await js(`${A}.setText(${JSON.stringify('import random\nr = random.randint(1, 1000000)\nname = input("Name? ")\nage = input("Age? ")\nprint("hi", name, age, r)\nr2 = random.randint(1, 1000000)\nprint("again", r == r, r2 >= 1)\n')})`);
    await js(`${A}.run(); 0`);
    await waitFor('first prompt', `${A}.waitingForInput()`, 30000);
    check((await js(`${A}.terminalText()`)).includes('Name?'), 'prompt printed');
    // real key events, not synthetic ones
    for (const ch of 'Bob') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await waitFor('second prompt', `${A}.waitingForInput() && ${A}.terminalText().includes('Age?')`, 30000);
    await js(`${A}.answer("42")`);
    await waitFor('replay done', `${A}.status() === 'ready' && ${A}.terminalText().includes('again')`, 30000);
    out = await js(`${A}.terminalText()`);
    check(out.includes('hi Bob 42'), 'input answers reached the program');
    check((out.match(/Name\?/g) || []).length === 1, 'replayed output was suppressed (prompt printed once)');

    // 3. traceback is clean and clickable
    await js(`${A}.setText(${JSON.stringify('def f():\n    return 1 / 0\nf()\n')})`);
    await js(`${A}.run(); 0`);
    await waitFor('error run done', `${A}.status() === 'ready' && ${A}.terminalText().includes('exited')`, 30000);
    out = await js(`${A}.terminalText()`);
    check(out.includes('ZeroDivisionError') && out.includes('line 2, in f'), 'traceback shown');
    check(!out.includes('_pyodide'), 'internal frames hidden');

    // 4. LSP: completion, lint, format, hover
    await waitFor('lsp ready', `${A}.lspReady()`, 60000);
    const comp = await js(`${A}.lsp('complete', {code: 'import json\\njson.du', line: 2, col: 7, path: 'main.py'})`);
    check(comp.some((c) => c.name === 'dumps'), 'jedi completion');
    const lint = await js(`${A}.lsp('lint', {code: 'import os\\nprint(x)\\n', path: 'main.py'})`);
    check(lint.some((d) => d.msg.includes('undefined name')) && lint.some((d) => d.msg.includes('imported but unused')), 'pyflakes diagnostics');
    const fmt = await js(`${A}.lsp('format', {code: "x = { 'a':1 }\\n", line_length: 88})`);
    check(fmt.code === 'x = {"a": 1}\n', 'black format');
    const hov = await js(`${A}.lsp('hover', {code: 'import json\\njson.dumps', line: 2, col: 6, path: 'main.py'})`);
    check(hov && hov.name === 'dumps' && hov.doc.length > 20, 'hover docs');

    // 5. multi-file import + REPL sharing namespace
    await js(`${A}.writeFile('helper.py', 'def greet(n):\\n    return "hey " + n\\n')`);
    await js(`${A}.openFile('main.py')`);
    await js(`${A}.setText('from helper import greet\\nmsg = greet("there")\\nprint(msg)\\n')`);
    await js(`${A}.run(); 0`);
    await waitFor('import run done', `${A}.status() === 'ready' && ${A}.terminalText().includes('hey there')`, 30000);
    log('ok: cross-file import');
    const r1 = await js(`${A}.repl('msg.upper()')`);
    check(r1.value === "'HEY THERE'", 'repl sees script variables');
    const r2 = await js(`${A}.repl('def g():')`);
    check(r2.status === 'incomplete', 'repl continuation');
    await js(`${A}.repl('    return 5')`);
    const r3 = await js(`${A}.repl('')`);
    check(r3.status === 'complete', 'repl block closed');
    const r4 = await js(`${A}.repl('g() + 1')`);
    check(r4.value === '6', 'repl multi-line def');

    // 6. program writes a file -> appears in workspace
    await js(`${A}.deleteFile('out.txt')`);
    await js(`${A}.setText('open("out.txt", "w").write("written")\\nprint("done")\\n')`);
    await js(`${A}.run(); 0`);
    await waitFor('write run done', `${A}.status() === 'ready' && ${A}.workspace().files.has('out.txt')`, 30000);
    check((await js(`${A}.workspace().files.get('out.txt')`)) === 'written', 'file written by program');

    // 6b. one-liner: rewrite a program with def/class/for/while/if and run it; output must match
    const prog = [
      'import math',
      'from collections import Counter',
      'class Dog:',
      '    sound = "woof"',
      '    def __init__(self, name):',
      '        self.name = name',
      '    def speak(self, times=1):',
      '        return f"{self.name}: " + " ".join([self.sound] * times)',
      'def fact(n):',
      '    if n <= 1:',
      '        return 1',
      '    return n * fact(n - 1)',
      'total = 0',
      'for i in range(5):',
      '    if i % 2 == 0:',
      '        total += i',
      '    else:',
      '        total -= 1',
      'n = 0',
      'while n < 3:',
      '    n += 1',
      'd = {"a": 1}',
      'd["b"] = 2',
      'del d["a"]',
      'try:',
      '    x = 1 / 0',
      'except ZeroDivisionError:',
      '    x = "caught"',
      'print(Dog("Rex").speak(2), fact(5), total, n, d, x, math.floor(2.7), Counter("aab")["a"])',
      'if __name__ == "__main__":',
      '    print("main")',
      '',
    ].join('\n');
    await js(`${A}.writeFile('main.py', ${JSON.stringify(prog)})`);
    await js(`${A}.openFile('main.py')`);
    await js(`${A}.run(); 0`);
    await waitFor('orig run done', `${A}.status() === 'ready' && ${A}.terminalText().includes('Rex: woof woof')`, 30000);
    const origOut = (await js(`${A}.terminalText()`)).split('\n').filter((l) => l.startsWith('Rex:')).pop();
    await js(`${A}.oneline()`);
    await waitFor('oneline file', `${A}.workspace().files.has('main_oneline.py')`, 20000);
    const ol = await js(`${A}.workspace().files.get('main_oneline.py')`);
    check(ol.trim().split('\n').length === 1, 'one-liner is a single line');
    check(!ol.startsWith('exec('), 'one-liner is a real rewrite, not a whole-file exec');
    check((ol.match(/exec\(/g) || []).length === 1, 'only the try/except used an exec() fallback');
    log('one-liner: ' + ol.slice(0, 160) + '…');
    await js(`${A}.run(); 0`);
    await waitFor('oneline run done', `${A}.status() === 'ready' && ${A}.terminalText().split('\\n').filter(l => l.startsWith('Rex:')).length >= 2`, 30000);
    const olOut = (await js(`${A}.terminalText()`)).split('\n').filter((l) => l.startsWith('Rex:')).pop();
    check(origOut === olOut && origOut.includes('120 4 3'), `one-liner output matches original: ${olOut}`);
    check((await js(`${A}.terminalText()`)).split('main').length >= 3, 'main guard preserved');

    // 6c. numpy + matplotlib: lazy package load, inline figure, numpy completion
    await js(`${A}.setText(${JSON.stringify('import numpy as np\nimport matplotlib.pyplot as plt\nx = np.linspace(0, 6, 50)\nplt.plot(x, np.sin(x))\nplt.title("sine")\nplt.show()\nprint("shape", x.shape, float(np.sin(x).max()) > 0.99)\n')})`);
    await js(`${A}.run(); 0`);
    await waitFor('numpy run done', `${A}.status() === 'ready' && ${A}.terminalText().includes('shape (50,) True')`, 180000);
    check((await js(`${A}.images()`)) >= 1, 'matplotlib figure rendered inline');
    const npc = await js(`${A}.lsp('complete', {code: 'import numpy as np\\nnp.lin', line: 2, col: 6, path: 'main.py'})`);
    check(npc.some((c) => c.name === 'linspace'), 'jedi completes numpy after lazy load');

    // 7. stop while running
    await js(`${A}.setText('import time\\nwhile True:\\n    time.sleep(0.05)\\n')`);
    await js(`${A}.run(); 0`);
    await waitFor('running', `${A}.status() === 'running'`, 10000);
    await js(`${A}.stop()`);
    await waitFor('restarted', `${A}.status() === 'ready'`, 60000);
    log('ok: stop restarts interpreter');

    // 8. themes and resize
    await js(`${A}.applySettings({theme: 'Dracula', terminalTheme: 'Monokai'})`);
    const bg = await js(`globalThis.__crazyHost.win.getComputedStyle(globalThis.__crazyHost.root.querySelector('.cm-editor')).backgroundColor`);
    log('host mode: ' + (await js(`globalThis.__crazyHost.mode`)));
    check(bg === 'rgb(40, 42, 54)', 'editor theme applied');
    win.setSize(700, 500);
    await sleep(400);
    const dims = await js(`JSON.stringify([innerWidth, innerHeight, globalThis.__crazyHost.element.getBoundingClientRect().width, globalThis.__crazyHost.element.getBoundingClientRect().height, globalThis.__crazyHost.app.classList.contains('narrow')])`);
    log('resize: ' + dims);
    const [iw, ih, hw, hh] = JSON.parse(dims);
    check(Math.abs(iw - hw) < 2 && Math.abs(ih - hh) < 2, 'overlay follows window size');
    await js(`${A}.applySettings({theme: 'Dark+', terminalTheme: 'Dark+'})`);
    log('PASS');
    app.exit(0);
  } catch (e) {
    console.error('[smoke] ' + e.message);
    try {
      console.error('[smoke] terminal:\n' + (await js(`${A}.terminalText()`)));
    } catch {}
    app.exit(1);
  }
};
