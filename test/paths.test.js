const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { dataDir, configFile, exampleFile } = require('../src/paths');

test('dataDir delegates to app.getPath(userData)', () => {
  const app = { getPath: (k) => (k === 'userData' ? '/ud' : '/other') };
  assert.equal(dataDir(app), '/ud');
});

test('configFile joins under the data dir', () => {
  assert.equal(configFile('/ud'), path.join('/ud', 'config.json'));
});

test('exampleFile joins under the app dir', () => {
  assert.equal(exampleFile('/app'), path.join('/app', 'config.example.json'));
});
