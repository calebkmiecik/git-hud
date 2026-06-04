# git-hud — Repo Detail View ("zoom into a project")

**Date:** 2026-06-04
**Status:** Design approved — building incrementally

## Goal

Click a repo row to "zoom in" to a detail view for that repo. Built **incrementally**:
each increment is independently useful, shipped and evaluated before the next.
This is also the first step toward the broader dev-HUD direction (the detail view
is the natural home for future data sources), but v1 uses only the `git` CLI we
already shell out to — **no provider/plugin abstraction yet** (YAGNI; there's one
data source today).

## Navigation model

**Full drill-down.** Clicking a row replaces the list with a detail view for that
repo (a third view alongside the existing list and picker), with a ← back button.
Keeps the compact 320×400 window size.

## Increments

1. **Drill-down shell + quick actions** ← this spec's detailed scope
2. Recent commits (git log parser + `hud:getDetail`)
3. Changed files (git status parser)
4. Branch/sync detail + stash + in-progress state

Increments 2–4 each add one rendered block (and, for 2–3, one unit-tested git
parser) fetched via a future `hud:getDetail(repoPath)` IPC. They are out of scope
until greenlit.

## Increment 1 — Drill-down shell + Quick actions

### Behavior
- Rows become clickable. Clicking a normal row opens the detail view for that repo.
- Detail view shows: a header (← back, repo name; then clean/dirty dot, branch,
  ahead/behind) built from the row data already held in the renderer — **no new
  git call**. Below it, four quick-action buttons.
- Back returns to the list.
- Quick actions (`hud:openExternal(repoPath, target)`):
  - **editor** → `code <path>`
  - **terminal** → `wt -d <path>`, falling back to a PowerShell window at that cwd
  - **explorer** → `shell.openPath(path)`
  - **github** → read `origin` via `git remote get-url origin`, normalize to a web
    URL, `shell.openExternal`. On failure (no remote / not openable), the renderer
    shows a brief inline status line under the buttons. (v1 keeps the button always
    visible rather than pre-fetching remote presence.)

### Click vs. drag
The whole `#hud` is the window-drag surface ([renderer.js:91](../../../src/renderer/renderer.js)).
The drag handler must track pointer movement: only move the window once movement
exceeds a small threshold (~4px). On `pointerup`, if movement stayed under the
threshold and the original target was a `.row[data-path]`, treat it as a click and
open that repo's detail. Buttons/inputs are already excluded from drag.

### Files
- **`src/open.js`** (new, pure, unit-tested):
  - `githubUrlFromRemote(remote)` → web URL or `null` (handles `git@host:owner/repo(.git)`,
    `ssh://git@host/owner/repo(.git)`, `https://host/owner/repo(.git)`).
  - `resolveOpenCommand(target, repoPath)` → `{ cmd, args }` for `editor`/`terminal`,
    `null` otherwise (explorer/github handled via Electron `shell`).
- **`src/main.js`**: add `shell` to the electron import; add a `hud:openExternal`
  IPC handler that uses `open.js`, `child_process.spawn` (detached, `shell:true` on
  win32, with the terminal fallback), `shell.openPath`/`shell.openExternal`, and a
  small `getRemoteUrl(repoPath)` (execFile `git remote get-url origin`). Returns
  `{ ok, error? }`.
- **`src/preload.js`**: expose `openExternal(repoPath, target)`.
- **`src/renderer/detail.js`** (new): `detailHtml(repo)` — pure, returns the
  detail-view markup (own `esc`). Exposed on `window`.
- **`src/renderer/renderer.js`**: add `data-path` to normal rows; keep a
  `path → repo` map updated from `hud:update`; view switching (`showList` /
  `showDetail` / picker); drag/click disambiguation; wire back + action buttons;
  inline action status line.
- **`src/renderer/index.html`**: `#detail` container, `<script src="detail.js">`,
  and styles for the detail header, action buttons, and status line. Hide the gear
  while the detail view is open.

### Error handling
- `openExternal` never throws to the renderer; returns `{ ok:false, error }` on
  failure. Renderer surfaces a brief inline message; `code`/`wt` not on PATH →
  caught via the spawn `error` event (terminal then tries the PowerShell fallback).
- Clicking error/loading rows is a no-op in v1 (only normal rows get `data-path`).

### Testing
- **Unit (`node:test`)**: `open.js` — `githubUrlFromRemote` across ssh/https/.git
  variants and an unrecognizable input (→ null); `resolveOpenCommand` for
  editor/terminal/unknown.
- **Manual**: clicking a row opens detail; back returns; each action launches the
  right thing; drag still moves the window (click threshold doesn't fight dragging).

## Out of scope (v1)
Increments 2–4; a provider/plugin system; configurable editor/terminal; live
auto-refresh of the detail header while open (it's a click-time snapshot).
