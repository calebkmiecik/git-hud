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
