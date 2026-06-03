# Ideas

A running list of things that could go into git-hud. Nothing here is committed
to — just a parking lot.

## In scope (it's still a git HUD)

### Gaps worth fixing
- **Quit/exit option** — currently the only way to close it is killing the
  process (frameless, no taskbar). A **system tray icon** (show/hide/quit/open
  settings) is the clean fix and the most real gap.
- **Auto-fetch (opt-in)** — the `↓ behind` count is stale until you fetch.
  Background `git fetch` on an interval (global or per-repo toggle) makes
  "behind" live. Off by default because of network cost.
- **Launch on Windows startup** — a "start with Windows" toggle for an
  always-on overlay.

### Nice to have
- **Click a repo → open it** in VS Code / terminal / file explorer. Also gives
  the rows a reason to be interactive again.
- **Filter: only show repos needing attention** (dirty or ahead/behind) to cut
  noise as the list grows.
- **Group the main list by root folder** with small headers, mirroring the picker.
- **Richer status** — mid-merge/rebase indicator, stash count, conflict flag.
- **Quick opacity/theme control** in the ⚙ panel instead of editing JSON.

### Avoid (scope creep)
- Doing commits/pushes/pulls from the HUD — that's a git client. "Click to open
  in editor" is the better sweet spot.
- Multi-monitor placement logic — YAGNI unless actually hit.

## Beyond scope — a general dev/"vibe coder" HUD

Reframe: this is really a **glanceable status-board engine** that polls things
and renders rows. Git is just the first data source. Anything you want to know
without leaving flow fits.

### Build / CI / deploy (highest value)
- **CI status per repo** — green/red for the latest GitHub Actions run on the
  current branch.
- **Deploy status** — last deploy result + env (Vercel/Netlify/Fly).
- **Local dev-server health** — which ports are listening (3000, 5173, 8080…),
  up/down.

### AI / agent flow
- **Running background agents** — show active Claude Code / terminal jobs and
  ping when one finishes.
- **API spend today** — running token/$ counter when driving agents.

### Tests
- **Watch-mode pass/fail** across projects from a test runner in watch.

### System vitals
- Tiny **CPU / RAM / GPU / VRAM** meter (esp. for local LLMs / heavy builds),
  plus battery + network.

### Flow / focus
- **Session timer** — time in flow, or a soft Pomodoro.
- **Next meeting in 25m** — so a calendar event doesn't ambush you.
- **Current task** — pinned from a notes file / Linear / issue.
- **Now-playing** (Spotify) — pure vibe.

### Playful
- **Uncommitted-for-too-long nudge** ("dirty 3h — commit?") — builds on existing
  dirty detection.
- **Commits / lines today**, branch age — small stats, small dopamine.

### Top picks for this profile
CI status · agent-finished pings · dev-server/port health · session timer.

## Architecture note
To go the multi-source route, refactor row rendering into pluggable
**providers** (git is one; ci, ports, timer are others), each emitting rows on
its own cadence. Adding a new glanceable thing then becomes a ~one-file drop-in.
