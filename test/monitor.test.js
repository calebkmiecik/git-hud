const { test } = require('node:test');
const assert = require('node:assert');
const { RepoMonitor } = require('../src/monitor');

test('debounce coalesces rapid triggers into one refresh', async () => {
  let calls = 0;
  const m = new RepoMonitor('/fake', {
    debounceMs: 10,
    getState: async () => { calls++; return { path: '/fake' }; },
  });
  let updates = 0;
  m.onChange = () => { updates++; };

  // fire 5 triggers within the debounce window
  m._trigger(); m._trigger(); m._trigger(); m._trigger(); m._trigger();
  await new Promise(r => setTimeout(r, 40));

  assert.equal(calls, 1, 'getState called once');
  assert.equal(updates, 1, 'onChange fired once');
});
