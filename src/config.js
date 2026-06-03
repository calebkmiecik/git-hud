const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  roots: [],
  hotkey: 'Control+Alt+G',
  pollIntervalMs: 20000,
  startVisible: false,
  window: { position: 'top-right', opacity: 0.9 },
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
  };
}

// appDir is app.getAppPath() — the project root under `electron .` (dev/unpacked only).
// Loads config.json from the app directory. Returns { config, error }.
function loadConfig(appDir) {
  const file = path.join(appDir, 'config.json');
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

module.exports = { applyDefaults, loadConfig, DEFAULTS };
