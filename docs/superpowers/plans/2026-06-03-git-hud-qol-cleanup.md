# git-hud QoL Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a system tray (with clean quit + autostart), first-run config seeding, dev hot-reload, and Windows packaging to the existing git-hud overlay, relocating config/state to a writable per-user directory so packaging works.

**Architecture:** A new `src/paths.js` centralizes where `config.json`/`state.json` live (`app.getPath('userData')`, writable in both dev and packaged builds). `config.js` gains a pure `ensureConfig` that seeds the user file from the bundled `config.example.json` on first run. `main.js` reads/writes via the userData dir and gains a `Tray`. A dependency-free script generates `icon.ico`. A `scripts/launch.js` wrapper strips `ELECTRON_RUN_AS_NODE` (which the VS Code extension host sets, breaking Electron) and optionally runs `electronmon` for hot-reload. electron-builder produces an NSIS installer.

**Tech Stack:** Electron, Node 25 (`node:test`), `electronmon` (dev hot-reload), `electron-builder` (packaging). No new runtime dependencies.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/paths.js` | Resolve writable data dir + file paths | **Create** |
| `src/config.js` | Add `ensureConfig` (first-run seed) | Modify |
| `src/main.js` | Read/write via userData; create Tray; first-run seed; openSettings IPC | Modify |
| `src/preload.js` | Expose `onOpenSettings` | Modify |
| `src/renderer/renderer.js` | Open picker on `hud:openSettings`; factor open/close picker | Modify |
| `scripts/launch.js` | Strip env var; spawn electron / electronmon | **Create** |
| `scripts/make-icon.js` | Generate `icon.ico` (dependency-free) | **Create** |
| `icon.ico` | Tray + installer icon | **Create (generated)** |
| `package.json` | scripts, `author`, `build` block, devDeps | Modify |
| `test/paths.test.js` | Unit tests for `paths.js` | **Create** |
| `test/config.test.js` | Add `ensureConfig` tests | Modify |

Task order respects dependencies: launcher first (unblocks dev runs), then the pure modules (TDD), then `main.js` wiring, then the icon (needed by tray + packaging), then tray, then packaging, then end-to-end verification.

---

## Task 1: Dev launcher + hot-reload + env-var fix

**Files:**
- Create: `scripts/launch.js`
- Modify: `package.json` (scripts, devDependencies)

- [ ] **Step 1: Install electronmon**

Run: `npm install --save-dev electronmon`
Expected: `electronmon` appears under `devDependencies` in `package.json`; exit 0.

- [ ] **Step 2: Create the launcher**

Create `scripts/launch.js`:

```js
#!/usr/bin/env node
// Launches the app for local/dev use.
//
// The VS Code extension host sets ELECTRON_RUN_AS_NODE=1, which makes the
// electron binary behave like plain Node — then require('electron') returns a
// path string and `app` is undefined, crashing on startup. It must be DELETED
// (setting it to '' is not enough; Electron may treat the var as present).
delete process.env.ELECTRON_RUN_AS_NODE;

const path = require('node:path');
const { spawn } = require('node:child_process');

const watch = process.argv.includes('--watch');

let bin, args;
if (watch) {
  // electronmon watches main + renderer files and restarts/reloads on change.
  const exe = process.platform === 'win32' ? 'electronmon.cmd' : 'electronmon';
  bin = path.join(__dirname, '..', 'node_modules', '.bin', exe);
  args = ['.'];
} else {
  // Under plain Node, require('electron') resolves to the electron exe path.
  bin = require('electron');
  args = ['.'];
}

const child = spawn(bin, args, {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32' && watch, // .cmd needs a shell on Windows
});
child.on('error', (err) => {
  console.error(`Failed to launch ${watch ? 'electronmon' : 'electron'}:`, err.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
```

- [ ] **Step 3: Update package.json scripts**

In `package.json`, replace the `"scripts"` block so `start` and `dev` both go through the launcher:

```jsonc
"scripts": {
  "start": "node scripts/launch.js",
  "dev": "node scripts/launch.js --watch",
  "test": "node --test"
}
```

- [ ] **Step 4: Verify a normal launch works from this shell**

Run: `npm start`
Expected: the overlay process starts with **no** `Cannot read properties of undefined (reading 'whenReady')` error (this proves the env-var fix). Press the hotkey `Control+Alt+G` to confirm the window appears. Close it (Ctrl+C in the terminal for now — clean quit lands in Task 6).

- [ ] **Step 5: Verify hot-reload**

Run: `npm run dev`
Then make a trivial edit to `src/renderer/index.html` (e.g. change a CSS value) and save.
Expected: electronmon reloads the renderer/app automatically (terminal shows a restart/reload line). Stop with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add scripts/launch.js package.json package-lock.json
git commit -m "feat: dev launcher with hot-reload and ELECTRON_RUN_AS_NODE fix"
```

---

## Task 2: `src/paths.js` — centralize data file locations

**Files:**
- Create: `src/paths.js`
- Test: `test/paths.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/paths.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { dataDir, configFile, exampleFile } = require('../src/paths');

test('dataDir delegates to app.getPath(userData)', () => {
  const app = { getPath: (k) => (k === 'userData' ? '/ud' : '/other') };
  assert.equal(dataDir(app), '/ud');
});

test('configFile joins under the data dir', () => {
  assert.equal(configFile('/ud'), path.join('/ud', 'config.json'));
});

test('exampleFile joins under the app dir', () => {
  assert.equal(exampleFile('/app'), path.join('/app', 'config.example.json'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/paths.test.js`
Expected: FAIL — `Cannot find module '../src/paths'`.

- [ ] **Step 3: Create the module**

Create `src/paths.js`:

```js
const path = require('node:path');

// Writable per-user directory for config.json / state.json. `app` is injected
// so this module needs no Electron import and stays unit-testable.
function dataDir(app) {
  return app.getPath('userData');
}

function configFile(dir) {
  return path.join(dir, 'config.json');
}

// Read-only template shipped inside the app bundle (appDir = app.getAppPath()).
// (state.json's path is resolved inside state.js from the same data dir.)
function exampleFile(appDir) {
  return path.join(appDir, 'config.example.json');
}

module.exports = { dataDir, configFile, exampleFile };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/paths.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/paths.js test/paths.test.js
git commit -m "feat: add paths module for writable config/state locations"
```

---

## Task 3: `ensureConfig` — seed config.json on first run

**Files:**
- Modify: `src/config.js`
- Modify: `test/config.test.js`

- [ ] **Step 1: Write the failing tests**

In `test/config.test.js`, change the import line:

```js
const { applyDefaults, ensureConfig } = require('../src/config');
```

Then append these tests to the end of the file:

```js
test('ensureConfig copies the example when dest is missing', () => {
  const calls = [];
  const fakeFs = {
    existsSync: () => false,
    copyFileSync: (a, b) => calls.push([a, b]),
  };
  const r = ensureConfig({ dest: '/ud/config.json', example: '/app/config.example.json', fs: fakeFs });
  assert.equal(r, 'created');
  assert.deepEqual(calls, [['/app/config.example.json', '/ud/config.json']]);
});

test('ensureConfig no-ops when dest already exists', () => {
  let copied = false;
  const fakeFs = { existsSync: () => true, copyFileSync: () => { copied = true; } };
  const r = ensureConfig({ dest: '/ud/config.json', example: '/app/config.example.json', fs: fakeFs });
  assert.equal(r, 'exists');
  assert.equal(copied, false);
});

test('ensureConfig returns "failed" without throwing on copy error', () => {
  const fakeFs = { existsSync: () => false, copyFileSync: () => { throw new Error('EACCES'); } };
  const r = ensureConfig({ dest: '/ud/config.json', example: '/app/config.example.json', fs: fakeFs });
  assert.equal(r, 'failed');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/config.test.js`
Expected: FAIL — `ensureConfig is not a function`.

- [ ] **Step 3: Implement `ensureConfig`**

In `src/config.js`, add this function after `loadConfig` (before `module.exports`):

```js
// Seeds dest from the bundled example when dest is missing. Never throws.
// Returns 'created' | 'exists' | 'failed'. fs is injected for testability.
function ensureConfig({ dest, example, fs: fsImpl = fs }) {
  try {
    if (fsImpl.existsSync(dest)) return 'exists';
    fsImpl.copyFileSync(example, dest);
    return 'created';
  } catch {
    return 'failed';
  }
}
```

Then update the exports line:

```js
module.exports = { applyDefaults, loadConfig, ensureConfig, DEFAULTS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/config.test.js`
Expected: PASS (all config tests, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: add ensureConfig to seed config.json on first run"
```

---

## Task 4: Wire `main.js` to userData + first-run seeding

**Files:**
- Modify: `src/main.js`

No new unit tests (Electron runtime layer is verified manually, consistent with the original plan). The existing `config`/`state` test signatures are unchanged.

- [ ] **Step 1: Add the new requires**

In `src/main.js`, just below the existing requires (after the `./state` line), add:

```js
const fs = require('node:fs');
const { dataDir: getDataDir, configFile, exampleFile } = require('./paths');
```

And change the `./config` require to also pull in `ensureConfig`:

```js
const { loadConfig, ensureConfig } = require('./config');
```

- [ ] **Step 2: Add a module-level data dir variable**

Below `let appDir = null;` add:

```js
let dataDir = null; // writable userData dir for config.json + state.json
```

- [ ] **Step 3: Resolve userData, seed config, and load from it**

In the `app.whenReady().then(() => {` block, replace these lines:

```js
  appDir = app.getAppPath();
  const res = loadConfig(appDir);
  cfg = res.config; cfgError = res.error;
  state = loadState(appDir);
```

with:

```js
  appDir = app.getAppPath();
  dataDir = getDataDir(app);
  ensureConfig({ dest: configFile(dataDir), example: exampleFile(appDir), fs });
  const res = loadConfig(dataDir);
  cfg = res.config; cfgError = res.error;
  state = loadState(dataDir);
```

- [ ] **Step 4: Point all state writes at the data dir**

In `src/main.js`, replace every occurrence of `saveState(appDir, state)` with `saveState(dataDir, state)` (there are 4: the first-run migration plus the addRoot, removeRoot, and setEnabled handlers).

- [ ] **Step 5: Verify the app loads config from userData**

Run: `npm start`
Expected: the app launches with no error banner about config (the file is auto-created at `%APPDATA%\git-hud\config.json`). Confirm the file exists:
Run: `Get-Content "$env:APPDATA\git-hud\config.json"`
Expected: prints the seeded config (same shape as `config.example.json`). Stop the app (Ctrl+C).

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: PASS — all existing tests plus the new `paths`/`ensureConfig` tests remain green.

- [ ] **Step 7: Commit**

```bash
git add src/main.js
git commit -m "feat: store config/state in userData and seed config on first run"
```

---

## Task 5: Generate `icon.ico` (dependency-free)

**Files:**
- Create: `scripts/make-icon.js`
- Create: `icon.ico` (generated, committed)

- [ ] **Step 1: Create the icon generator**

Create `scripts/make-icon.js`:

```js
// Generates a dependency-free 256x256 ICO (32-bit BGRA, single image).
// A dark rounded square with a green "clean" dot, echoing the HUD's status dot.
const fs = require('node:fs');
const path = require('node:path');

const W = 256, H = 256;
const BG = [0x30, 0x22, 0x1e, 0xff]; // #1e2230 as B,G,R,A
const FG = [0x50, 0xb9, 0x3f, 0xff]; // #3fb950 (clean-green)
const CLEAR = [0, 0, 0, 0];
const CX = 128, CY = 128, R_DOT = 70, R_CORNER = 56;

function outsideRounded(x, y) {
  let cx, cy;
  if (x < R_CORNER && y < R_CORNER) { cx = R_CORNER; cy = R_CORNER; }
  else if (x >= W - R_CORNER && y < R_CORNER) { cx = W - R_CORNER - 1; cy = R_CORNER; }
  else if (x < R_CORNER && y >= H - R_CORNER) { cx = R_CORNER; cy = H - R_CORNER - 1; }
  else if (x >= W - R_CORNER && y >= H - R_CORNER) { cx = W - R_CORNER - 1; cy = H - R_CORNER - 1; }
  else return false;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy > R_CORNER * R_CORNER;
}

function pixel(x, y) {
  if (outsideRounded(x, y)) return CLEAR;
  const dx = x - CX, dy = y - CY;
  if (dx * dx + dy * dy <= R_DOT * R_DOT) return FG;
  return BG;
}

// XOR bitmap, stored bottom-up.
const xor = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const [b, g, r, a] = pixel(x, y);
    const i = ((H - 1 - y) * W + x) * 4;
    xor[i] = b; xor[i + 1] = g; xor[i + 2] = r; xor[i + 3] = a;
  }
}
const andMask = Buffer.alloc((W / 8) * H, 0x00); // all-opaque (alpha drives transparency)

const bih = Buffer.alloc(40);
bih.writeUInt32LE(40, 0);   // biSize
bih.writeInt32LE(W, 4);     // biWidth
bih.writeInt32LE(H * 2, 8); // biHeight = XOR + AND
bih.writeUInt16LE(1, 12);   // biPlanes
bih.writeUInt16LE(32, 14);  // biBitCount
bih.writeUInt32LE(0, 16);   // biCompression = BI_RGB
bih.writeUInt32LE(0, 20);   // biSizeImage (0 allowed for BI_RGB)

const image = Buffer.concat([bih, xor, andMask]);

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type = icon
dir.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);                 // width 0 => 256
entry.writeUInt8(0, 1);                 // height 0 => 256
entry.writeUInt8(0, 2);                 // palette colors
entry.writeUInt8(0, 3);                 // reserved
entry.writeUInt16LE(1, 4);              // planes
entry.writeUInt16LE(32, 6);             // bit count
entry.writeUInt32LE(image.length, 8);   // bytes in resource
entry.writeUInt32LE(6 + 16, 12);        // offset to image

const ico = Buffer.concat([dir, entry, image]);
fs.writeFileSync(path.join(__dirname, '..', 'icon.ico'), ico);
console.log(`Wrote icon.ico (${ico.length} bytes)`);
```

- [ ] **Step 2: Generate the icon**

Run: `node scripts/make-icon.js`
Expected: prints `Wrote icon.ico (NNNNN bytes)` and creates `icon.ico` at the repo root.

- [ ] **Step 3: Verify the ICO header is valid**

Run: `node -e "const b=require('fs').readFileSync('icon.ico'); console.log([...b.slice(0,6)].join(','), b.length)"`
Expected: starts with `0,0,1,0,1,0` (ICONDIR: reserved=0, type=1, count=1) and a length of roughly 270000 bytes.

- [ ] **Step 4: Commit**

```bash
git add scripts/make-icon.js icon.ico
git commit -m "feat: add generated app/tray icon"
```

---

## Task 6: Tray icon, clean quit, autostart, and open-settings IPC

**Files:**
- Modify: `src/main.js`
- Modify: `src/preload.js`
- Modify: `src/renderer/renderer.js`

Verified manually (Electron runtime).

- [ ] **Step 1: Import Tray and Menu**

In `src/main.js`, update the electron require to add `Tray` and `Menu`:

```js
const { app, BrowserWindow, globalShortcut, ipcMain, dialog, screen, Tray, Menu } = require('electron');
```

- [ ] **Step 2: Add a tray module variable**

Below `let win = null;` add:

```js
let tray = null;
```

- [ ] **Step 3: Refresh the tray menu inside `toggle()`**

Replace the existing `toggle` function:

```js
function toggle() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else { win.show(); win.setAlwaysOnTop(true, 'screen-saver'); }
}
```

with:

```js
function toggle() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else { win.show(); win.setAlwaysOnTop(true, 'screen-saver'); }
  if (tray) tray.setContextMenu(buildTrayMenu());
}
```

- [ ] **Step 4: Add the tray builders**

In `src/main.js`, add these two functions just above `function toggle()`:

```js
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
```

- [ ] **Step 5: Call `createTray()` during startup**

In the `app.whenReady().then(() => {` block, immediately after the existing `reconcile();` call (which follows `createWindow(); rescan();`), add:

```js
  createTray();
```

- [ ] **Step 6: Expose `onOpenSettings` in preload**

In `src/preload.js`, add this property to the `exposeInMainWorld('hud', { ... })` object (after `onUpdate`):

```js
  onOpenSettings: (cb) => {
    ipcRenderer.removeAllListeners('hud:openSettings');
    ipcRenderer.on('hud:openSettings', () => cb());
  },
```

- [ ] **Step 7: Factor picker open/close and handle the IPC in the renderer**

In `src/renderer/renderer.js`, replace the existing gear handler:

```js
gearEl.addEventListener('click', async () => {
  const opening = pickerEl.hidden;
  if (opening) {
    await renderPicker();
    pickerEl.hidden = false;
    listEl.hidden = true;
  } else {
    pickerEl.hidden = true;
    listEl.hidden = false;
  }
});
```

with:

```js
async function openPicker() {
  await renderPicker();
  pickerEl.hidden = false;
  listEl.hidden = true;
}

function closePicker() {
  pickerEl.hidden = true;
  listEl.hidden = false;
}

gearEl.addEventListener('click', () => {
  if (pickerEl.hidden) openPicker();
  else closePicker();
});

window.hud.onOpenSettings(() => openPicker());
```

- [ ] **Step 8: Verify the tray end-to-end**

Run: `npm start`
Expected, in order:
1. A tray icon appears in the Windows system tray (the dark square with a green dot).
2. Left-click the tray icon → the overlay toggles show/hide.
3. Right-click → menu shows Show/Hide, "Open settings…", "Start at login" (checkbox), Quit.
4. "Open settings…" shows the window and opens the ⚙ picker view.
5. Toggle "Start at login" on, then re-open the menu → it stays checked.
6. Click "Quit" → the app exits with no orphaned process. Confirm:
   Run: `Get-Process electron -ErrorAction SilentlyContinue`
   Expected: nothing returned.

- [ ] **Step 9: Commit**

```bash
git add src/main.js src/preload.js src/renderer/renderer.js
git commit -m "feat: system tray with show/hide, settings, autostart, and quit"
```

---

## Task 7: Package with electron-builder (NSIS installer)

**Files:**
- Modify: `package.json` (author, build block, scripts, devDependencies)

- [ ] **Step 1: Install electron-builder**

Run: `npm install --save-dev electron-builder`
Expected: `electron-builder` appears under `devDependencies`; exit 0.

- [ ] **Step 2: Add author, build config, and packaging scripts**

In `package.json`:

Add a top-level `"author"` field (electron-builder warns/errors without it):

```jsonc
"author": "Caleb",
```

Extend the `"scripts"` block to:

```jsonc
"scripts": {
  "start": "node scripts/launch.js",
  "dev": "node scripts/launch.js --watch",
  "test": "node --test",
  "pack": "electron-builder --dir",
  "dist": "electron-builder"
}
```

Add a top-level `"build"` block:

```jsonc
"build": {
  "appId": "com.caleb.githud",
  "productName": "git-hud",
  "files": ["src/**/*", "config.example.json", "icon.ico"],
  "win": {
    "target": "nsis",
    "icon": "icon.ico"
  }
}
```

- [ ] **Step 3: Smoke-build the unpacked app**

Run: `npm run pack`
Expected: electron-builder produces an unpacked build under `dist/win-unpacked/` with `git-hud.exe`, exit 0. (First run downloads build tooling — requires network.)

- [ ] **Step 4: Verify the unpacked exe runs and uses userData**

Run: `dist/win-unpacked/git-hud.exe`
Expected: the overlay + tray appear; the app reads/writes `%APPDATA%\git-hud\` (NOT the asar). Quit via the tray.

- [ ] **Step 5: Confirm dist/ is ignored by git**

Run: `git status --porcelain dist`
Expected: no output (the existing `.gitignore` already lists `dist/`). If `dist/` shows up, add it to `.gitignore`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: package as Windows NSIS installer via electron-builder"
```

---

## Task 8: End-to-end installer verification

**Files:** none (runtime verification). Use the @superpowers:verification-before-completion mindset — observe real behavior before claiming done.

- [ ] **Step 1: Build the installer**

Run: `npm run dist`
Expected: an NSIS installer at `dist/git-hud Setup <version>.exe`, exit 0.

- [ ] **Step 2: Install and launch from the Start menu**

Run the installer, then launch git-hud from the Start-menu shortcut (NOT from the VS Code terminal — this proves the packaged app needs no env-var workaround).
Expected: the overlay + tray icon appear; pressing `Control+Alt+G` toggles the window.

- [ ] **Step 3: Verify first-run config seeding**

Run: `Test-Path "$env:APPDATA\git-hud\config.json"`
Expected: `True` (created on first run from the bundled example).

- [ ] **Step 4: Verify autostart**

Via the tray menu, enable "Start at login". Sign out and back in (or reboot).
Expected: git-hud launches automatically. Then disable it via the tray and confirm it no longer auto-launches.

- [ ] **Step 5: Verify clean quit**

Quit via the tray "Quit" item, then:
Run: `Get-Process electron, git-hud -ErrorAction SilentlyContinue`
Expected: nothing returned.

- [ ] **Step 6: Final spec check**

Confirm against the spec (`docs/superpowers/specs/2026-06-03-git-hud-qol-cleanup-design.md`): packaging ✓, tray + quit ✓, autostart ✓, first-run config ✓, dev hot-reload ✓, config/state in userData ✓. No commit needed (verification only).

---

## Notes / Gotchas

- **DRY/YAGNI/TDD:** `paths.js` and `ensureConfig` are pure and unit-tested; the Electron runtime layer (tray, autostart, window) is verified manually, matching the original overlay plan.
- **`ELECTRON_RUN_AS_NODE` must be deleted, not blanked** — Electron may treat an empty-string value as set. The launcher uses `delete`.
- **`app.getAppPath()` is read-only when packaged** (inside `app.asar`) — only read the bundled `config.example.json` / `icon.ico` from it; all writes go to `dataDir` (userData).
- **electron-builder `files`** must list root files (`config.example.json`, `icon.ico`) explicitly so they're included alongside `src/`.
- **Keep `name`/`productName` stable** (`git-hud`) — they determine the `%APPDATA%\git-hud` folder; changing them orphans user settings.
- **Out of scope:** persisting dragged window position, the zoom/provider direction, macOS/Linux packaging, in-app settings editor.
