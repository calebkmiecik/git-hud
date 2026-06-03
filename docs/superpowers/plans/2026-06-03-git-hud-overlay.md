# Git HUD Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Electron desktop overlay that floats above all windows and shows, for a configured list of git repos, the current branch, ahead/behind counts, and a clean/dirty indicator, toggled by a global hotkey.

**Architecture:** A single Electron app. The main process loads `config.json`, spawns one monitor per repo (watching `.git/HEAD` + `.git/index` plus a slow poll), computes per-repo state via pure git-output parsers, and pushes consolidated state to a frameless transparent always-on-top renderer over IPC.

**Tech Stack:** Electron, Node 25 (built-in `node:test` for unit tests — no test framework dependency), the `git` CLI, vanilla HTML/CSS/JS for the renderer.

---

## Spec

Design spec: `docs/superpowers/specs/2026-06-03-git-hud-overlay-design.md`

## File Structure

| File | Responsibility |
|------|----------------|
| `package.json` | Deps (`electron`), scripts (`start`, `test`). |
| `config.json` | User settings: repos, hotkey, poll interval, window. |
| `config.example.json` | Committed template (real `config.json` is gitignored). |
| `src/git.js` | Pure parsers (`parseBranch`, `parseDirty`, `parseAheadBehind`) + exec wrappers + `getRepoState`. |
| `src/monitor.js` | `RepoMonitor` class: fs.watch + debounce + poll, fires `onChange`. |
| `src/config.js` | Load/validate config with defaults. |
| `src/main.js` | Electron main: window, global hotkey, wire monitors → IPC. |
| `src/preload.js` | contextBridge exposing `onUpdate` to renderer. |
| `src/renderer/index.html` | HUD markup + styles. |
| `src/renderer/renderer.js` | Render state arrays into rows. |
| `test/git.test.js` | Unit tests for git parsers. |
| `test/monitor.test.js` | Unit test for debounce coalescing. |
| `test/config.test.js` | Unit tests for config defaults/validation. |

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `config.example.json`
- Modify: `.gitignore` (add `config.json`)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "git-hud",
  "version": "0.1.0",
  "description": "Always-on-top overlay showing git branch status for tracked repos",
  "main": "src/main.js",
  "type": "commonjs",
  "scripts": {
    "start": "electron .",
    "test": "node --test"
  },
  "devDependencies": {
    "electron": "^33.0.0"
  }
}
```

- [ ] **Step 2: Create `config.example.json`**

```json
{
  "repos": [
    "C:\\Users\\Caleb\\Documents\\projects\\rank-anything"
  ],
  "hotkey": "Control+Alt+G",
  "pollIntervalMs": 20000,
  "startVisible": false,
  "window": {
    "position": "top-right",
    "opacity": 0.9
  }
}
```

- [ ] **Step 3: Add `config.json` to `.gitignore`**

Append to `.gitignore`:
```
config.json
```
(Real config is local-only; the example is committed.)

- [ ] **Step 4: Install deps**

Run: `npm install`
Expected: `node_modules/` populated, `electron` present, exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json config.example.json .gitignore
git commit -m "chore: scaffold electron project"
```

---

## Task 2: Git parsers (pure functions, TDD)

The parsers take raw git stdout strings and return structured data. They contain
zero process/IO so they are fully unit-testable. **Watch the ahead/behind orientation:**
`git rev-list --count --left-right @{upstream}...HEAD` prints `behind<TAB>ahead`.

**Files:**
- Create: `src/git.js`
- Test: `test/git.test.js`

- [ ] **Step 1: Write failing tests**

`test/git.test.js`:
```js
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
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/git'` / functions undefined.

- [ ] **Step 3: Implement `src/git.js`**

```js
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const execFileAsync = promisify(execFile);

// ---- pure parsers ----
function parseBranch(abbrevRefStdout, shortSha) {
  const name = abbrevRefStdout.trim();
  return name === 'HEAD' ? shortSha : name;
}

function parseDirty(porcelainStdout) {
  return porcelainStdout.trim().length > 0;
}

function parseAheadBehind(revListStdout) {
  const line = revListStdout.trim();
  if (!line) return null;
  const [behind, ahead] = line.split(/\s+/).map(Number);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) return null;
  return { behind, ahead };
}

// ---- exec wrappers ----
async function git(repoPath, args) {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args]);
  return stdout;
}

async function getRepoState(repoPath) {
  const name = path.basename(repoPath);
  try {
    const abbrev = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const shortSha = (await git(repoPath, ['rev-parse', '--short', 'HEAD'])).trim();
    const branch = parseBranch(abbrev, shortSha);
    const detached = abbrev.trim() === 'HEAD';
    const dirty = parseDirty(await git(repoPath, ['status', '--porcelain']));

    let ahead = null, behind = null;
    try {
      const rl = await git(repoPath, ['rev-list', '--count', '--left-right', '@{upstream}...HEAD']);
      const ab = parseAheadBehind(rl);
      if (ab) { ahead = ab.ahead; behind = ab.behind; }
    } catch { /* no upstream */ }

    return { path: repoPath, name, branch, detached, dirty, ahead, behind, error: null };
  } catch (e) {
    // A failed spawn (ENOENT on the binary) => git missing. A non-zero git exit
    // (numeric e.code / stderr) => the path isn't a usable git repo.
    const gitMissing = e.code === 'ENOENT' && /spawn/i.test(e.syscall || '');
    return { path: repoPath, name, branch: null, detached: false, dirty: false,
             ahead: null, behind: null, error: gitMissing ? 'git not found' : 'not a git repo' };
  }
}

module.exports = { parseBranch, parseDirty, parseAheadBehind, getRepoState };
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/git.js test/git.test.js
git commit -m "feat: git-output parsers and repo state query"
```

---

## Task 3: Config loader (TDD)

**Files:**
- Create: `src/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: Write failing tests**

`test/config.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { applyDefaults } = require('../src/config');

test('applyDefaults fills missing fields', () => {
  const c = applyDefaults({ repos: ['/a'] });
  assert.deepEqual(c.repos, ['/a']);
  assert.equal(c.hotkey, 'Control+Alt+G');
  assert.equal(c.pollIntervalMs, 20000);
  assert.equal(c.startVisible, false);
  assert.equal(c.window.position, 'top-right');
  assert.equal(c.window.opacity, 0.9);
});

test('applyDefaults preserves provided values', () => {
  const c = applyDefaults({ repos: [], hotkey: 'F8', pollIntervalMs: 5000,
    startVisible: true, window: { position: 'bottom-left', opacity: 0.5 } });
  assert.equal(c.hotkey, 'F8');
  assert.equal(c.pollIntervalMs, 5000);
  assert.equal(c.startVisible, true);
  assert.equal(c.window.position, 'bottom-left');
  assert.equal(c.window.opacity, 0.5);
});

test('applyDefaults coerces missing repos to empty array', () => {
  const c = applyDefaults({});
  assert.deepEqual(c.repos, []);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL — `applyDefaults` undefined.

- [ ] **Step 3: Implement `src/config.js`**

```js
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  repos: [],
  hotkey: 'Control+Alt+G',
  pollIntervalMs: 20000,
  startVisible: false,
  window: { position: 'top-right', opacity: 0.9 },
};

function applyDefaults(raw) {
  const r = raw || {};
  return {
    repos: Array.isArray(r.repos) ? r.repos : DEFAULTS.repos,
    hotkey: r.hotkey || DEFAULTS.hotkey,
    pollIntervalMs: Number.isFinite(r.pollIntervalMs) ? r.pollIntervalMs : DEFAULTS.pollIntervalMs,
    startVisible: typeof r.startVisible === 'boolean' ? r.startVisible : DEFAULTS.startVisible,
    window: {
      position: r.window?.position || DEFAULTS.window.position,
      opacity: Number.isFinite(r.window?.opacity) ? r.window.opacity : DEFAULTS.window.opacity,
    },
  };
}

// Loads config.json from the app directory. Returns { config, error }.
function loadConfig(appDir) {
  // appDir is app.getAppPath() — the project root under `electron .` (dev/unpacked only).
  const file = path.join(appDir, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { config: applyDefaults(raw), error: null };
  } catch (e) {
    const reason = e.code === 'ENOENT' ? 'config.json not found — using defaults'
                                       : 'config.json malformed — using defaults';
    return { config: applyDefaults({}), error: reason };
  }
}

module.exports = { applyDefaults, loadConfig, DEFAULTS };
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: config loader with defaults"
```

---

## Task 4: Repo monitor with debounce (TDD)

The monitor watches `.git/HEAD` and `.git/index`, debounces bursts into a single
refresh, and polls on an interval. The debounce is the testable unit; we inject the
state-getter and a fake clock-free trigger so the test needs no real fs or git.

**Files:**
- Create: `src/monitor.js`
- Test: `test/monitor.test.js`

- [ ] **Step 1: Write failing test**

`test/monitor.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { RepoMonitor } = require('../src/monitor');

test('debounce coalesces rapid triggers into one refresh', async () => {
  let calls = 0;
  const m = new RepoMonitor('/fake', {
    debounceMs: 10,
    getState: async () => { calls++; return { path: '/fake' }; },
  });
  let updates = 0;
  m.onChange = () => { updates++; };

  // fire 5 triggers within the debounce window
  m._trigger(); m._trigger(); m._trigger(); m._trigger(); m._trigger();
  await new Promise(r => setTimeout(r, 40));

  assert.equal(calls, 1, 'getState called once');
  assert.equal(updates, 1, 'onChange fired once');
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test`
Expected: FAIL — `RepoMonitor` undefined.

- [ ] **Step 3: Implement `src/monitor.js`**

```js
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
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/monitor.js test/monitor.test.js
git commit -m "feat: repo monitor with watch+debounce+poll"
```

---

## Task 5: Electron main process

Wires config → monitors → IPC, creates the overlay window, registers the hotkey.
No unit test (Electron runtime); verified manually in Task 7.

**Files:**
- Create: `src/main.js`

- [ ] **Step 1: Implement `src/main.js`**

```js
const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('node:path');
const { loadConfig } = require('./config');
const { RepoMonitor } = require('./monitor');

let win = null;
let monitors = [];
let states = new Map();
let cfg = null;
let cfgError = null;

function positionFor(position, width, height) {
  const { workArea } = screen.getPrimaryDisplay();
  const margin = 16;
  const left = position.includes('left');
  const top = position.includes('top');
  return {
    x: left ? workArea.x + margin : workArea.x + workArea.width - width - margin,
    y: top ? workArea.y + margin : workArea.y + workArea.height - height - margin,
  };
}

function createWindow() {
  const width = 320, height = 400;
  const { x, y } = positionFor(cfg.window.position, width, height);
  win = new BrowserWindow({
    width, height, x, y,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: cfg.startVisible,
    opacity: cfg.window.opacity,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', pushUpdate);
}

function pushUpdate() {
  if (!win) return;
  const arr = cfg.repos.map(p => states.get(p) || { path: p, name: path.basename(p), branch: null, loading: true });
  win.webContents.send('hud:update', { repos: arr, error: cfgError });
}

function toggle() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else { win.show(); win.setAlwaysOnTop(true, 'screen-saver'); }
}

app.whenReady().then(() => {
  const res = loadConfig(app.getAppPath());
  cfg = res.config; cfgError = res.error;

  createWindow();

  for (const repoPath of cfg.repos) {
    const m = new RepoMonitor(repoPath, { pollIntervalMs: cfg.pollIntervalMs });
    m.onChange = (state) => { states.set(repoPath, state); pushUpdate(); };
    m.start();
    monitors.push(m);
  }

  globalShortcut.register(cfg.hotkey, toggle);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  for (const m of monitors) m.stop();
});

// Mac convention; harmless on Windows.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

- [ ] **Step 2: Commit**

```bash
git add src/main.js
git commit -m "feat: electron main process — window, hotkey, monitor wiring"
```

---

## Task 6: Preload + renderer UI

**Files:**
- Create: `src/preload.js`
- Create: `src/renderer/index.html`
- Create: `src/renderer/renderer.js`

- [ ] **Step 1: Implement `src/preload.js`**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  onUpdate: (cb) => ipcRenderer.on('hud:update', (_e, payload) => cb(payload)),
});
```

- [ ] **Step 2: Implement `src/renderer/index.html`**

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; background: transparent;
    font: 12px/1.4 "Segoe UI", system-ui, sans-serif; -webkit-user-select: none; }
  #hud { background: rgba(20,22,28,0.82); color: #e6e6e6; border-radius: 10px;
    padding: 8px 10px; max-height: 50vh; overflow-y: auto;
    box-shadow: 0 6px 24px rgba(0,0,0,0.45); backdrop-filter: blur(6px);
    -webkit-app-region: drag; }
  .banner { color: #ffcf6b; font-size: 11px; margin-bottom: 6px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
  .clean { background: #4caf50; } .dirty { background: #ffb300; }
  .name { color: #9aa4b2; flex: 0 0 auto; max-width: 120px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .branch { color: #e6e6e6; font-weight: 600; flex: 1 1 auto; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .ab { color: #7fb2ff; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
  .err { color: #ff7b72; flex: 1 1 auto; }
  .loading { color: #6b7280; }
</style>
</head>
<body>
  <div id="hud"></div>
  <script src="renderer.js"></script>
</body>
</html>
```

- [ ] **Step 3: Implement `src/renderer/renderer.js`**

```js
const hudEl = document.getElementById('hud');

function abText(r) {
  if (r.ahead == null || r.behind == null) return '';
  const parts = [];
  if (r.ahead) parts.push(`↑${r.ahead}`);
  if (r.behind) parts.push(`↓${r.behind}`);
  return parts.join(' ');
}

function rowHtml(r) {
  if (r.loading) return `<div class="row"><span class="name">${esc(r.name)}</span><span class="loading">…</span></div>`;
  if (r.error) return `<div class="row"><span class="dot dirty"></span><span class="name">${esc(r.name)}</span><span class="err">${esc(r.error)}</span></div>`;
  return `<div class="row">
    <span class="dot ${r.dirty ? 'dirty' : 'clean'}"></span>
    <span class="name">${esc(r.name)}</span>
    <span class="branch">${esc(r.branch)}</span>
    <span class="ab">${esc(abText(r))}</span>
  </div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

window.hud.onUpdate(({ repos, error }) => {
  const banner = error ? `<div class="banner">${esc(error)}</div>` : '';
  const rows = repos.length ? repos.map(rowHtml).join('') : '<div class="row loading">No repos configured</div>';
  hudEl.innerHTML = banner + rows;
});
```

- [ ] **Step 4: Commit**

```bash
git add src/preload.js src/renderer/index.html src/renderer/renderer.js
git commit -m "feat: preload bridge and HUD renderer UI"
```

---

## Task 7: Manual verification

**Files:** none (runtime check). Use the @superpowers:verification-before-completion mindset — observe real behavior before claiming done.

- [ ] **Step 1: Create a real `config.json`**

Copy `config.example.json` to `config.json` and set `repos` to 1–2 real repo paths
on this machine (e.g. `C:\\Users\\Caleb\\Documents\\projects\\rank-anything`). Set
`"startVisible": true` temporarily so the window appears immediately.

- [ ] **Step 2: Launch the app**

Run: `npm start`
Expected: a small translucent overlay appears in the top-right showing each repo's
name, branch, ahead/behind, and a green (clean) or amber (dirty) dot.

- [ ] **Step 3: Verify live branch update**

In a tracked repo, run `git switch -c hud-test` (or `git checkout`). Within ~1s the
overlay's branch label updates without restart.

- [ ] **Step 4: Verify dirty indicator**

Touch a file in a tracked repo (e.g. edit + save). The dot flips to amber; revert /
commit and it returns to green.

- [ ] **Step 5: Verify hotkey toggle**

Set `"startVisible": false`, restart, confirm the overlay is hidden, then press
`Ctrl+Alt+G` to show and hide it. Confirm it stays above other windows when shown.
Remember to leave `startVisible: false` afterward so it doesn't pop up every launch.

- [ ] **Step 6: Verify error rows**

Add a bogus path to `repos`; confirm it renders a muted error row and the other repos
still work.

- [ ] **Step 7: Clean up test branch**

Delete the `hud-test` branch created in Step 3 (`git branch -D hud-test`).

- [ ] **Step 8: Final commit (docs/readme optional)**

```bash
git add -A
git commit -m "docs: verified git-hud overlay end to end"
```

---

## Notes for the implementer
- **DRY/YAGNI/TDD:** parsers, config, and debounce are covered by `node:test`; the
  Electron runtime layer is verified manually in Task 7.
- **Ahead/behind orientation:** never swap — `--left-right` prints `behind<TAB>ahead`.
- **`config.json` is gitignored** — only `config.example.json` is committed.
- Run the full suite with `npm test` after each TDD task; expect all green before committing.
