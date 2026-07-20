const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ratesFor, usageCost, updateLedger, localDateKey, computePacing, pollDelayFor, parseUsage } = require('../src/costTracker');

test('ratesFor matches model families by substring', () => {
  assert.equal(ratesFor('claude-fable-5').input, 10);
  assert.equal(ratesFor('claude-opus-4-8').input, 5);
  assert.equal(ratesFor('claude-sonnet-4-6').input, 3);
  assert.equal(ratesFor('claude-haiku-4-5').input, 1);
});

test('ratesFor returns null for unknown / synthetic models', () => {
  assert.equal(ratesFor('<synthetic>'), null);
  assert.equal(ratesFor(''), null);
  assert.equal(ratesFor(null), null);
});

test('usageCost prices each token bucket at its rate', () => {
  const rates = ratesFor('claude-opus-4-8'); // 5 / 25 / 6.25 / 10 / 0.5 per 1M
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  };
  // 5 + 25 + 0.5 + 6.25 + 10 = 46.75
  assert.equal(usageCost(usage, rates), 46.75);
});

test('usageCost falls back to 5m rate when no cache breakdown present', () => {
  const rates = ratesFor('claude-opus-4-8');
  const usage = { cache_creation_input_tokens: 1_000_000 }; // no ephemeral breakdown
  assert.equal(usageCost(usage, rates), 6.25); // priced as a 5-minute write
});

test('usageCost is zero with null rates or empty usage', () => {
  assert.equal(usageCost({ input_tokens: 999 }, null), 0);
  assert.equal(usageCost(null, ratesFor('claude-opus-4-8')), 0);
});

test('updateLedger records today and sums only the current month', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghud-ledger-'));
  const today = localDateKey();
  const month = today.slice(0, 7);
  const otherDayThisMonth = `${month}-01` === today ? `${month}-02` : `${month}-01`;
  // Seed: one earlier day this month + one from a prior month (must be excluded).
  fs.writeFileSync(path.join(dir, 'costLedger.json'),
    JSON.stringify({ days: { [otherDayThisMonth]: 5, '2000-01-15': 999 } }));

  const r = updateLedger(dir, 21.41);
  assert.equal(r.monthToDate, 26.41);  // 5 (earlier this month) + 21.41 (today)
  assert.equal(r.trackedDays, otherDayThisMonth === today ? 1 : 2);
});

test('updateLedger keeps the max today_usd seen for a day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghud-ledger-'));
  updateLedger(dir, 3.00);
  const r = updateLedger(dir, 8.50); // later in the same day, higher value
  assert.equal(r.monthToDate, 8.50);
  const r2 = updateLedger(dir, null); // a failed fetch shouldn't zero it out
  assert.equal(r2.monthToDate, 8.50);
});

// Flat weighting (weekendWeight=1) makes pace = clock fraction, so these are
// timezone-independent. reset=7d, start=0, midpoint = 3.5d.
const RESET = 7 * 86400, MID = 3.5 * 86400;
// Weekly-only usage (no session) at the given moment.
const flat = (pct, nowSec) => computePacing(
  { weekly: { pct, resetsAt: RESET, status: 'allowed' } },
  { weekendWeight: 1, targetPct: 90, bandPct: 5, sessionTargetPct: 100, sessionBandPct: 10, nowSec });

test('computePacing: on pace at the band center', () => {
  const p = flat(45, MID); // expected = 0.5 * 90 = 45
  assert.equal(p.state, 'onpace');
  assert.equal(p.binding, 'weekly');
  assert.equal(Math.round(p.expectedPct), 45);
});

test('computePacing: under pace → go', () => {
  assert.equal(flat(30, MID).state, 'go'); // 30 vs 45 → 15 under
});

test('computePacing: over pace → slow (weekly-bound)', () => {
  const p = flat(60, MID); // 60 vs 45 → 15 over
  assert.equal(p.state, 'slow');
  assert.equal(p.binding, 'weekly');
});

test('computePacing: weekly rate-limited → capped', () => {
  const p = computePacing({ weekly: { pct: 5, resetsAt: RESET, status: 'rejected' } },
    { weekendWeight: 1, nowSec: MID });
  assert.equal(p.state, 'capped');
  assert.equal(p.binding, 'weekly');
});

test('computePacing: allowed_warning is NOT capped (near the limit, still usable)', () => {
  // 75% used, server warns — but it should pace by the numbers, not read as "out".
  const p = computePacing({ weekly: { pct: 75, resetsAt: RESET, status: 'allowed_warning' } },
    { weekendWeight: 1, targetPct: 90, bandPct: 5, nowSec: MID }); // expected = 45
  assert.notEqual(p.state, 'capped');
  assert.equal(p.weeklyState, 'slow'); // 75 vs 45 → over pace, but usable
});

test('computePacing: weekdays-only front-loads expected vs flat', () => {
  const w = { weekly: { pct: 50, resetsAt: RESET, status: 'allowed' } };
  const wk = computePacing(w, { weekendWeight: 0, targetPct: 90, nowSec: MID });
  const fl = computePacing(w, { weekendWeight: 1, targetPct: 90, nowSec: MID });
  assert.ok(typeof wk.expectedPct === 'number' && typeof fl.expectedPct === 'number');
  assert.equal(fl.expectedPct, 45);
});

test('pollDelayFor: base below hotPct, ramps to floor at 100%', () => {
  assert.equal(pollDelayFor(50, 60000, 10000, 85), 60000);  // comfortable → base
  assert.equal(pollDelayFor(85, 60000, 10000, 85), 60000);  // exactly at hotPct → base
  assert.equal(pollDelayFor(100, 60000, 10000, 85), 10000); // at the wall → floor
  assert.equal(pollDelayFor(92.5, 60000, 10000, 85), 35000); // halfway → halfway
  assert.equal(pollDelayFor(150, 60000, 10000, 85), 10000); // clamps past 100
});

test('computePacing: null when no weekly data', () => {
  assert.equal(computePacing(null, {}), null);
  assert.equal(computePacing({ weekly: { pct: null, resetsAt: RESET } }, {}), null);
});

// --- session as the binding constraint (position-based: 5h window) ---
// resetsAt = MID + 4h → 1h of the 5h window elapsed → expected = 20% of 100.
const sReset = MID + 4 * 3600;
const sOpts = { weekendWeight: 1, targetPct: 90, bandPct: 5, sessionTargetPct: 100, sessionBandPct: 10, nowSec: MID };

test('computePacing: session ahead of its tick overrides weekly "go" → EASE OFF (session-bound)', () => {
  const p = computePacing({
    weekly: { pct: 30, resetsAt: RESET, status: 'allowed' },          // would be go
    session: { pct: 90, resetsAt: sReset, status: 'allowed' },        // 90% vs ~20% expected → way ahead
  }, sOpts);
  assert.equal(Math.round(p.sessionExpectedPct), 20);
  assert.equal(p.state, 'slow');
  assert.equal(p.binding, 'session');
  assert.equal(p.sessionPct, 90);
});

test('computePacing: session rejected → SESSION CAP (session-bound) when weekly ok', () => {
  const p = computePacing({
    weekly: { pct: 30, resetsAt: RESET, status: 'allowed' },
    session: { pct: 100, resetsAt: sReset, status: 'rejected' },
  }, sOpts);
  assert.equal(p.state, 'capped');
  assert.equal(p.binding, 'session');
});

test('computePacing: session behind its tick leaves weekly verdict intact', () => {
  const p = computePacing({
    weekly: { pct: 30, resetsAt: RESET, status: 'allowed' },
    session: { pct: 10, resetsAt: sReset, status: 'allowed' },        // 10% vs ~20% expected → under
  }, sOpts);
  assert.equal(p.state, 'go');
  assert.equal(p.binding, 'weekly');
  assert.equal(p.sessionState, 'ok');
});

// ---- parseUsage (/api/oauth/usage) ----------------------------------------
// A trimmed copy of a real endpoint response: the three windows live in limits[].
const USAGE_BODY = {
  five_hour: { utilization: 13, resets_at: '2026-07-06T17:30:00.185761+00:00' },
  seven_day: { utilization: 2, resets_at: '2026-07-12T02:00:00.185786+00:00' },
  seven_day_opus: null,
  limits: [
    { kind: 'session', group: 'session', percent: 13, severity: 'normal', resets_at: '2026-07-06T17:30:00.185761+00:00', is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 2, severity: 'normal', resets_at: '2026-07-12T02:00:00.185786+00:00', is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 87, severity: 'warning', resets_at: '2026-07-12T02:00:00.186057+00:00', scope: { model: { display_name: 'Fable' } }, is_active: false },
  ],
};

test('parseUsage maps session / weekly / fable from limits[]', () => {
  const u = parseUsage(USAGE_BODY);
  assert.equal(u.error, null);
  assert.equal(u.session.pct, 13);
  assert.equal(u.weekly.pct, 2);
  assert.equal(u.fable.pct, 87);
  assert.equal(u.fable.model, 'Fable');
  // ISO resets_at → unix seconds
  assert.equal(u.session.resetsAt, Math.floor(Date.parse('2026-07-06T17:30:00.185761+00:00') / 1000));
});

test('parseUsage maps severity → allowed / allowed_warning / rejected (100% = rejected)', () => {
  const u = parseUsage(USAGE_BODY);
  assert.equal(u.session.status, 'allowed');        // severity "normal"
  assert.equal(u.fable.status, 'allowed_warning');  // severity "warning"
  const capped = parseUsage({ limits: [{ kind: 'weekly_scoped', percent: 100, severity: 'normal', scope: { model: { display_name: 'Fable' } } }] });
  assert.equal(capped.fable.status, 'rejected');    // ≥100% always caps
});

test('parseUsage falls back to top-level five_hour / seven_day when limits[] is absent', () => {
  const u = parseUsage({ five_hour: { utilization: 40, resets_at: '2026-07-06T17:30:00Z' }, seven_day: { utilization: 5, resets_at: '2026-07-12T02:00:00Z' } });
  assert.equal(u.session.pct, 40);
  assert.equal(u.weekly.pct, 5);
  assert.equal(u.fable, null);
});

test('parseUsage returns an error object when there are no windows', () => {
  assert.ok(parseUsage({ limits: [] }).error);
  assert.ok(parseUsage(null).error);
});
