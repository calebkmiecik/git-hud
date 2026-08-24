const { test } = require('node:test');
const assert = require('node:assert');
const { isEnabled, setEnabled, isSectionOn, setSectionOn, getSections } = require('../src/state');

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

test('sections default to on when absent, so old state hides nothing', () => {
  assert.equal(isSectionOn({}, 'repos'), true);
  assert.deepEqual(getSections({}), { repos: true, usage: true, kickbacks: true });
});

test('setSectionOn stores only the off state, and clears it again', () => {
  const s = {};
  setSectionOn(s, 'kickbacks', false);
  assert.equal(isSectionOn(s, 'kickbacks'), false);
  assert.deepEqual(s.sections, { kickbacks: false });
  setSectionOn(s, 'kickbacks', true);
  assert.equal(isSectionOn(s, 'kickbacks'), true);
  assert.deepEqual(s.sections, {});
});

test('setSectionOn ignores unknown section keys', () => {
  const s = {};
  setSectionOn(s, 'bogus', false);
  assert.equal(s.sections, undefined);
});
