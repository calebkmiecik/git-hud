const { test } = require('node:test');
const assert = require('node:assert');
const { snapshotName, pickBaseline, monthToDate } = require('../src/earningsStore');

test('snapshotName builds <date>.<machine>.json with a sanitized machine', () => {
  assert.equal(snapshotName('2026-06-13', 'Home-PC'), '2026-06-13.home-pc.json');
  assert.equal(snapshotName('2026-06-13', 'Caleb’s Laptop!'), '2026-06-13.caleb-s-laptop.json');
});

test('pickBaseline returns the max lifetime among snapshots before the month', () => {
  const snaps = [
    { date: '2026-05-30', lifetime: 40 },
    { date: '2026-05-31', lifetime: 42 },   // end of last month → the baseline
    { date: '2026-06-02', lifetime: 45 },   // this month → ignored
  ];
  assert.equal(pickBaseline(snaps, '2026-06'), 42);
});

test('pickBaseline returns null when there is no pre-month snapshot', () => {
  assert.equal(pickBaseline([{ date: '2026-06-05', lifetime: 48 }], '2026-06'), null);
  assert.equal(pickBaseline([], '2026-06'), null);
});

test('monthToDate is current_lifetime - baseline when a baseline exists', () => {
  const snaps = [
    { date: '2026-05-31', lifetime: 42 },
    { date: '2026-06-10', lifetime: 60 },
  ];
  assert.equal(monthToDate(snaps, 60, '2026-06'), 18);
});

test('monthToDate falls back to lifetime when there is no prior-month baseline', () => {
  // new account: only this-month snapshots → month-to-date == lifetime so far
  assert.equal(monthToDate([{ date: '2026-06-12', lifetime: 48.52 }], 48.52, '2026-06'), 48.52);
  assert.equal(monthToDate([], 48.52, '2026-06'), 48.52);
});

test('monthToDate returns null when lifetime is unknown, and never goes negative', () => {
  assert.equal(monthToDate([{ date: '2026-05-31', lifetime: 42 }], null, '2026-06'), null);
  // a baseline above current lifetime (shouldn't happen — monotonic) clamps to 0
  assert.equal(monthToDate([{ date: '2026-05-31', lifetime: 50 }], 48, '2026-06'), 0);
});
