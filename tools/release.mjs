// Builds dist/CrazyCodeEditor-<version>.zip, the portable folder.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'CrazyCodeEditor');

execFileSync(process.execPath, [path.join(root, 'tools/build.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'tools/pack/build-pack.mjs')], { stdio: 'inherit' });

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(path.join(dist, 'crazy.js'), path.join(stage, 'crazy.js'));
fs.copyFileSync(path.join(dist, 'crazy-runtime.pack'), path.join(stage, 'crazy-runtime.pack'));
fs.copyFileSync(path.join(root, 'tools/attach.mjs'), path.join(stage, 'attach.mjs'));
fs.writeFileSync(
  path.join(stage, 'README.txt'),
  `CrazyCodeEditor v${pkg.version} - portable Python IDE for any Electron app

NORMAL WAY (no installs needed)

1. Open the Electron app and its DevTools console (usually Ctrl+Shift+I, then the
   Console tab).
2. Open crazy.js in any text editor, select all, copy, paste into the console,
   press Enter.
3. When asked, choose crazy-runtime.pack from this folder. Each app only asks
   once; after that it remembers the runtime.

IF THE APP BLOCKS WEBASSEMBLY

Some apps forbid WebAssembly in their security policy, so the real CPython
build cannot load. You do not have to do anything: the editor falls back to its
own Python interpreter, built into crazy.js. The status bar will read
"Python 3.12 (built-in)" and everyday Python works, including input(), classes,
generators and file handling. NumPy, matplotlib, Black formatting and the
1-line button are the parts that need full CPython.

"Help: About the built-in interpreter" in the command palette (Ctrl+Shift+P)
lists exactly what differs.

OPTIONAL: FULL CPYTHON IN A LOCKED APP

Only if you want NumPy there and have Node.js installed. Quit the app, then:

    & "C:\\Path\\To\\TheApp.exe" --remote-debugging-port=9222
    node attach.mjs

That clears the policy for the page, reloads it once and starts the editor with
no pasting. While the port is open any program on the computer can control that
app, so close and reopen it normally when done.

Nothing is written to this folder. Your files are kept inside the app's local
storage and can be exported as a zip from the editor.

crazy.js and crazy-runtime.pack must come from the same download (v${pkg.version}).
`,
);

const zipPath = path.join(dist, `CrazyCodeEditor-${pkg.version}.zip`);
fs.rmSync(zipPath, { force: true });
// Use the platform zipper: PowerShell on Windows, zip elsewhere.
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}' -DestinationPath '${zipPath}' -CompressionLevel Optimal`], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-r', '-9', zipPath, 'CrazyCodeEditor'], { cwd: dist, stdio: 'inherit' });
}
console.log(`${zipPath}: ${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB`);
