// Runs a snippet through the JS interpreter, with a step cap.
//   node tools/pyjs-run.mjs -c "print(1+1)"
//   node tools/pyjs-run.mjs script.py
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pyjs-')), 'pyjs.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/pyjs/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile: outFile,
  logLevel: 'error',
});
const { PyJsRuntime } = await import(pathToFileURL(outFile).href);

const args = process.argv.slice(2);
const code = args[0] === '-c' ? args[1] : fs.readFileSync(args[0], 'utf8');
const inputs = args.slice(args[0] === '-c' ? 2 : 1);
const MAX_SLICES = Number(process.env.PYJS_MAX_SLICES ?? 500);

let slices = 0;
const rt = new PyJsRuntime({
  write: (text) => process.stdout.write(text),
  requestInput: async (prompt) => {
    process.stdout.write(prompt);
    const v = inputs.length ? inputs.shift() : null;
    process.stdout.write((v ?? '^D') + '\n');
    return v;
  },
  yieldToUi: async () => {
    if (++slices > MAX_SLICES) {
      console.error(`\n[aborted after ${slices} slices — likely an unbounded loop]`);
      rt.stop();
    }
    await new Promise((r) => setImmediate(r));
  },
});
rt.setFiles({ 'main.py': code });
const t0 = Date.now();
const result = await rt.run(code, 'main.py');
console.error(`\n[exit ${result.exit} in ${Date.now() - t0} ms, ${slices} slices]`);
