const { test } = require('node:test');
const assert = require('node:assert');
const { parseBranch, parseDirty, parseChangedCount, parseCommitTime, parseAheadBehind } = require('../src/git');

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

test('parseAheadBehind null when non-numeric (NaN guard)', () => {
  assert.equal(parseAheadBehind('foo\tbar\n'), null);
});

test('parseChangedCount counts one line per changed path', () => {
  assert.equal(parseChangedCount(' M src/a.js\n?? b.txt\n M src/c.js\n'), 3);
});

test('parseChangedCount is 0 for a clean tree', () => {
  assert.equal(parseChangedCount(''), 0);
  assert.equal(parseChangedCount('\n  \n'), 0);
});

test('parseChangedCount tolerates CRLF', () => {
  assert.equal(parseChangedCount(' M a\r\n?? b\r\n'), 2);
});

test('parseCommitTime reads unix seconds', () => {
  assert.equal(parseCommitTime('1717171717\n'), 1717171717);
});

test('parseCommitTime returns null for an empty repo or junk', () => {
  assert.equal(parseCommitTime(''), null);
  assert.equal(parseCommitTime('nope'), null);
  assert.equal(parseCommitTime('0'), null);
});
