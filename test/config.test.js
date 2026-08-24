const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyDefaults, ensureConfig, loadConfig } = require('../src/config');

test('applyDefaults fills missing fields', () => {
  const c = applyDefaults({ roots: ['/a'] });
  assert.deepEqual(c.roots, ['/a']);
  assert.equal(c.hotkey, 'Control+Alt+G');
  assert.equal(c.pollIntervalMs, 20000);
  assert.equal(c.startVisible, false);
  assert.equal(c.window.opacity, 1);
  assert.equal(c.agentPort, 47600);
  // The panel is anchored to the strip's corner and can't be moved, so its
  // placement comes from strip.corner rather than a window position.
  assert.equal(c.strip.corner, 'bottom-left');
  assert.equal(c.strip.style, 'dials');
});

test('applyDefaults preserves provided values', () => {
  const c = applyDefaults({ roots: [], hotkey: 'F8', pollIntervalMs: 5000,
    startVisible: true, window: { opacity: 0.5 }, agentPort: 5050,
    strip: { corner: 'bottom-right', style: 'bars', width: 400 } });
  assert.equal(c.hotkey, 'F8');
  assert.equal(c.pollIntervalMs, 5000);
  assert.equal(c.startVisible, true);
  assert.equal(c.window.opacity, 0.5);
  assert.equal(c.agentPort, 5050);
  assert.equal(c.strip.corner, 'bottom-right');
  assert.equal(c.strip.style, 'bars');
  assert.equal(c.strip.width, 400);
});

test('applyDefaults coerces missing roots to empty array', () => {
  const c = applyDefaults({});
  assert.deepEqual(c.roots, []);
});

// A UTF-8 BOM is what Notepad and PowerShell's `Set-Content -Encoding utf8`
// leave behind. JSON.parse rejects it, which silently reverted every setting to
// its default and reported only "config.json malformed".
test('loadConfig parses a config saved with a UTF-8 BOM', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githud-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'),
      '﻿' + JSON.stringify({ hotkey: 'F9', plan: { monthlyCost: 125 } }), 'utf8');
    const { config, error } = loadConfig(dir);
    assert.equal(error, null);
    assert.equal(config.hotkey, 'F9');
    assert.equal(config.plan.monthlyCost, 125);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig still reports genuinely malformed json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githud-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json', 'utf8');
    const { config, error } = loadConfig(dir);
    assert.match(error, /malformed/);
    assert.equal(config.hotkey, 'Control+Alt+G'); // fell back to defaults
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConfig copies the example when dest is missing', () => {
  const calls = [];
  const mkdirs = [];
  const fakeFs = {
    existsSync: () => false,
    mkdirSync: (d, opts) => mkdirs.push([d, opts]),
    copyFileSync: (a, b) => calls.push([a, b]),
  };
  const r = ensureConfig({ dest: '/ud/config.json', example: '/app/config.example.json', fs: fakeFs });
  assert.equal(r, 'created');
  assert.deepEqual(mkdirs, [['/ud', { recursive: true }]]);
  assert.deepEqual(calls, [['/app/config.example.json', '/ud/config.json']]);
});

test('ensureConfig no-ops when dest already exists', () => {
  let copied = false;
  const fakeFs = { existsSync: () => true, copyFileSync: () => { copied = true; } };
  const r = ensureConfig({ dest: '/ud/config.json', example: '/app/config.example.json', fs: fakeFs });
  assert.equal(r, 'exists');
  assert.equal(copied, false);
});

test('ensureConfig returns "failed" without throwing on copy error', () => {
  const fakeFs = {
    existsSync: () => false,
    mkdirSync: () => {},
    copyFileSync: () => { throw new Error('EACCES'); },
  };
  const r = ensureConfig({ dest: '/ud/config.json', example: '/app/config.example.json', fs: fakeFs });
  assert.equal(r, 'failed');
});
