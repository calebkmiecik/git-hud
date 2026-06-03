const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverRepos } = require('../src/discovery');

function mkRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
}

test('discoverRepos finds nested repos, stops at repo boundary, skips node_modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'githud-'));
  mkRepo(path.join(root, 'repoA'));
  mkRepo(path.join(root, 'sub', 'repoB'));
  mkRepo(path.join(root, 'sub', 'deeper', 'repoC'));
  mkRepo(path.join(root, 'node_modules', 'ignored'));   // should be skipped
  mkRepo(path.join(root, 'repoA', 'nested'));            // inside a repo → not descended

  const [{ repos }] = discoverRepos([root]);
  const found = repos.map(p => path.relative(root, p).replace(/\\/g, '/')).sort();

  assert.deepEqual(found, ['repoA', 'sub/deeper/repoC', 'sub/repoB']);

  fs.rmSync(root, { recursive: true, force: true });
});
