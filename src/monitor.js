const fs = require('node:fs');
const path = require('node:path');
const { getRepoState } = require('./git');

class RepoMonitor {
  constructor(repoPath, opts = {}) {
    this.repoPath = repoPath;
    this.debounceMs = opts.debounceMs ?? 150;
    this.pollIntervalMs = opts.pollIntervalMs ?? 20000;
    this.getState = opts.getState ?? (() => getRepoState(this.repoPath));
    this.onChange = () => {};
    this._timer = null;
    this._watchers = [];
    this._poll = null;
  }

  _trigger() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._refresh(), this.debounceMs);
  }

  async _refresh() {
    try {
      const state = await this.getState();
      this.onChange(state);
    } catch { /* swallow; next trigger retries */ }
  }

  start() {
    const gitDir = path.join(this.repoPath, '.git');
    for (const f of ['HEAD', 'index']) {
      try {
        const w = fs.watch(path.join(gitDir, f), () => this._trigger());
        w.on('error', () => {}); // fall back to poll on watch failure
        this._watchers.push(w);
      } catch { /* poll-only for this file */ }
    }
    this._poll = setInterval(() => this._trigger(), this.pollIntervalMs);
    this._refresh(); // initial state
  }

  stop() {
    clearTimeout(this._timer);
    clearInterval(this._poll);
    for (const w of this._watchers) { try { w.close(); } catch {} }
    this._watchers = [];
  }
}

module.exports = { RepoMonitor };
