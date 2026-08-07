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
const earningsStore = require('./earningsStore');

let win = null;
let stripWin = null; // always-on usage strip parked over the taskbar dead zone
let tray = null;
let agentServer = null;
let appDir = null;
let dataDir = null; // writable userData dir for config.json + state.json
let earningsDir = null; // local clone of the shared earnings repo (cross-machine MTD)
let monitors = new Map(); // repoPath -> RepoMonitor
let states = new Map();   // repoPath -> latest state
let groups = [];          // [{ root, repos: [...] }] from last discovery
let cfg = null;
let cfgError = null;
let state = { enabled: {} };
let costTimer = null;
let costBusy = false;
let lastSnapshot = null;
let hudMode = 'hidden'; // hidden | gauges (compact peek) | full — cycled by the hotkey

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
  const { x, y, width, height } = hudAnchorBounds('full');
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
  win.once('ready-to-show', () => {
    pushUpdate();
    // Slide in if we opened already-visible (startVisible); otherwise the panel
    // waits off-screen below the taskbar until something shows it.
    if (win && win.isVisible()) win.webContents.send('hud:slide', 'in');
  });
  // Showing the HUD triggers an immediate fresh usage poll (it isn't polled while hidden).
  win.on('show', () => pushCost({ force: true }));
  win.on('closed', () => { win = null; });
}

// ── always-on taskbar strip ───────────────────────────────────────────────
// A slim readout parked in the empty corner of the taskbar (on a centred Win11
// taskbar the far end is permanently unoccupied). There is no supported way to
// put content *inside* the taskbar — Deskbands were deprecated in Windows 7 and
// Win11's taskbar exposes no extension point — so this is a frameless
// always-on-top window laid over that dead space, which looks the same.
//
// Geometry comes from the live difference between a display's full bounds and
// its work area, so it follows the taskbar's real edge and thickness instead of
// assuming 48px at the bottom.
function taskbarRect() {
  const d = screen.getPrimaryDisplay();
  const b = d.bounds, wa = d.workArea;
  if (wa.y > b.y) return { edge: 'top', x: b.x, y: b.y, w: b.width, h: wa.y - b.y };
  if (wa.height < b.height) {
    const top = wa.y + wa.height;
    return { edge: 'bottom', x: b.x, y: top, w: b.width, h: (b.y + b.height) - top };
  }
  if (wa.x > b.x) return { edge: 'left', x: b.x, y: b.y, w: wa.x - b.x, h: b.height };
  if (wa.width < b.width) return { edge: 'right', x: wa.x + wa.width, y: b.y, w: b.width - wa.width, h: b.height };
  return null; // auto-hidden or no taskbar reserved
}

// Windows refuses to make a top-level window shorter than this, silently
// clamping it — and Electron's getBounds() keeps reporting whatever you asked
// for, so the lie is invisible from JS. A 48px taskbar therefore needs a 64px
// window, positioned so the overhang falls *outside* the taskbar band and the
// content is padded into the band itself (`pad`, handed to the renderer).
const MIN_WIN_H = 64;

// Where the strip sits: hugging the configured end of the taskbar. Falls back to
// the screen corner when no taskbar space is reserved (auto-hide), so the strip
// stays put instead of vanishing.
function stripBounds() {
  const d = screen.getPrimaryDisplay();
  const b = d.bounds;
  const tb = taskbarRect();
  const horizontal = tb && (tb.edge === 'top' || tb.edge === 'bottom');
  const width = Math.round(cfg.strip.width);
  const band = Math.round(horizontal ? tb.h : cfg.strip.height); // the visible taskbar band
  const height = Math.max(MIN_WIN_H, band);
  const left = cfg.strip.corner.includes('left');
  const x = Math.round(left ? b.x : b.x + b.width - width);
  let y, edge;
  if (tb && tb.edge === 'top') { y = tb.y; edge = 'top'; }               // overhang below
  else if (tb && tb.edge === 'bottom') { y = tb.y + tb.h - height; edge = 'bottom'; } // overhang above
  else { edge = cfg.strip.corner.includes('top') ? 'top' : 'bottom';
    y = edge === 'top' ? b.y : b.y + b.height - height; }
  return { x, y: Math.round(y), width, height, band, edge, pad: height - band };
}

// The taskbar is itself a topmost window, so simply being topmost is not enough
// to stay above it — Windows re-raises the shell whenever it's activated, which
// is what made the strip vanish moments after appearing. Re-assert periodically;
// it's the only reliable way to hold the position without a native hook.
let stripTopTimer = null;

function assertStripOnTop() {
  if (!stripWin || stripWin.isDestroyed()) return;
  stripWin.setAlwaysOnTop(true, 'screen-saver');
  stripWin.moveTop();
}

function createStrip() {
  if (stripWin || !cfg.strip.enabled) return;
  const { x, y, width, height, pad, edge } = stripBounds();
  stripWin = new BrowserWindow({
    x, y, width, height,
    frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, focusable: false, show: false,
    // 'screen-saver' is the level that can sit above the taskbar.
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-strip.js'),
      backgroundThrottling: false,
    },
  });
  stripWin.setAlwaysOnTop(true, 'screen-saver');
  // `pad` tells the renderer how much of the window falls outside the taskbar
  // band, so it can push the bars into the visible part.
  stripWin.loadFile(path.join(__dirname, 'renderer', 'strip.html'),
    { query: { pad: String(pad), edge, style: cfg.strip.style } });
  stripWin.once('ready-to-show', () => {
    if (!stripWin) return;
    stripWin.showInactive(); // never steal focus from what you're working in
    assertStripOnTop();
    if (lastSnapshot) stripWin.webContents.send('hud:cost', lastSnapshot);
  });
  stripWin.on('closed', () => { stripWin = null; });
  if (stripTopTimer) clearInterval(stripTopTimer);
  stripTopTimer = setInterval(assertStripOnTop, 1000);
}

function destroyStrip() {
  if (stripTopTimer) { clearInterval(stripTopTimer); stripTopTimer = null; }
  if (!stripWin) return;
  const w = stripWin;
  stripWin = null;
  w.destroy();
}

function repositionStrip() {
  if (!stripWin) return;
  const { x, y, width, height, pad, edge } = stripBounds();
  stripWin.setBounds({ x, y, width, height });
  stripWin.webContents.send('strip:geometry', { pad, edge });
  assertStripOnTop();
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
// True when some surface is actually showing usage — the HUD panel or the
// always-on strip. Gates the usage fetch so a fully hidden app stops spending
// calls, while the strip (which is on-screen by definition) keeps itself fresh.
function usageOnScreen() {
  return !!(win && win.isVisible()) || !!stripWin;
}

// Fan a snapshot out to every surface that renders it.
function sendCost(payload) {
  if (win) win.webContents.send('hud:cost', payload);
  if (stripWin) stripWin.webContents.send('hud:cost', payload);
}

async function pushCost(opts = {}) {
  if ((!win && !stripWin) || costBusy) return;
  costBusy = true;
  try {
    // Only poll the usage API while something is actually displaying it.
    // `force` (window just shown / manual refresh) bypasses the usage cache for
    // an immediate fresh reading.
    const snapshot = await getCostSnapshot({
      ledgerDir: dataDir,
      earningsDir: cfg.earnings.repo ? earningsDir : null,
      earningsSyncMs: cfg.earnings.syncMs,
      monthlyCost: cfg.plan.monthlyCost,
      usageAlertPct: cfg.usage.alertPct,
      fetchUsage: usageOnScreen(),
      usagePollMs: cfg.cost.usagePollMs,
      forceUsage: !!opts.force,
      pacingConfig: cfg.usage.pacing,
    });
    lastSnapshot = snapshot;
    sendCost(snapshot);
  } catch (e) {
    sendCost({ error: e.message });
  } finally {
    costBusy = false;
  }
}

// Adaptive cadence: base interval, ramping faster as the closest window nears
// its limit — but only while usage is on screen (nothing shown = base cadence).
function nextCostDelay() {
  if (!usageOnScreen()) return cfg.cost.usagePollMs;
  const u = lastSnapshot && lastSnapshot.usage;
  const maxPct = u ? Math.max((u.session && u.session.pct) || 0, (u.weekly && u.weekly.pct) || 0) : 0;
  return pollDelayFor(maxPct, cfg.cost.usagePollMs, cfg.cost.usagePollHotMs, cfg.cost.hotPct);
}

function scheduleCost() {
  costTimer = setTimeout(async () => {
    await pushCost({ force: usageOnScreen() });
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
    { label: win && win.isVisible() ? 'Hide' : 'Show', click: trayToggle },
    {
      label: 'Open settings…',
      click: () => {
        if (!win) return;
        showMode('full');
        win.webContents.send('hud:openSettings');
      },
    },
    { type: 'separator' },
    {
      label: 'Usage strip on taskbar',
      type: 'checkbox',
      checked: !!stripWin,
      click: (item) => {
        cfg.strip.enabled = item.checked;
        if (item.checked) createStrip(); else destroyStrip();
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
    {
      label: 'Strip style',
      submenu: ['bars', 'dials'].map(s => ({
        label: s === 'bars' ? 'Bars' : 'Dials',
        type: 'radio',
        checked: cfg.strip.style === s,
        click: () => {
          cfg.strip.style = s;
          if (stripWin) stripWin.webContents.send('strip:style', s);
        },
      })),
    },
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
    tray.on('click', cycle);
  } catch (e) {
    console.error('Tray init failed; continuing without tray:', e.message);
  }
}

// Size + position the window for a view: gauges is a compact top strip, full is
// the tall panel. resizable is false, so flip it around setBounds.
function resizeForMode(mode) {
  if (!win) return;
  const [w, h] = mode === 'gauges' ? [272, 128] : [320, 520];
  const { x, y } = positionFor(cfg.window.position, w, h);
  win.setResizable(true);
  win.setBounds({ x, y, width: w, height: h });
  win.setResizable(false);
}

// Park the panel directly above the strip so it can slide out of the taskbar.
// The window's *bottom edge sits on the taskbar's top edge*, which is what makes
// the slide work: content translated below that edge is clipped by the window
// and genuinely appears to emerge from behind the bar. Falls back to the plain
// corner placement when the strip is off.
function hudAnchorBounds(mode) {
  const [w, h] = mode === 'gauges' ? [272, 128] : [320, 520];
  if (!cfg.strip.enabled) return { ...positionFor(cfg.window.position, w, h), width: w, height: h };
  const d = screen.getPrimaryDisplay();
  const b = d.bounds;
  const tb = taskbarRect();
  const left = cfg.strip.corner.includes('left');
  const x = left ? b.x : b.x + b.width - w;
  // Sit on the inner edge of the taskbar (or the screen edge if it auto-hides).
  const y = tb && tb.edge === 'bottom' ? tb.y - h
    : tb && tb.edge === 'top' ? tb.y + tb.h
    : b.y + b.height - h;
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

// How long the renderer's slide takes; main waits this out before hiding so the
// window doesn't vanish mid-animation. Keep in step with --dur-slide in the CSS.
const SLIDE_MS = 260;
let hideTimer = null;

// Show the HUD in a given view, telling the renderer which one and refreshing
// usage now that we're visible.
function showMode(mode) {
  if (!win) return;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const wasHidden = !win.isVisible();
  hudMode = mode;
  win.webContents.send('hud:setView', mode);
  if (wasHidden) {
    // Re-anchor on each fresh show; a drag only lasts for that appearance.
    const { x, y, width, height } = hudAnchorBounds(mode);
    win.setResizable(true);
    win.setBounds({ x, y, width, height });
    win.setResizable(false);
    win.setOpacity(cfg.window.opacity);
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
  } else {
    resizeForMode(mode);
  }
  win.webContents.send('hud:slide', 'in');
  pushCost({ force: true });
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function hideHud() {
  if (!win) return;
  hudMode = 'hidden';
  if (!win.isVisible()) return;
  // Slide out first, then actually hide once the animation has played.
  win.webContents.send('hud:slide', 'out');
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (win && hudMode === 'hidden') win.hide();
  }, SLIDE_MS);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// Hotkey: plain toggle now that the always-on strip carries usage ambiently —
// there's nothing left for a peek view to reveal, so the hotkey only decides
// whether the repo panel is up. ('gauges' remains a valid mode the renderer
// still implements, but nothing routes to it any more.)
function cycle() {
  if (hudMode === 'hidden') showMode('full');
  else hideHud();
}

// Tray click / menu: straight full-toggle (skip the gauges peek).
function trayToggle() {
  if (!win) return;
  if (win.isVisible()) hideHud();
  else showMode('full');
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
  if (cfg.startVisible) hudMode = 'full'; // window opens in the full view
  createStrip();
  // Taskbar can move, resize, or the resolution can change under us.
  screen.on('display-metrics-changed', repositionStrip);
  screen.on('display-added', repositionStrip);
  screen.on('display-removed', repositionStrip);
  rescan();
  reconcile();
  createTray();
  startAgentListener();

  // Shared earnings store: clone (or pull) the data repo in the background so
  // month-to-date is consistent across machines. earningsDir is set only AFTER the
  // clone succeeds, so a poll mid-clone can't write into a half-cloned dir (which
  // would break `git clone`); until then the month figure falls back to lifetime.
  if (cfg.earnings.repo) {
    const clone = path.join(dataDir, 'earnings-data');
    earningsStore.ensureClone(clone, cfg.earnings.repo)
      .then((ok) => { if (ok) earningsDir = clone; })
      .catch(() => {});
  }
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

  // Clicking the taskbar strip opens the full HUD (and focuses it).
  ipcMain.on('strip:openHud', () => showMode('full'));

  // Right-click the strip for its own menu. The window is deliberately
  // non-focusable (so it never steals focus while you type), but a popup menu
  // needs focus to stay open — so lend it focusability for the menu's lifetime.
  ipcMain.on('strip:menu', () => {
    if (!stripWin) return;
    const setStyle = (s) => {
      cfg.strip.style = s;
      if (stripWin) stripWin.webContents.send('strip:style', s);
      if (tray) tray.setContextMenu(buildTrayMenu());
    };
    const menu = Menu.buildFromTemplate([
      { label: 'Bars', type: 'radio', checked: cfg.strip.style === 'bars', click: () => setStyle('bars') },
      { label: 'Dials', type: 'radio', checked: cfg.strip.style === 'dials', click: () => setStyle('dials') },
      { type: 'separator' },
      { label: 'Open HUD', click: () => showMode('full') },
      { label: 'Hide strip', click: () => { cfg.strip.enabled = false; destroyStrip();
        if (tray) tray.setContextMenu(buildTrayMenu()); } },
    ]);
    stripWin.setFocusable(true);
    menu.popup({
      window: stripWin,
      callback: () => { if (stripWin && !stripWin.isDestroyed()) stripWin.setFocusable(false); },
    });
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
  ipcMain.handle('hud:getCost', () => getCostSnapshot({ ledgerDir: dataDir, earningsDir: cfg.earnings.repo ? earningsDir : null, earningsSyncMs: cfg.earnings.syncMs, monthlyCost: cfg.plan.monthlyCost, usageAlertPct: cfg.usage.alertPct, fetchUsage: true, usagePollMs: cfg.cost.usagePollMs, forceUsage: true, pacingConfig: cfg.usage.pacing }));

  const registered = globalShortcut.register(cfg.hotkey, cycle);
  if (!registered) {
    cfgError = (cfgError ? cfgError + ' | ' : '') + `Hotkey ${cfg.hotkey} already in use`;
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (costTimer) { clearTimeout(costTimer); costTimer = null; }
  for (const m of monitors.values()) m.stop();
  if (tray) { tray.destroy(); tray = null; }
  destroyStrip();
  if (agentServer) { agentServer.close(); agentServer = null; }
});

// Mac convention; harmless on Windows.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
