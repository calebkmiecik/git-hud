// Shared earnings store: a private git repo (git-hud-data) cloned into userData,
// holding one tiny snapshot file per (machine, date) of the global Kickbacks
// `lifetime_usd`. Because lifetime is account-wide and monotonic, month-to-date =
// current_lifetime − lifetime_at_end_of_last_month, computed from the synced
// snapshots — so it's consistent across machines and correct even on a fresh one.
//
// One file per (machine, date) means machines never write the same path, so git
// merges are always automatic — no content conflicts. Nothing here throws: the
// git/IO layer logs and degrades (the caller falls back to `lifetime`).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

// ---- pure helpers (unit-tested) --------------------------------------------

function sanitizeMachine(name) {
  return String(name || 'machine').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'machine';
}

function snapshotName(date, machine) {
  return `${date}.${sanitizeMachine(machine)}.json`;
}

// Lifetime as of the end of last month: the max lifetime among snapshots whose
// YYYY-MM is strictly before monthPrefix. null when there's no prior-month data.
function pickBaseline(snapshots, monthPrefix) {
  let max = null;
  for (const s of snapshots) {
    if (s && s.date && s.date.slice(0, 7) < monthPrefix && Number.isFinite(s.lifetime)) {
      if (max == null || s.lifetime > max) max = s.lifetime;
    }
  }
  return max;
}

// current_lifetime − baseline. With no prior-month baseline, month-to-date is the
// lifetime itself (exact while the account is younger than this month, and exact
// for everyone once a month boundary has been recorded). null if lifetime unknown.
function monthToDate(snapshots, currentLifetime, monthPrefix) {
  if (currentLifetime == null || !Number.isFinite(currentLifetime)) return null;
  const baseline = pickBaseline(snapshots, monthPrefix);
  if (baseline == null) return currentLifetime;
  return Math.max(0, currentLifetime - baseline);
}

// ---- local date keys / machine id ------------------------------------------

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localMonthKey(d = new Date()) {
  return localDateKey(d).slice(0, 7);
}

function machineId() {
  return sanitizeMachine(os.hostname());
}

// ---- git/IO layer (best-effort; never throws) ------------------------------

function git(dir, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout }, (err, stdout = '', stderr = '') =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
  });
}
function gitTop(args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile('git', args, { timeout }, (err, stdout = '', stderr = '') =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
  });
}

// Clone the data repo into `dir` if absent; otherwise pull latest. Returns whether
// the local clone is usable afterward.
async function ensureClone(dir, repoUrl) {
  try {
    if (fs.existsSync(path.join(dir, '.git'))) {
      await git(dir, ['pull', '--no-edit', '--no-rebase']);
      return true;
    }
    if (!repoUrl) return false;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = await gitTop(['clone', repoUrl, dir]);
    if (!r.ok) { console.error('earnings clone failed:', r.stderr.trim()); return false; }
    try { fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true }); } catch { /* ok */ }
    return true;
  } catch (e) { console.error('earnings ensureClone error:', e.message); return false; }
}

// Read every snapshots/*.json from the local clone → [{date, machine, lifetime, today}].
function readSnapshots(dir) {
  const out = [];
  try {
    const snapDir = path.join(dir, 'snapshots');
    for (const f of fs.readdirSync(snapDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8'));
        if (j && Number.isFinite(j.lifetime)) {
          out.push({ date: j.date || f.slice(0, 10), machine: j.machine || '', lifetime: j.lifetime, today: j.today });
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* no clone / no snapshots yet */ }
  return out;
}

// commit + pull + push the local clone. Best-effort; a rejected push is retried
// once after a pull (file-per-machine means the merge is always automatic).
async function syncRepo(dir, machine, date) {
  try {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', `snapshot ${machine} ${date}`]); // no-op if nothing changed
    await git(dir, ['pull', '--no-edit', '--no-rebase']);
    let p = await git(dir, ['push']);
    if (!p.ok) { await git(dir, ['pull', '--no-edit', '--no-rebase']); await git(dir, ['push']); }
  } catch (e) { console.error('earnings sync error:', e.message); }
}

let lastSyncAt = 0;

// Write/merge today's snapshot for this machine (lifetime is monotonic → keep the
// max), then kick off a throttled background sync. Fire-and-forget; never blocks.
function recordSnapshot(dir, machine, { lifetime, today } = {}, syncMs = 600000) {
  try {
    if (!Number.isFinite(lifetime)) return;
    const date = localDateKey();
    const snapDir = path.join(dir, 'snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    const file = path.join(snapDir, snapshotName(date, machine));
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* fresh */ }
    const merged = {
      date, machine: sanitizeMachine(machine),
      lifetime: Math.max(Number(cur.lifetime) || 0, lifetime),
      today: Math.max(Number(cur.today) || 0, Number.isFinite(today) ? today : 0),
      at: Date.now(),
    };
    fs.writeFileSync(file, JSON.stringify(merged));
    if (Date.now() - lastSyncAt > syncMs) {
      lastSyncAt = Date.now();
      syncRepo(dir, sanitizeMachine(machine), date).catch(() => {});
    }
  } catch (e) { console.error('earnings recordSnapshot error:', e.message); }
}

// Convenience: month-to-date for `now` from the local clone + the current lifetime.
function earnedMonthToDate(dir, currentLifetime, now = new Date()) {
  return monthToDate(readSnapshots(dir), currentLifetime, localMonthKey(now));
}

module.exports = {
  sanitizeMachine, snapshotName, pickBaseline, monthToDate,
  localDateKey, localMonthKey, machineId,
  ensureClone, readSnapshots, recordSnapshot, earnedMonthToDate,
};
