const { test } = require('node:test');
const assert = require('node:assert');
const { countLines, inProgressLabel, pickBaseBranch, parseReflogParent } = require('../src/gitDetail');

test('countLines counts non-empty lines', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one'), 1);
  assert.equal(countLines('a\nb\nc\n'), 3);
  assert.equal(countLines('  \n\n\t\n'), 0);
  assert.equal(countLines('x\n\ny\n'), 2);
});

test('inProgressLabel prefers rebase, then merge, then cherry-pick, then revert', () => {
  assert.equal(inProgressLabel({ rebaseMerge: true, mergeHead: true }), 'rebase');
  assert.equal(inProgressLabel({ rebaseApply: true }), 'rebase');
  assert.equal(inProgressLabel({ mergeHead: true, cherryPick: true }), 'merge');
  assert.equal(inProgressLabel({ cherryPick: true }), 'cherry-pick');
  assert.equal(inProgressLabel({ revertHead: true }), 'revert');
});

test('inProgressLabel returns null when no operation is in progress', () => {
  assert.equal(inProgressLabel({}), null);
  assert.equal(inProgressLabel({ rebaseMerge: false, mergeHead: false }), null);
});

test('pickBaseBranch picks the most recent divergence (smallest ahead)', () => {
  assert.equal(pickBaseBranch([
    { ref: 'master', ahead: 12, local: 1, mainish: 1 },
    { ref: 'develop', ahead: 3, local: 1, mainish: 1 },
  ]), 'develop');
});

test('pickBaseBranch breaks ties toward main-ish, then local, then shorter', () => {
  // equal ahead: develop (main-ish) beats a feature branch
  assert.equal(pickBaseBranch([
    { ref: 'feature/x', ahead: 3, local: 1, mainish: 0 },
    { ref: 'develop', ahead: 3, local: 1, mainish: 1 },
  ]), 'develop');
  // equal ahead, neither main-ish: local beats remote
  assert.equal(pickBaseBranch([
    { ref: 'origin/feat', ahead: 2, local: 0, mainish: 0 },
    { ref: 'feat', ahead: 2, local: 1, mainish: 0 },
  ]), 'feat');
});

test('pickBaseBranch returns null when there are no candidates', () => {
  assert.equal(pickBaseBranch([]), null);
});

test('parseReflogParent finds the creation source (earliest "moving … to current")', () => {
  // reflog is newest-first; the creation entry is the earliest (bottom).
  const log = [
    'commit: more work',
    'checkout: moving from develop to feature/x',  // later re-checkout
    'checkout: moving from feature/x to develop',
    'commit: initial work',
    'checkout: moving from develop to feature/x',  // creation (earliest)
  ].join('\n');
  assert.equal(parseReflogParent(log, 'feature/x'), 'develop');
});

test('parseReflogParent returns null when forked from a detached SHA', () => {
  assert.equal(parseReflogParent('checkout: moving from a1b2c3d to feature/x', 'feature/x'), null);
});

test('parseReflogParent returns null with no creation record', () => {
  assert.equal(parseReflogParent('commit: x\ncommit: y', 'feature/x'), null);
});
