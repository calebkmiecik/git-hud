# git-hud — Cleanup & QoL Batch (Tray, Autostart, Packaging, First-Run, Hot-Reload)

**Date:** 2026-06-03
**Status:** Design — approved direction, pending spec review

## Goal

A focused cleanup/quality-of-life pass on the existing git-hud overlay. Five
changes, one of which (packaging) forces a supporting change to where config and
state files live:

1. **Package the app** with electron-builder into a Windows NSIS installer.
2. **Tray icon + clean quit** — currently the only way to close the app is to
   kill the process.
3. **Autostart** — optional "start at login", driven off the OS.
4. **First-run config** — auto-create `config.json` from the bundled example so a
   fresh install just works.
5. **Dev hot-reload** — `electronmon`-based auto-restart on source edits, plus a
   launcher that fixes the `ELECTRON_RUN_AS_NODE` breakage when launching from a
   VS Code shell.

This batch is deliberately additive cleanup. The larger "zoom into a project" /
multi-source provider direction (see `IDEAS.md`) is **out of scope** here.

## Decisions (and why)

These were resolved as clear choices — none carry a real trade-off worth a
separate call:

| Decision | Choice | Why |
|----------|--------|-----|
| Config/state file location | `app.getPath('userData')` in **both** dev and packaged builds | Packaging makes `app.getAppPath()` read-only (inside `app.asar`); `saveState` would throw. userData is writable and gives dev/prod parity. |
| Installer target | NSIS installer (no portable) | Gives a Start-menu shortcut and a stable exe path that autostart registers against. |
| Hot-reload tool | `electronmon` | Maintained; restarts the main process and reloads the renderer. |
| Autostart persistence | None — OS is source of truth | `getLoginItemSettings()` / `setLoginItemSettings()` avoid a redundant stored flag. |
| Env-var fix scope | Both `npm start` and `npm run dev` | The `ELECTRON_RUN_AS_NODE` footgun should never bite a local run, watch or not. |

## Architecture changes

The current four-module split (`config`, `state`, `git`/`monitor`, `main` +
renderer) is preserved. Changes are localized:

```
app bundle (read-only)                 userData  (%APPDATA%\git-hud\, writable)
  config.example.json  ──first run──►    config.json
  icon.ico                               state.json
  src/...
       │
       ▼
   main.js ── creates ──► Tray (menu: show/hide, settings, start-at-login, quit)
       │
       └── resolves data dir via paths.js ──► config.js / state.js read+write here
```

### 1. New module: `src/paths.js`

A tiny module that centralizes *where* persistent files live, so `config.js` and
`state.js` stop deriving paths from `appDir` directly.

```js
// Resolves the writable directory for config.json / state.json.
// In Electron this is app.getPath('userData'); injectable for tests.
function dataDir(app) { return app.getPath('userData'); }
function configFile(dir) { return path.join(dir, 'config.json'); }
function stateFile(dir)  { return path.join(dir, 'state.json'); }
// Bundled, read-only template shipped inside the app.
function exampleFile(appDir) { return path.join(appDir, 'config.example.json'); }
```

`config.js` and `state.js` keep taking a directory argument (as they do today),
so they stay pure and unit-testable — only the *caller* (`main.js`) changes which
directory it passes in (userData instead of appDir).

### 2. First-run config seeding — `config.js`

Add a pure-ish helper invoked before `loadConfig`:

```js
// Copies the bundled example to dest if dest doesn't exist yet. Returns
// 'created' | 'exists' | 'failed'. Never throws.
function ensureConfig({ dest, example, fs }) { ... }
```

`main.js` on startup: `ensureConfig({ dest: configFile(userData), example: exampleFile(appDir), fs })`
then `loadConfig(userData)` as today. The existing ENOENT/malformed fallback in
`loadConfig` ([src/config.js:33-38](../../../src/config.js)) stays as a safety net
(e.g. example missing, or a corrupt file).

### 3. Tray + clean quit — `main.js`

- Build a `Tray` after the window is created, using `icon.ico` from the app
  bundle.
- Context menu:
  - **Show / Hide** — calls the existing `toggle()`.
  - **Open settings** — show the window and tell the renderer to open the ⚙
    picker (new one-way IPC `hud:openSettings` → renderer calls its existing
    `renderPicker()` path).
  - **Start at login** — checkbox; `checked` reflects
    `app.getLoginItemSettings().openAtLogin`; click calls
    `setLoginItemSettings({ openAtLogin })` and rebuilds the menu.
  - **Quit** — `app.quit()`.
- Left-click on the tray icon → `toggle()`.
- Keep the existing `will-quit` cleanup (unregister shortcut, stop monitors)
  ([src/main.js:160-163](../../../src/main.js)). The `window-all-closed` handler
  stays; in practice the frameless window is hidden, never closed, so it won't
  fire — quitting is an explicit tray action.

### 4. Autostart — `main.js`

No new persisted state. The tray checkbox is the only surface; OS settings are the
source of truth. Packaged builds register the installed exe automatically; in dev
it targets `electron.exe` (acceptable — autostart is a packaged-build feature in
practice, and the tray still works in dev).

### 5. Dev hot-reload + env fix — `scripts/launch.js`

A small Node launcher used by both scripts:

```js
// node scripts/launch.js [--watch]
// Strips ELECTRON_RUN_AS_NODE (set by the VS Code extension host, which makes
// Electron run as plain Node so require('electron') returns a path string and
// app is undefined), then spawns electron or electronmon.
delete process.env.ELECTRON_RUN_AS_NODE;
const bin = hasFlag('--watch') ? 'electronmon' : 'electron';
spawn(resolveBin(bin), ['.'], { stdio: 'inherit', env: process.env });
```

`package.json` scripts:
- `start` → `node scripts/launch.js`
- `dev`   → `node scripts/launch.js --watch`
- `test`  → `node --test` (unchanged)

`electronmon` added to `devDependencies`.

### 6. Packaging — `package.json` `build` block + scripts

```jsonc
"build": {
  "appId": "com.caleb.githud",
  "productName": "git-hud",
  "files": ["src/**/*", "config.example.json", "icon.ico"],
  "win": { "target": "nsis", "icon": "icon.ico" }
}
```
Scripts: `pack` (`electron-builder --dir`, unpacked smoke build) and `dist`
(`electron-builder` — produces the NSIS installer). `electron-builder` added to
`devDependencies`.

### 7. Icon asset — `icon.ico`

A simple app/tray icon committed at the repo root, referenced by both the tray and
the installer. Created as part of implementation (a minimal branded mark — no
dependency on external design assets).

## Data flow (startup, after changes)

```
app.whenReady
  ► appDir   = app.getAppPath()          (read-only bundle)
  ► userData = app.getPath('userData')   (writable)
  ► ensureConfig(userData/config.json  ⟵ appDir/config.example.json)
  ► cfg   = loadConfig(userData)
  ► state = loadState(userData)
  ► createWindow(); rescan(); reconcile()  (unchanged)
  ► createTray()
  ► register global hotkey                 (unchanged)
```

## Error handling

- `ensureConfig` never throws; on copy failure it logs and lets `loadConfig` fall
  back to defaults (existing behavior).
- Tray icon load failure: log and continue without a tray (app still usable via
  hotkey) rather than crashing.
- `setLoginItemSettings` failures are caught; the menu reflects the last known OS
  state on next rebuild.
- Launcher: if the chosen bin can't be resolved, exit non-zero with a clear
  message.

## Testing

**Unit (`node:test`, no framework):**
- `paths.js` — `configFile`/`stateFile`/`exampleFile` join correctly; `dataDir`
  delegates to an injected `app` stub.
- `ensureConfig` — copies when dest missing (`created`), no-ops when present
  (`exists`), returns `failed` (no throw) when the example is unreadable. Uses an
  injected fake `fs`.
- Existing `config`/`state`/`git` tests remain green (their signatures are
  unchanged — still directory-argument based).

**Manual (per verification-before-completion):**
- `npm run dev` from the VS Code terminal launches the overlay (proves the
  `ELECTRON_RUN_AS_NODE` fix) and reloads on a renderer edit.
- Tray: show/hide, open settings, quit all work; quit fully exits (no orphan
  processes).
- Toggle "start at login", reboot/sign-out, confirm it launches (and that
  un-toggling removes it).
- `npm run dist` builds an installer; install it; confirm config/state land in
  `%APPDATA%\git-hud\`, first run creates `config.json`, and the Start-menu
  shortcut launches cleanly.

## Out of scope

- Persisting dragged window position (deferred).
- The "zoom into a project" detail view and the multi-source provider refactor
  (separate future spec).
- macOS/Linux packaging (Windows-only for now).
- In-app settings editor for opacity/hotkey (still edited in `config.json`).
- A migration that copies an existing repo-root `config.json`/`state.json` into
  userData — not worth it; current files hold only defaults/empty picks.

## Implementation notes / gotchas

- `app.getAppPath()` inside a packaged build points into `app.asar` (read-only) —
  only ever read from it (`config.example.json`, icon), never write.
- Ensure `config.example.json` and `icon.ico` are in electron-builder's `files`
  (asar would otherwise exclude root files).
- Setting `ELECTRON_RUN_AS_NODE=''` (empty) is **not** sufficient — Electron may
  treat the var as set. It must be **deleted** from the env.
- `productName`/`name` drive the userData folder name (`git-hud`); keep them
  stable so settings don't get orphaned across versions.
