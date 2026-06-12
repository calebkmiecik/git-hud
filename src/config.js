const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  roots: [],
  hotkey: 'Control+Alt+G',
  pollIntervalMs: 20000,
  startVisible: false,
  window: { position: 'top-right', opacity: 0.9 },
  agentPort: 47600,
  // Poll cadence for live usage (each poll is one tiny Haiku call; only while
  // the HUD is visible). Adaptive: usagePollMs when comfortable, ramping down to
  // usagePollHotMs once the closest window crosses hotPct (100% = the floor).
  cost: { enabled: true, usagePollMs: 60000, usagePollHotMs: 10000, hotPct: 85 },
  // Monthly Claude plan/seat cost (USD) for the break-even tracker. 0 = unset
  // (the bar then just shows Kickbacks earnings, no seat-cost comparison).
  plan: { monthlyCost: 0 },
  // Claude usage-allowance display + alert + weekly pacing.
  //   alertPct  — flash/chime when session or weekly crosses this % (0 = off).
  //   pacing    — weekday-weighted "grind / on pace / slow down" call:
  //     weekendWeight 0 = weekdays carry the whole weekly budget (work account);
  //     targetPct = the % of the weekly limit a fully-paced week aims to reach;
  //     bandPct   = +/- tolerance around weekly pace before flipping go/slow;
  //     sessionTargetPct = the % of the 5h session a fully-used window reaches;
  //     sessionBandPct = how far ahead of its time-tick the 5h session may run
  //       before it flags as the binding constraint (EASE OFF).
  usage: { alertPct: 85, pacing: { weekendWeight: 0, targetPct: 90, bandPct: 5, sessionTargetPct: 100, sessionBandPct: 10 } },
};

function applyDefaults(raw) {
  const r = raw || {};
  return {
    roots: Array.isArray(r.roots) ? r.roots : DEFAULTS.roots,
    hotkey: r.hotkey || DEFAULTS.hotkey,
    pollIntervalMs: Number.isFinite(r.pollIntervalMs) ? r.pollIntervalMs : DEFAULTS.pollIntervalMs,
    startVisible: typeof r.startVisible === 'boolean' ? r.startVisible : DEFAULTS.startVisible,
    window: {
      position: r.window?.position || DEFAULTS.window.position,
      opacity: Number.isFinite(r.window?.opacity) ? r.window.opacity : DEFAULTS.window.opacity,
    },
    agentPort: Number.isFinite(r.agentPort) ? r.agentPort : DEFAULTS.agentPort,
    cost: {
      enabled: typeof r.cost?.enabled === 'boolean' ? r.cost.enabled : DEFAULTS.cost.enabled,
      usagePollMs: Number.isFinite(r.cost?.usagePollMs) ? r.cost.usagePollMs : DEFAULTS.cost.usagePollMs,
      usagePollHotMs: Number.isFinite(r.cost?.usagePollHotMs) ? r.cost.usagePollHotMs : DEFAULTS.cost.usagePollHotMs,
      hotPct: Number.isFinite(r.cost?.hotPct) ? r.cost.hotPct : DEFAULTS.cost.hotPct,
    },
    plan: {
      monthlyCost: Number.isFinite(r.plan?.monthlyCost) ? r.plan.monthlyCost : DEFAULTS.plan.monthlyCost,
    },
    usage: {
      alertPct: Number.isFinite(r.usage?.alertPct) ? r.usage.alertPct : DEFAULTS.usage.alertPct,
      pacing: {
        weekendWeight: Number.isFinite(r.usage?.pacing?.weekendWeight) ? r.usage.pacing.weekendWeight : DEFAULTS.usage.pacing.weekendWeight,
        targetPct: Number.isFinite(r.usage?.pacing?.targetPct) ? r.usage.pacing.targetPct : DEFAULTS.usage.pacing.targetPct,
        bandPct: Number.isFinite(r.usage?.pacing?.bandPct) ? r.usage.pacing.bandPct : DEFAULTS.usage.pacing.bandPct,
        sessionTargetPct: Number.isFinite(r.usage?.pacing?.sessionTargetPct) ? r.usage.pacing.sessionTargetPct : DEFAULTS.usage.pacing.sessionTargetPct,
        sessionBandPct: Number.isFinite(r.usage?.pacing?.sessionBandPct) ? r.usage.pacing.sessionBandPct : DEFAULTS.usage.pacing.sessionBandPct,
      },
    },
  };
}

// dir is the writable userData directory (app.getPath('userData')).
// Loads config.json from that directory. Returns { config, error }.
function loadConfig(dir) {
  const file = path.join(dir, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { config: applyDefaults(raw), error: null };
  } catch (e) {
    let reason;
    if (e.code === 'ENOENT') reason = 'config.json not found — using defaults';
    else if (e instanceof SyntaxError) reason = 'config.json malformed — using defaults';
    else reason = 'config.json unreadable — using defaults';
    return { config: applyDefaults({}), error: reason };
  }
}

// Seeds dest from the bundled example when dest is missing. Never throws.
// Returns 'created' | 'exists' | 'failed'. fs is injected for testability.
function ensureConfig({ dest, example, fs: fsImpl = fs }) {
  try {
    if (fsImpl.existsSync(dest)) return 'exists';
    fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
    fsImpl.copyFileSync(example, dest);
    return 'created';
  } catch {
    return 'failed';
  }
}

module.exports = { applyDefaults, loadConfig, ensureConfig, DEFAULTS };
