const { test } = require('node:test');
const assert = require('node:assert');
const { githubUrlFromRemote, resolveOpenCommand } = require('../src/open');

test('githubUrlFromRemote handles scp-style ssh remotes', () => {
  assert.equal(
    githubUrlFromRemote('git@github.com:caleb/git-hud.git'),
    'https://github.com/caleb/git-hud'
  );
  assert.equal(
    githubUrlFromRemote('git@github.com:caleb/git-hud'),
    'https://github.com/caleb/git-hud'
  );
});

test('githubUrlFromRemote handles ss:// remotes', () => {
  assert.equal(
    githubUrlFromRemote('ssh://git@github.com/caleb/git-hud.git'),
    'https://github.com/caleb/git-hud'
  );
});

test('githubUrlFromRemote handles https remotes', () => {
  assert.equal(
    githubUrlFromRemote('https://github.com/caleb/git-hud.git'),
    'https://github.com/caleb/git-hud'
  );
  assert.equal(
    githubUrlFromRemote('https://gitlab.com/caleb/git-hud'),
    'https://gitlab.com/caleb/git-hud'
  );
});

test('githubUrlFromRemote returns null for empty or unrecognizable input', () => {
  assert.equal(githubUrlFromRemote(''), null);
  assert.equal(githubUrlFromRemote(null), null);
  assert.equal(githubUrlFromRemote('not a url'), null);
});

test('resolveOpenCommand maps editor and terminal targets', () => {
  assert.deepEqual(resolveOpenCommand('editor', 'C:\\repo'), { cmd: 'code', args: ['C:\\repo'] });
  assert.deepEqual(resolveOpenCommand('terminal', 'C:\\repo'), { cmd: 'wt', args: ['-d', 'C:\\repo'] });
});

test('resolveOpenCommand returns null for shell-handled or unknown targets', () => {
  assert.equal(resolveOpenCommand('explorer', 'C:\\repo'), null);
  assert.equal(resolveOpenCommand('github', 'C:\\repo'), null);
  assert.equal(resolveOpenCommand('bogus', 'C:\\repo'), null);
});
