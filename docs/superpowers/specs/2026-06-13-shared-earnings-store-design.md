# git-hud — Shared earnings store (cross-machine month-to-date)

**Date:** 2026-06-13
**Status:** Design approved — building

## Problem

The Kickbacks API returns only `today_usd` and `lifetime_usd` — no month-to-date.
git-hud reconstructs the month from a **local, per-machine** `costLedger.json`, so
a freshly-set-up machine shows ~$0 this month even when you've actually earned
(e.g. $48.52). The seat-coverage / payoff line then looks empty. Caleb works across
multiple machines, so the month figure must be **consistent everywhere**.

## Key insight

`lifetime_usd` is **global** (account-wide) and **monotonic**. So:

> **month-to-date = current_lifetime − lifetime_at_end_of_last_month**

We don't need a continuously-running daily tally — just **periodic lifetime
snapshots keyed by date**, shared across machines. Any machine's snapshot is valid
for all (lifetime is account-global).

## Store: a private git repo

`https://github.com/calebkmiecik/git-hud-data.git` (private, already created),
cloned into git-hud's userData (`<userData>/earnings-data`). Chosen because it's
free, needs no new credentials (git auth via the OS credential manager — no tokens
in git-hud's code), and is fully debuggable with plain git. No OneDrive/cloud-sync
dependency.

### Conflict-free layout — one file per (machine, date)

```
snapshots/2026-06-13.home-pc.json   → { "lifetime": 48.52, "today": 12.0, "at": 1718… }
```

Each machine writes **only its own** `<date>.<machine>.json` files, so git merges
are always automatic — **no content conflicts, ever**. `machine` = sanitized
`os.hostname()`.

## Components

### `src/earningsStore.js` (new)
Pure helpers (unit-tested):
- `snapshotName(date, machine)` → `"<date>.<machine>.json"` (machine sanitized to
  `[a-z0-9-]`).
- `pickBaseline(snapshots, firstOfMonthMs)` → the lifetime as of end of last month:
  the max `lifetime` among snapshots whose date is **strictly before** the 1st, or
  `null` if none.
- `monthToDate(snapshots, currentLifetime, nowMs)` → `currentLifetime − baseline`
  when a baseline exists; otherwise `currentLifetime` (correct while the account is
  younger than the current month; becomes exact once a month boundary has a
  snapshot). Returns `null` only if `currentLifetime` is null.

Git/IO layer (thin, integration-verified, never throws):
- `ensureClone(dir, repoUrl)` — `git clone` if absent; no-op if present.
- `readSnapshots(dir)` — read/parse `snapshots/*.json` → `[{date, machine, lifetime, today}]`.
- `recordSnapshot(dir, {date, machine, lifetime, today})` — write the machine/date
  file, then **throttled** sync: `add` → `commit` → `pull --no-edit` (auto-merge) →
  `push` (one retry on non-fast-forward). Throttle: at most once per `syncMs`
  (default ~10 min) and on first call after startup.
- All git spawns are detached from the UI path (background); failures are logged,
  never surfaced as errors.

### `src/costTracker.js` (modify)
`getCostSnapshot` stops deriving `earnedMonth` from the local `costLedger.json`.
Instead:
1. `fetchKickbacksEarnings()` → `{ today, lifetime }` (unchanged).
2. `earningsStore.recordSnapshot(...)` with today's `lifetime` (throttled; fire-and-forget).
3. `earnedMonth = earningsStore.monthToDate(readSnapshots(dir), lifetime, now)` —
   reads the **local clone** (fast, no network); sync happens on its own cadence.
4. Coverage / payoff math is unchanged; it just consumes the better `earnedMonth`.

**Fallback chain** if the store is unusable (no repo configured, git missing,
clone failed): `earnedMonth = lifetime` (still correct for a <1-month-old account),
then the legacy local `costLedger.json` as a last resort. The panel never breaks.

### `src/config.js` (modify) + this machine's `config.json`
Add an `earnings` block:
```jsonc
"earnings": { "repo": "", "syncMs": 600000 }   // repo "" = disabled (local-only)
```
This machine's userData `config.json` sets `repo` to the `git-hud-data` URL.
`config.example.json` documents it (empty by default).

### `src/main.js` (modify)
On startup: `ensureClone` + an initial `pull`. Pass the resolved clone dir +
config into `getCostSnapshot` (already wired through `hud:getCost`).

## Data flow

```
poll ─► fetchKickbacksEarnings() ─► {today, lifetime}
     ├─► earningsStore.recordSnapshot(lifetime)   (throttled: write+commit+pull+push)
     └─► monthToDate(readSnapshots(localClone), lifetime, now) ─► earnedMonth ─► coverage
startup ─► ensureClone() + pull
```

## Quick win

Because `monthToDate` falls back to `lifetime` when there's no prior-month
baseline, the seat-coverage line shows **$48.52 / $125** the moment this ships —
no waiting for history to accumulate — and self-corrects to exact once a month
boundary is recorded.

## Error handling
- Every git op is wrapped; failure → log + degrade (use local clone / lifetime).
- Offline → reads the last-synced local clone; pushes catch up later.
- Malformed snapshot files are skipped on read.
- `recordSnapshot` is throttled and fire-and-forget; it never blocks `getCostSnapshot`.

## Testing
- **Unit (`node:test`)**: `snapshotName`, `pickBaseline` (none / before-1st only /
  ties), `monthToDate` (no baseline → lifetime; with baseline → delta; null
  lifetime → null).
- **Manual / local**: clone the repo, record a snapshot, confirm the file + commit
  + push land in `git-hud-data`; confirm the panel shows `$48.52 / $125`.

## Out of scope
Charts/history UI; multi-account; storing per-day `today` series for graphs (we
keep `today` in the snapshot for future use but only compute MTD now); real-time
cross-machine push (sync is periodic, eventual).
