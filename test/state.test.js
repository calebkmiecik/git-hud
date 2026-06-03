const { test } = require('node:test');
const assert = require('node:assert');
const { isEnabled, setEnabled } = require('../src/state');

test('isEnabled is opt-in: unknown repo is false', () => {
  assert.equal(isEnabled({ enabled: {} }, '/a'), false);
  assert.equal(isEnabled({}, '/a'), false);
});

test('isEnabled true only when explicitly true', () => {
  assert.equal(isEnabled({ enabled: { '/a': true } }, '/a'), true);
});

test('setEnabled adds and removes', () => {
  const s = { enabled: {} };
  setEnabled(s, '/a', true);
  assert.equal(s.enabled['/a'], true);
  setEnabled(s, '/a', false);
  assert.equal('/a' in s.enabled, false);
});
