const { test } = require('node:test');
const assert = require('node:assert');
const { applyDefaults, ensureConfig } = require('../src/config');

test('applyDefaults fills missing fields', () => {
  const c = applyDefaults({ roots: ['/a'] });
  assert.deepEqual(c.roots, ['/a']);
  assert.equal(c.hotkey, 'Control+Alt+G');
  assert.equal(c.pollIntervalMs, 20000);
  assert.equal(c.startVisible, false);
  assert.equal(c.window.position, 'top-right');
  assert.equal(c.window.opacity, 0.9);
});

test('applyDefaults preserves provided values', () => {
  const c = applyDefaults({ roots: [], hotkey: 'F8', pollIntervalMs: 5000,
    startVisible: true, window: { position: 'bottom-left', opacity: 0.5 } });
  assert.equal(c.hotkey, 'F8');
  assert.equal(c.pollIntervalMs, 5000);
  assert.equal(c.startVisible, true);
  assert.equal(c.window.position, 'bottom-left');
  assert.equal(c.window.opacity, 0.5);
});

test('applyDefaults coerces missing roots to empty array', () => {
  const c = applyDefaults({});
  assert.deepEqual(c.roots, []);
});

test('ensureConfig copies the example when dest is missing', () => {
  const calls = [];
  const fakeFs = {
    existsSync: () => false,
    copyFileSync: (a, b) => calls.push([a, b]),
  };
  const r = ensureConfig({ dest: '/ud/config.json', example: '/app/config.example.json', fs: fakeFs });
  assert.equal(r, 'created');
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
  const fakeFs = { existsSync: () => false, copyFileSync: () => { throw new Error('EACCES'); } };
  const r = ensureConfig({ dest: '/ud/config.json', example: '/app/config.example.json', fs: fakeFs });
  assert.equal(r, 'failed');
});
