const { app, BrowserWindow, globalShortcut, ipcMain, dialog, screen } = require('electron');
const path = require('node:path');
const { loadConfig } = require('./config');
const { RepoMonitor } = require('./monitor');
const { discoverRepos } = require('./discovery');
const { loadState, saveState, isEnabled, setEnabled, addRoot, removeRoot } = require('./state');

let win = null;
let appDir = null;
let monitors = new Map(); // repoPath -> RepoMonitor
let states = new Map();   // repoPath -> latest state
let groups = [];          // [{ root, repos: [...] }] from last discovery
let cfg = null;
let cfgError = null;
let state = { enabled: {} };

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

function toggle() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else { win.show(); win.setAlwaysOnTop(true, 'screen-saver'); }
}

app.whenReady().then(() => {
  appDir = app.getAppPath();
  const res = loadConfig(appDir);
  cfg = res.config; cfgError = res.error;
  state = loadState(appDir);

  // First-run migration: seed app-managed roots from config.json's roots.
  if (state.roots.length === 0 && cfg.roots.length > 0) {
    state.roots = [...cfg.roots];
    saveState(appDir, state);
  }

  createWindow();
  rescan();
  reconcile();

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
      saveState(appDir, state);
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
    saveState(appDir, state);
    rescan();
    reconcile();
    return { groups, enabled: state.enabled, roots: state.roots };
  });

  // Toggle a repo on/off, persist, and reconcile monitors.
  ipcMain.handle('hud:setEnabled', (_e, repoPath, on) => {
    setEnabled(state, repoPath, on);
    saveState(appDir, state);
    reconcile();
    return state.enabled;
  });

  const registered = globalShortcut.register(cfg.hotkey, toggle);
  if (!registered) {
    cfgError = (cfgError ? cfgError + ' | ' : '') + `Hotkey ${cfg.hotkey} already in use`;
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  for (const m of monitors.values()) m.stop();
});

// Mac convention; harmless on Windows.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
