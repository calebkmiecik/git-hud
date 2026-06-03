const { test } = require('node:test');
const assert = require('node:assert');
const { applyDefaults } = require('../src/config');

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
