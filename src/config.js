const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  roots: [],
  hotkey: 'Control+Alt+G',
  pollIntervalMs: 20000,
  startVisible: false,
  window: { position: 'top-right', opacity: 0.9 },
  agentPort: 47600,
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
