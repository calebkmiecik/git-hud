# git-hud

A small always-on-top overlay that shows the current branch, ahead/behind, and
clean/dirty status for the git repos you care about.

## Run

```bash
npm install
npm start
```

The overlay starts hidden — press **Ctrl+Alt+G** to show/hide it. Drag it anywhere.

## Configure

Copy `config.example.json` to `config.json` and edit:

- `roots` — folders to scan for repos (recursive)
- `hotkey`, `pollIntervalMs`, `startVisible`, `window` (position/opacity)

Hover the overlay and click **⚙** to pick which repos to track and add/remove
folders. Choices persist in `state.json`. Both `config.json` and `state.json`
are git-ignored.

## Legend

- 🟢 clean · 🟠 uncommitted changes
- white = branch (or short SHA if detached)
- blue `↑N ↓N` = commits ahead / behind upstream (no arrows = no upstream or in sync)
