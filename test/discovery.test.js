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

test('discoverRepos finds nested repos including repos inside repos, skips node_modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'githud-'));
  mkRepo(path.join(root, 'repoA'));
  mkRepo(path.join(root, 'sub', 'repoB'));
  mkRepo(path.join(root, 'sub', 'deeper', 'repoC'));
  mkRepo(path.join(root, 'node_modules', 'ignored'));       // should be skipped
  mkRepo(path.join(root, 'repoA', 'nested'));               // repo directly inside a repo → found
  // superproject pattern (AxioStack): a repo holding a plain dir that holds repos
  mkRepo(path.join(root, 'super'));
  mkRepo(path.join(root, 'super', 'group', 'repoD'));

  const [{ repos }] = discoverRepos([root]);
  const found = repos.map(p => path.relative(root, p).replace(/\\/g, '/')).sort();

  assert.deepEqual(found, [
    'repoA', 'repoA/nested', 'sub/deeper/repoC', 'sub/repoB', 'super', 'super/group/repoD',
  ]);

  fs.rmSync(root, { recursive: true, force: true });
});
