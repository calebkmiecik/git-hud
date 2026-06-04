# git-hud — Agent pings (hear when an agent is done / needs you)

**Date:** 2026-06-04
**Status:** Design approved — building

## Goal

Play a sound (and show a brief toast) when a Claude Code agent finishes its turn
or needs the user. The first "beyond git" feature — an **event/notification
channel**, separate from the repo rows (no row-provider refactor needed).

## How it listens

Claude Code **hooks** fire commands on events; each command pings git-hud over
**loopback HTTP**:
- `Stop` → `type=stop` ("your turn")
- `Notification` matcher `idle_prompt` → `type=idle` ("your turn")
- `Notification` matcher `permission_prompt` → `type=permission` ("needs you")

`stop` and `idle` both mean "your turn" and tend to fire back-to-back, so the
renderer collapses them with a short per-category debounce (~1.2s). `permission`
is its own, more urgent sound.

If git-hud isn't running the hook's request just fails silently (`-ErrorAction
SilentlyContinue`), so Claude Code is never disrupted.

## Components

### git-hud
- **`src/main.js`** — `http` server bound to `127.0.0.1:<agentPort>`. On request:
  read `type` + `project` query params, reply `204`, and send IPC
  `hud:agentEvent { type, project }` to the renderer. Started in `whenReady`
  after the window; closed on `will-quit`. Listener errors are logged, non-fatal.
- **BrowserWindow `webPreferences`** — add `autoplayPolicy:
  'no-user-gesture-required'` and `backgroundThrottling: false` so sound plays
  even while the overlay is hidden (the common case).
- **`src/config.js`** — new `agentPort` default (`47600`); `config.example.json`
  gains the field.
- **`src/preload.js`** — expose `onAgentEvent(cb)`.
- **`src/renderer/renderer.js`** + **`index.html`** — Web Audio tones (no audio
  files): a soft two-note rising chime for "your turn", an urgent double-beep for
  "needs you"; per-category debounce; a `#toast` that briefly shows the event +
  project basename (visible only when the HUD is open — sound is the primary
  signal).

### Claude Code (global `~/.claude/settings.json`)
Add a `hooks` block (additive — no existing `hooks` key) with `Stop` and two
`Notification` entries, each a one-line `powershell -NoProfile` `Invoke-WebRequest`
to `http://127.0.0.1:47600/?type=<t>&project=<CLAUDE_PROJECT_DIR>` with
`-TimeoutSec 2 -ErrorAction SilentlyContinue`.

## Decisions / notes
- **Port** `47600`, configurable in `config.json`. The hook URL bakes in the port,
  so changing the config port means updating the hooks too (documented).
- **No OS notification / no auto-show** of the overlay in v1 — sound is the ask;
  auto-popping the window would be intrusive. (OS notification is an easy later
  add for "needs you".)
- **SubagentStop** intentionally excluded (too noisy).

## Error handling
Listener bind failure (port in use) is logged; the app keeps working without
pings. Audio context is created lazily and resumed; the no-gesture autoplay policy
avoids the suspended-context problem.

## Testing
- **Unit**: `config` gains an `agentPort` default assertion. Existing suite green.
- **Manual / semi-automated**: POST to `http://127.0.0.1:47600/?type=stop` returns
  `204` (listener up); the user confirms the actual sounds for stop/idle vs
  permission, and that they fire while the overlay is hidden.

## Out of scope
SubagentStop, OS notifications, auto-showing the window, custom/loadable sound
files, per-project sound routing.
