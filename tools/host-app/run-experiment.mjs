// Runs one of the experiment scripts in this folder with a clean environment.
// Usage: node tools/host-app/run-experiment.mjs [csp-experiment.cjs | csp-override-experiment.cjs]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const dir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(dir, process.argv[2] || 'csp-experiment.cjs');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [script], { stdio: 'inherit', env });
child.on('exit', (c) => process.exit(c ?? 1));
