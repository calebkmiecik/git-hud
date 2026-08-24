# git-hud

A small always-on overlay for the git repos you care about: an always-visible
usage strip parked in the empty end of the taskbar, and a panel that slides out
above it with each repo's branch, ahead/behind and clean/dirty status.

## Run

```bash
npm install
npm start
```

The **strip** sits in the taskbar and is always there. The **panel** slides out
of it — press **Ctrl+Alt+G** or left-click the strip to toggle it. Right-click
the strip for its menu (dials vs bars, hide).

The panel is anchored to the strip's corner and isn't movable.

## Configure

Copy `config.example.json` to `config.json` and edit:

- `roots` — folders to scan for repos (recursive)
- `hotkey`, `pollIntervalMs`, `startVisible`, `window` (opacity)
- `strip` — `enabled`, `corner` (bottom-left/bottom-right), `width`,
  `style` (`dials` or `bars`)

Hover the overlay and click **⚙** to pick which repos to track and add/remove
folders. Choices persist in `state.json`. Both `config.json` and `state.json`
are git-ignored.

## Legend

- 🟢 clean · 🟠 uncommitted changes
- white = branch (or short SHA if detached)
- blue `↑N ↓N` = commits ahead / behind upstream (no arrows = no upstream or in sync)
