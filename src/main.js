const { app, BrowserWindow, globalShortcut, ipcMain, dialog, screen, Tray, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile, spawn } = require('node:child_process');
const http = require('node:http');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { loadConfig, ensureConfig } = require('./config');
const { dataDir: getDataDir, configFile, exampleFile } = require('./paths');
const { githubUrlFromRemote, resolveOpenCommand } = require('./open');
const { getRepoDetail } = require('./gitDetail');
const { RepoMonitor } = require('./monitor');
const { discoverRepos } = require('./discovery');
const { loadState, saveState, isEnabled, setEnabled, addRoot, removeRoot, getBase, setBase } = require('./state');
const { getCostSnapshot, pollDelayFor } = require('./costTracker');

let win = null;
let tray = null;
let agentServer = null;
let appDir = null;
let dataDir = null; // writable userData dir for config.json + state.json
let monitors = new Map(); // repoPath -> RepoMonitor
let states = new Map();   // repoPath -> latest state
let groups = [];          // [{ root, repos: [...] }] from last discovery
let cfg = null;
let cfgError = null;
let state = { enabled: {} };
let costTimer = null;
let costBusy = false;
let lastSnapshot = null;

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
  const width = 320, height = 520;
  const { x, y } = positionFor(cfg.window.position, width, height);
  win = new BrowserWindow({
    width, height, x, y,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: cfg.startVisible,
    opacity: cfg.window.opacity,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Let agent-ping sounds play even when the overlay is hidden / unfocused.
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', pushUpdate);
  // Showing the HUD triggers an immediate fresh usage poll (it isn't polled while hidden).
  win.on('show', () => pushCost({ force: true }));
  win.on('closed', () => { win = null; });
}

// Enabled repos in discovery order (stable grouping).
function enabledRepos() {
  const out = [];
  for (const g of groups) {
    for (const p of g.repos) {
      if (isEnabled(state, p)) out.push(p);
    }
  }
  return out;
}

function pushUpdate() {
  if (!win) return;
  const arr = enabledRepos().map(
    p => states.get(p) || { path: p, name: path.basename(p), branch: null, loading: true }
  );
  win.webContents.send('hud:update', { repos: arr, error: cfgError });
}

// Compute today's Claude spend + Kickbacks earnings and push to the renderer.
// Guarded so a slow snapshot (PowerShell DPAPI + network) can't overlap itself.
async function pushCost(opts = {}) {
  if (!win || costBusy) return;
  costBusy = true;
  try {
    // Only poll the usage API while the HUD is visible (avoids spending calls
    // on a hidden overlay). `force` (window just shown / manual refresh) bypasses
    // the usage cache for an immediate fresh reading.
    const snapshot = await getCostSnapshot({
      ledgerDir: dataDir,
      monthlyCost: cfg.plan.monthlyCost,
      usageAlertPct: cfg.usage.alertPct,
      fetchUsage: win.isVisible(),
      usagePollMs: cfg.cost.usagePollMs,
      forceUsage: !!opts.force,
      pacingConfig: cfg.usage.pacing,
    });
    lastSnapshot = snapshot;
    if (win) win.webContents.send('hud:cost', snapshot);
  } catch (e) {
    if (win) win.webContents.send('hud:cost', { error: e.message });
  } finally {
    costBusy = false;
  }
}

// Adaptive cadence: base interval, ramping faster as the closest window nears
// its limit — but only while the HUD is visible (hidden = base, no usage fetch).
function nextCostDelay() {
  if (!win || !win.isVisible()) return cfg.cost.usagePollMs;
  const u = lastSnapshot && lastSnapshot.usage;
  const maxPct = u ? Math.max((u.session && u.session.pct) || 0, (u.weekly && u.weekly.pct) || 0) : 0;
  return pollDelayFor(maxPct, cfg.cost.usagePollMs, cfg.cost.usagePollHotMs, cfg.cost.hotPct);
}

function scheduleCost() {
  costTimer = setTimeout(async () => {
    await pushCost({ force: !!(win && win.isVisible()) });
    scheduleCost();
  }, nextCostDelay());
}

function startCostTracker() {
  if (!cfg.cost.enabled) return;
  pushCost({ force: true }).then(scheduleCost);
}

function rescan() {
  groups = discoverRepos(state.roots);
}

// Start monitors for enabled repos, stop monitors for the rest.
function reconcile() {
  const wanted = new Set(enabledRepos());
  // stop unwanted
  for (const [p, m] of monitors) {
    if (!wanted.has(p)) {
      m.stop();
      monitors.delete(p);
      states.delete(p);
    }
  }
  // start newly-wanted
  for (const p of wanted) {
    if (!monitors.has(p)) {
      const m = new RepoMonitor(p, { pollIntervalMs: cfg.pollIntervalMs });
      m.onChange = (s) => { states.set(p, s); pushUpdate(); };
      m.start();
      monitors.set(p, m);
    }
  }
  pushUpdate();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Hide' : 'Show', click: toggle },
    {
      label: 'Open settings…',
      click: () => {
        if (!win) return;
        win.show();
        win.setAlwaysOnTop(true, 'screen-saver');
        win.webContents.send('hud:openSettings');
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        try { app.setLoginItemSettings({ openAtLogin: item.checked }); }
        catch (e) { console.error('setLoginItemSettings failed:', e.message); }
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function createTray() {
  try {
    tray = new Tray(path.join(appDir, 'icon.ico'));
    tray.setToolTip('git-hud');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', toggle);
  } catch (e) {
    console.error('Tray init failed; continuing without tray:', e.message);
  }
}

function toggle() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else { win.show(); win.setAlwaysOnTop(true, 'screen-saver'); }
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// Loopback HTTP listener for Claude Code hook pings. A hook POSTs to
// http://127.0.0.1:<agentPort>/?type=stop|idle|permission&project=<dir>; we
// forward it to the renderer, which plays the matching sound + toast.
function startAgentListener() {
  const port = cfg.agentPort;
  if (!port) return;
  agentServer = http.createServer((req, res) => {
    let type = '', project = '';
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      type = u.searchParams.get('type') || '';
      project = u.searchParams.get('project') || '';
    } catch { /* malformed url */ }
    res.writeHead(204); res.end();
    if (win && type) win.webContents.send('hud:agentEvent', { type, project });
  });
  agentServer.on('error', (e) => { console.error('agent listener failed:', e.message); agentServer = null; });
  agentServer.listen(port, '127.0.0.1');
}

// Push the current branch to its upstream (no args = use configured upstream).
// Never throws; returns { ok, error? } with the last line of git's stderr.
async function gitPush(repoPath) {
  try {
    await execFileAsync('git', ['-C', repoPath, 'push']);
    return { ok: true };
  } catch (e) {
    const msg = (e.stderr || e.message || 'push failed').trim().split('\n').filter(Boolean).pop();
    return { ok: false, error: msg || 'push failed' };
  }
}

// Resolve a repo's `origin` remote URL, or null if there is none.
function getRemoteUrl(repoPath) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// Open a repo externally. target ∈ editor | terminal | explorer | github.
// Never throws; returns { ok, error? } so the renderer can surface failures.
async function openExternal(repoPath, target) {
  try {
    if (target === 'explorer') {
      const err = await shell.openPath(repoPath); // returns '' on success
      return err ? { ok: false, error: err } : { ok: true };
    }
    if (target === 'github') {
      const url = githubUrlFromRemote(await getRemoteUrl(repoPath));
      if (!url) return { ok: false, error: 'no remote' };
      await shell.openExternal(url);
      return { ok: true };
    }
    const cmd = resolveOpenCommand(target, repoPath);
    if (!cmd) return { ok: false, error: 'unknown target' };
    spawnDetached(cmd.cmd, cmd.args, target === 'terminal' ? repoPath : null);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Launch a detached child. On spawn failure for the terminal, fall back to a
// PowerShell window at the repo path (Windows Terminal may not be installed).
function spawnDetached(cmd, args, terminalCwd) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
  child.on('error', (e) => {
    if (terminalCwd) {
      const ps = spawn('powershell', ['-NoExit', '-Command', `Set-Location -LiteralPath '${terminalCwd}'`],
        { detached: true, stdio: 'ignore', shell: true });
      ps.on('error', (e2) => console.error('terminal fallback failed:', e2.message));
      ps.unref();
    } else {
      console.error(`open (${cmd}) failed:`, e.message);
    }
  });
  child.unref();
}

app.whenReady().then(() => {
  appDir = app.getAppPath();
  dataDir = getDataDir(app);
  const seedResult = ensureConfig({ dest: configFile(dataDir), example: exampleFile(appDir), fs });
  if (seedResult === 'failed') console.warn('ensureConfig failed — proceeding with defaults');
  const res = loadConfig(dataDir);
  cfg = res.config; cfgError = res.error;
  state = loadState(dataDir);

  // First-run migration: seed app-managed roots from config.json's roots.
  if (state.roots.length === 0 && cfg.roots.length > 0) {
    state.roots = [...cfg.roots];
    saveState(dataDir, state);
  }

  // Default the installed app to start at login (once). The tray "Start at
  // login" toggle still wins afterward — we only set the initial default.
  if (app.isPackaged && !state.loginConfigured) {
    try { app.setLoginItemSettings({ openAtLogin: true }); } catch (e) { console.error(e.message); }
    state.loginConfigured = true;
    saveState(dataDir, state);
  }

  createWindow();
  rescan();
  reconcile();
  createTray();
  startAgentListener();
  startCostTracker();

  // Picker: rescan and return discovered repos grouped by root + enabled flags + roots.
  ipcMain.handle('hud:getPicker', () => {
    rescan();
    return { groups, enabled: state.enabled, roots: state.roots };
  });

  // Add a root folder via a native directory picker.
  ipcMain.handle('hud:addRoot', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add a folder to scan for repos',
      properties: ['openDirectory'],
    });
    if (!res.canceled && res.filePaths[0]) {
      addRoot(state, res.filePaths[0]);
      saveState(dataDir, state);
      rescan();
      reconcile();
    }
    return { groups, enabled: state.enabled, roots: state.roots };
  });

  // Manual window drag (we don't use an OS drag region so DOM hover works).
  ipcMain.handle('hud:winPos', () => (win ? win.getPosition() : [0, 0]));
  ipcMain.on('hud:moveWin', (_e, x, y) => { if (win) win.setPosition(Math.round(x), Math.round(y)); });

  // Remove a root folder.
  ipcMain.handle('hud:removeRoot', (_e, rootPath) => {
    removeRoot(state, rootPath);
    saveState(dataDir, state);
    rescan();
    reconcile();
    return { groups, enabled: state.enabled, roots: state.roots };
  });

  // Toggle a repo on/off, persist, and reconcile monitors.
  ipcMain.handle('hud:setEnabled', (_e, repoPath, on) => {
    setEnabled(state, repoPath, on);
    saveState(dataDir, state);
    reconcile();
    return state.enabled;
  });

  // Detail view: open a repo externally (editor/terminal/explorer/github).
  ipcMain.handle('hud:openExternal', (_e, repoPath, target) => openExternal(repoPath, target));

  // Detail view: fetch richer git state on demand (upstream, stash, in-progress).
  // Pass the user's chosen compare branch (if any) so it's used over auto-detect.
  ipcMain.handle('hud:getDetail', (_e, repoPath) => getRepoDetail(repoPath, { base: getBase(state, repoPath) }));

  // Detail view: set/clear the manual compare branch for a repo, then recompute.
  ipcMain.handle('hud:setBase', (_e, repoPath, branch) => {
    setBase(state, repoPath, branch);
    saveState(dataDir, state);
    return getRepoDetail(repoPath, { base: getBase(state, repoPath) });
  });

  // Detail view: push the current branch to its upstream.
  ipcMain.handle('hud:push', (_e, repoPath) => gitPush(repoPath));

  // Cost bar: force an immediate refresh (e.g. when the user clicks it).
  ipcMain.handle('hud:getCost', () => getCostSnapshot({ ledgerDir: dataDir, monthlyCost: cfg.plan.monthlyCost, usageAlertPct: cfg.usage.alertPct, fetchUsage: true, usagePollMs: cfg.cost.usagePollMs, forceUsage: true, pacingConfig: cfg.usage.pacing }));

  const registered = globalShortcut.register(cfg.hotkey, toggle);
  if (!registered) {
    cfgError = (cfgError ? cfgError + ' | ' : '') + `Hotkey ${cfg.hotkey} already in use`;
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (costTimer) { clearTimeout(costTimer); costTimer = null; }
  for (const m of monitors.values()) m.stop();
  if (tray) { tray.destroy(); tray = null; }
  if (agentServer) { agentServer.close(); agentServer = null; }
});

// Mac convention; harmless on Windows.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
