# git-hud — Push button (detail view)

**Date:** 2026-06-04
**Status:** Design approved — building

## Goal

A one-click **↑ Push** button in the repo detail view, shown only when pushing is
safe and unambiguous. Push is the one git *mutation* that fits a glanceable HUD:
no message to write, no merge to resolve. Deliberately scoped to push only — no
pull, commit, or force (those are the git-client rabbit hole `IDEAS.md` warns off).

## When it shows

Only when the current branch is **purely ahead of its upstream**:
- `repo.ahead > 0` **and** `repo.behind === 0`.

`repo.ahead`/`repo.behind` come from the existing per-repo state (computed vs
`@{upstream}` in `git.js`). This means:
- No upstream configured → counts are null → button hidden (we don't do `push -u`
  for brand-new branches in v1).
- Behind or diverged → hidden (a plain push would be rejected; resolving that is
  out of scope).

## Behavior

- Button label shows the count: `↑ Push 3 commits`.
- Click → `hud:push(repoPath)` → main runs `git -C <repo> push` (no args: pushes
  the current branch to its upstream using the user's existing credentials/agent).
- While running: button disabled, label `Pushing…`.
- Success → label `Pushed ✓` (button stays disabled). The ahead count refreshes on
  the next monitor poll.
- Failure → re-enable button, show the last line of git's stderr in the existing
  `.dstatus` line (e.g. rejected push, auth failure).

## Files

- **`src/main.js`**: `hud:push` IPC handler + `gitPush(repoPath)` (promisified
  `execFile` `git push`; returns `{ ok, error? }`, never throws; error = last
  stderr line).
- **`src/preload.js`**: expose `push(repoPath)`.
- **`src/renderer/detail.js`**: `pushButtonHtml(repo)` — returns the button markup
  when ahead-only, else `''`; included in `detailHtml` between branch-info and the
  action row.
- **`src/renderer/index.html`**: `.dpush` / `.pushbtn` styles (accent-tinted,
  full-width, disabled state).
- **`src/renderer/renderer.js`**: wire the push button in `showDetail` (disable +
  label states, status-line feedback).

## Error handling
`gitPush` never throws. Auth prompts rely on the user's credential helper / SSH
agent; if none is configured a push may fail (surfaced in the status line) — we do
not attempt interactive auth.

## Testing
- The ahead-only gate is trivial and renderer-side; verified manually (consistent
  with the rest of the detail-view UI/Electron layer). No new pure parser to unit
  test. Existing suite stays green.
- Manual: button appears only when ahead-only; clicking pushes; success/failure
  feedback shows; hidden when behind/diverged or no upstream.

## Out of scope
Pull, commit, force-push, `push -u` for new branches, choosing a remote/branch.
