const { test } = require('node:test');
const assert = require('node:assert');
const { parseBranch, parseDirty, parseAheadBehind } = require('../src/git');

test('parseBranch returns branch name', () => {
  assert.equal(parseBranch('feature/x\n', 'abc1234'), 'feature/x');
});

test('parseBranch returns short SHA when detached (HEAD)', () => {
  const r = parseBranch('HEAD\n', 'abc1234');
  assert.equal(r, 'abc1234');
});

test('parseDirty true when porcelain has output', () => {
  assert.equal(parseDirty(' M src/app.js\n?? new.txt\n'), true);
});

test('parseDirty false when porcelain empty', () => {
  assert.equal(parseDirty('\n'), false);
  assert.equal(parseDirty(''), false);
});

test('parseAheadBehind maps left=behind right=ahead', () => {
  // git prints: behind<TAB>ahead
  assert.deepEqual(parseAheadBehind('1\t2\n'), { behind: 1, ahead: 2 });
});

test('parseAheadBehind null when no upstream (empty)', () => {
  assert.equal(parseAheadBehind(''), null);
});
