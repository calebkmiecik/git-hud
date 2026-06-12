#!/usr/bin/env node
// One-off setup: point Claude Code's statusLine at git-hud's usage forwarder so
// session/weekly allowance % flows to the overlay. Idempotent and preserves all
// existing settings (read → set one key → write). Run: node scripts/wire-statusline.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const file = path.join(os.homedir(), '.claude', 'settings.json');
const forwarder = path.join(__dirname, 'statusline-usage.js');
const command = `node "${forwarder}"`;

const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const before = JSON.stringify(j.statusLine);
j.statusLine = { type: 'command', command };
if (JSON.stringify(j.statusLine) === before) { console.log('statusLine already wired — no change'); process.exit(0); }
fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
console.log('statusLine wired ->', command);
