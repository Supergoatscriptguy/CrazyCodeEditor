// Builds the release and copies it to the flash drive for testing.
// Usage: node tools/deploy.mjs [target]   (default target: L:\)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const target = process.argv[2] || process.env.CRAZY_DEPLOY_DIR || 'L:\\';

if (!fs.existsSync(target)) {
  console.error(`deploy target ${target} not found (is the drive plugged in?)`);
  process.exit(1);
}

execFileSync(process.execPath, [path.join(root, 'tools/release.mjs')], { stdio: 'inherit' });

const zipName = `CrazyCodeEditor-${pkg.version}.zip`;
const stage = path.join(root, 'dist/CrazyCodeEditor');
const destDir = path.join(target, 'CrazyCodeEditor');
// start clean
fs.rmSync(destDir, { recursive: true, force: true });
fs.mkdirSync(destDir, { recursive: true });
for (const f of fs.readdirSync(stage)) fs.copyFileSync(path.join(stage, f), path.join(destDir, f));
// Remove stale zips of other versions, then copy the current one.
for (const f of fs.readdirSync(target)) if (/^CrazyCodeEditor-.*\.zip$/.test(f) && f !== zipName) fs.rmSync(path.join(target, f));
fs.copyFileSync(path.join(root, 'dist', zipName), path.join(target, zipName));

const same = fs.readFileSync(path.join(root, 'dist', zipName)).equals(fs.readFileSync(path.join(target, zipName)));
console.log(`deployed to ${destDir} and ${path.join(target, zipName)} ${same ? '(verified)' : '(VERIFY FAILED)'}`);
process.exit(same ? 0 : 1);
