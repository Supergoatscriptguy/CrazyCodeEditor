// Builds dist/crazy-runtime.pack: Pyodide core, wheels from tools/pack/wheels/,
// and Pyodide-distribution packages resolved from pyodide-lock.json.
//
// Usage: node tools/pack/build-pack.mjs [--packages numpy,matplotlib] [--no-packages]
//
// Pack format (CCEPACK1):
//   bytes 0..8   ASCII magic "CCEPACK1"
//   bytes 8..    gzip stream of:
//                  uint32 LE  index length
//                  index      JSON { format, version, pyodide, packages, files: { name: [offset, length] } }
//                  blobs      concatenated file bytes; offsets are relative to the end of the index
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const pyodideDir = path.join(root, 'node_modules/pyodide');
const pyodideVersion = JSON.parse(fs.readFileSync(path.join(pyodideDir, 'package.json'), 'utf8')).version;
const lock = JSON.parse(fs.readFileSync(path.join(pyodideDir, 'pyodide-lock.json'), 'utf8'));

const args = process.argv.slice(2);
const DEFAULT_PACKAGES = ['numpy', 'matplotlib'];
let wanted = DEFAULT_PACKAGES;
const pi = args.indexOf('--packages');
if (pi !== -1) wanted = args[pi + 1].split(',').map((s) => s.trim()).filter(Boolean);
if (args.includes('--no-packages')) wanted = [];

// Resolve transitive dependencies from the lock file.
const resolved = new Map();
const visit = (name) => {
  const key = name.toLowerCase().replace(/_/g, '-');
  const entry = lock.packages[key] ?? Object.values(lock.packages).find((p) => p.name.toLowerCase() === key);
  if (!entry) throw new Error(`Package "${name}" is not in the Pyodide ${pyodideVersion} distribution`);
  if (resolved.has(entry.name)) return;
  resolved.set(entry.name, entry);
  for (const d of entry.depends) visit(d);
};
for (const w of wanted) visit(w);

const cacheDir = path.join(root, 'tools/pack/cache', pyodideVersion);
fs.mkdirSync(cacheDir, { recursive: true });
const CDN = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/`;

async function fetchPackage(entry) {
  const dest = path.join(cacheDir, entry.file_name);
  if (fs.existsSync(dest)) return fs.readFileSync(dest);
  const url = CDN + entry.file_name;
  process.stdout.write(`  downloading ${entry.file_name} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, data);
  console.log(`${(data.length / 1024).toFixed(0)} KB`);
  return data;
}

const entries = [];
for (const name of ['pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  entries.push({ name, data: fs.readFileSync(path.join(pyodideDir, name)) });
}
const wheelsDir = path.join(root, 'tools/pack/wheels');
if (fs.existsSync(wheelsDir)) {
  for (const f of fs.readdirSync(wheelsDir).filter((f) => f.endsWith('.whl')).sort()) {
    entries.push({ name: `wheels/${f}`, data: fs.readFileSync(path.join(wheelsDir, f)) });
  }
}
// stored under the exact file name loadPackage() will request
for (const entry of [...resolved.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  entries.push({ name: entry.file_name, data: await fetchPackage(entry) });
}

let offset = 0;
const files = {};
for (const e of entries) {
  files[e.name] = [offset, e.data.length];
  offset += e.data.length;
}
const index = Buffer.from(JSON.stringify({ format: 1, version: pkg.version, pyodide: pyodideVersion, packages: [...resolved.keys()].sort(), requested: wanted, files }), 'utf8');
const header = Buffer.alloc(4);
header.writeUInt32LE(index.length, 0);
const payload = Buffer.concat([header, index, ...entries.map((e) => e.data)]);
const gz = zlib.gzipSync(payload, { level: 9 });
const out = Buffer.concat([Buffer.from('CCEPACK1', 'ascii'), gz]);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const outPath = path.join(root, 'dist/crazy-runtime.pack');
fs.writeFileSync(outPath, out);
for (const e of entries) console.log(`  ${e.name.padEnd(56)} ${(e.data.length / 1024).toFixed(0).padStart(7)} KB`);
console.log(`packages: ${[...resolved.keys()].sort().join(', ') || 'none'}`);
console.log(`dist/crazy-runtime.pack: ${(payload.length / 1048576).toFixed(1)} MB raw -> ${(out.length / 1048576).toFixed(1)} MB gzipped`);
