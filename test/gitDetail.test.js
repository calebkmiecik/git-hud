const { test } = require('node:test');
const assert = require('node:assert');
const { countLines, inProgressLabel } = require('../src/gitDetail');

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
