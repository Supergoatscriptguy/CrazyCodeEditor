// Builds dist/crazy.js as one pasteable IIFE. The worker is embedded as a string.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const pyodidePkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/pyodide/package.json'), 'utf8'));
const pyodideJs = fs.readFileSync(path.join(root, 'node_modules/pyodide/pyodide.js'), 'utf8');

const common = {
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  minify: !dev,
  sourcemap: false,
  legalComments: 'none',
  loader: { '.py': 'text' },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    __PYODIDE_VERSION__: JSON.stringify(pyodidePkg.version),
  },
};

async function buildWorker() {
  const r = await esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src/runtime/worker.ts')],
    write: false,
    // pyodide.js is a UMD build that defines globalThis.loadPyodide; prepend it verbatim.
    banner: { js: pyodideJs },
  });
  return r.outputFiles[0].text;
}

const workerPlugin = {
  name: 'virtual-sources',
  setup(b) {
    b.onResolve({ filter: /^virtual:(worker|pyodide-js)$/ }, (a) => ({ path: a.path, namespace: 'virtual' }));
    b.onLoad({ filter: /^virtual:worker$/, namespace: 'virtual' }, async () => ({
      contents: `export default ${JSON.stringify(await buildWorker())};`,
      loader: 'js',
      watchFiles: ['worker.ts', 'core.ts', 'protocol.ts', 'python/runtime.py', 'python/lsp.py', 'python/oneline.py'].map((f) => path.join(root, 'src/runtime', f)),
    }));
    b.onLoad({ filter: /^virtual:pyodide-js$/, namespace: 'virtual' }, () => ({
      contents: `export default ${JSON.stringify(pyodideJs)};`,
      loader: 'js',
    }));
  },
};

const mainOpts = {
  ...common,
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile: path.join(root, 'dist/crazy.js'),
  plugins: [workerPlugin],
  logLevel: 'info',
};

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
if (watch) {
  const ctx = await esbuild.context(mainOpts);
  await ctx.watch();
  console.log('watching...');
} else {
  await esbuild.build(mainOpts);
  assertAscii(mainOpts.outfile);
  const size = fs.statSync(mainOpts.outfile).size;
  console.log(`dist/crazy.js: ${(size / 1024).toFixed(0)} KB`);
}

// The bundle travels through clipboards, so keep it ASCII. esbuild escapes
// strings but not regex literals; a raw U+FFFF in one broke a paste.
function assertAscii(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = new Map();
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 126 && !found.has(code)) found.set(code, text.slice(Math.max(0, i - 40), i + 20));
  }
  if (!found.size) return;
  console.error(`\n${file} contains ${found.size} non-ASCII character(s); write them as \\u escapes:`);
  for (const [code, context] of found) {
    console.error(`  U+${code.toString(16).toUpperCase().padStart(4, '0')} near: ${JSON.stringify(context)}`);
  }
  process.exit(1);
}
