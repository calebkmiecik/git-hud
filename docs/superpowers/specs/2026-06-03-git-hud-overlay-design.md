# Git HUD Overlay — Design

**Date:** 2026-06-03
**Status:** Approved (design phase)

## Summary

A desktop overlay that floats above all other windows and shows, for a
configured list of git repositories, the currently checked-out branch along
with ahead/behind counts and a clean/dirty indicator. The overlay is hidden by
default and summoned/dismissed with a global hotkey. State updates near-instantly
when branches switch or the working tree changes.

Built with **Electron** (Node 25, git 2.53 already present; no new toolchain).

## Goals

- See at a glance which branch each tracked repo is on.
- Show ahead/behind vs. upstream and a clean/dirty indicator per repo.
- Stay out of the way: hidden until summoned by a hotkey, always-on-top when shown.
- Update responsively to branch switches and working-tree changes.

## Non-Goals (YAGNI)

- No auto-discovery of repos (explicit config list only).
- No git actions from the HUD (read-only; no checkout/commit/fetch).
- No multi-monitor placement logic beyond a single configurable position.
- No remote network operations beyond what local git already knows (no auto-fetch).

## Configuration

`config.json` at the project root:

```json
{
  "repos": [
    "C:\\Users\\Caleb\\Documents\\projects\\some-repo",
    "C:\\Users\\Caleb\\Documents\\projects\\another-repo"
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

- `repos` — explicit list of absolute repo paths.
- `hotkey` — global shortcut to toggle show/hide (Electron accelerator syntax).
- `pollIntervalMs` — slow-poll interval for ahead/behind refresh (default 20s).
- `startVisible` — if `true`, the overlay is shown on launch instead of hidden.
- `window.position` — one of `top-left | top-right | bottom-left | bottom-right`.
- `window.opacity` — 0–1 window opacity.

Missing or malformed config falls back to sensible defaults and surfaces a banner
in the HUD rather than crashing.

## Architecture

```
config.json ──► main process ──► repo monitors ──► git queries (git CLI)
                     │                  │
                     │ IPC              └─ fs.watch on .git/HEAD + .git/index
                     ▼
              renderer (HUD UI)
```

Four small modules with clear boundaries:

### 1. `main.js` — Electron main process
- Loads and validates `config.json`.
- Creates a frameless, transparent, always-on-top, `skipTaskbar` BrowserWindow,
  positioned per config.
- Registers the global hotkey to toggle window visibility; honors `startVisible`.
- Instantiates one repo monitor per configured repo.
- Receives state updates from monitors and forwards a consolidated state array to
  the renderer over IPC (`hud:update`).
- **Depends on:** Electron, `config.js`, `monitor.js`.

### 2. `monitor.js` — per-repo monitor
- One instance per repo path. Exposes `start()`, `stop()`, and an `onChange(state)`
  callback.
- Uses `fs.watch` on `<repo>/.git/HEAD` (branch switches) and `<repo>/.git/index`
  (staging / dirty changes), with a short debounce (~150ms) to coalesce bursts.
- Runs a slow timer at `pollIntervalMs` to refresh ahead/behind (changes on fetch,
  which may not touch watched files).
- On any trigger, calls `git.js` to compute current state and fires `onChange`.
- **Depends on:** Node `fs`, `git.js`.
- **Testable unit:** debounce/coalescing behavior.

### 3. `git.js` — git query functions (pure where possible)
- `getBranch(repoPath)` → `git rev-parse --abbrev-ref HEAD`; detached HEAD →
  short SHA from `git rev-parse --short HEAD`.
- `getDirty(repoPath)` → `git status --porcelain`; any output ⇒ dirty.
- `getAheadBehind(repoPath)` → `git rev-list --count --left-right @{upstream}...HEAD`;
  no upstream ⇒ `null` (arrows omitted).
- `getRepoState(repoPath)` → composes the above into a single state object.
- Parsing logic is separated from process execution so parsers can be unit-tested
  against captured sample output.
- **Depends on:** `child_process`, git CLI.
- **Testable unit:** each parser, given representative git output strings.

### 4. `index.html` + `renderer.js` — HUD UI
- Receives `hud:update` state arrays over IPC and renders a compact list.
- Each row: repo name · branch · `↑2 ↓1` ahead/behind · status dot
  (green = clean, amber = dirty).
- Dark, translucent styling sized to content.
- Error/banner area for config or git-not-found messages.
- **Depends on:** IPC bridge exposed via a `preload.js` contextBridge.

## Data Flow

1. Startup: `main` loads config → spawns monitors → each monitor computes initial
   state and fires `onChange`.
2. `main` aggregates the latest state per repo and pushes `hud:update` to the renderer.
3. Branch switch / staging change → `fs.watch` fires → debounced → monitor recomputes
   → `onChange` → `main` → IPC → renderer re-renders.
4. Every `pollIntervalMs`, each monitor refreshes ahead/behind on the same path.

## Repo State Shape

```js
{
  path: "C:\\...\\some-repo",
  name: "some-repo",            // basename of path
  branch: "feature/x",          // or short SHA if detached
  detached: false,
  dirty: true,
  ahead: 2,                     // null if no upstream
  behind: 1,                    // null if no upstream
  error: null                   // string if repo missing / not a git repo
}
```

## Error Handling

- **Config missing/malformed** → defaults applied; banner shown in HUD.
- **Repo path missing or not a git repo** → that row renders muted with an error
  message; other repos unaffected.
- **No upstream configured** → ahead/behind omitted; branch + dirty still shown.
- **git executable not found** → one-time banner; HUD still renders rows it can.
- **`fs.watch` failure on a repo** (e.g. path removed) → fall back to poll-only for
  that repo; mark error if it stays unreadable.

## Testing Strategy

- **`git.js` parsers** — unit tests feeding captured sample output for: normal
  branch, detached HEAD, dirty vs clean porcelain output, ahead/behind with and
  without upstream. Pure functions, fast, no git process needed.
- **`monitor.js` debounce** — unit test that rapid successive triggers coalesce
  into a single `onChange`.
- **Manual / by-eye** — window transparency, always-on-top, hotkey toggle, and
  live updates verified by running the app and switching branches in a tracked repo.

## Open Defaults (chosen, changeable in config)

- Hotkey: `Control+Alt+G`
- Poll interval: 20s
- Position: top-right
- Opacity: 0.9
- Start hidden (`startVisible: false`)
