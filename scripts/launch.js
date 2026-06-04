#!/usr/bin/env node
// Launches the app for local/dev use.
//
// The VS Code extension host sets ELECTRON_RUN_AS_NODE=1, which makes the
// electron binary behave like plain Node — then require('electron') returns a
// path string and `app` is undefined, crashing on startup. It must be DELETED
// (setting it to '' is not enough; Electron may treat the var as present).
delete process.env.ELECTRON_RUN_AS_NODE;

const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');

const watch = process.argv.includes('--watch');

let bin, args;
if (watch) {
  // electronmon watches main + renderer files and restarts/reloads on change.
  const exe = process.platform === 'win32' ? 'electronmon.cmd' : 'electronmon';
  bin = path.join(__dirname, '..', 'node_modules', '.bin', exe);
  args = [projectRoot];
} else {
  // Under plain Node, require('electron') resolves to the electron exe path.
  bin = require('electron');
  args = [projectRoot];
}

const child = spawn(bin, args, {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32' && watch, // .cmd needs a shell on Windows
});
child.on('error', (err) => {
  console.error(`Failed to launch ${watch ? 'electronmon' : 'electron'}:`, err.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
