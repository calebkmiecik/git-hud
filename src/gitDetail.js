const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { parseAheadBehind } = require('./git');
const execFileAsync = promisify(execFile);

// ---- pure helpers ----

// Count non-empty (non-whitespace) lines — used for stash entries and conflicts.
function countLines(stdout) {
  return stdout.split('\n').filter(l => l.trim().length > 0).length;
}

// Derive the in-progress operation from which .git marker files/dirs exist.
// Rebase wins over merge (a rebase can leave MERGE_HEAD-like state mid-conflict).
function inProgressLabel(markers) {
  if (markers.rebaseMerge || markers.rebaseApply) return 'rebase';
  if (markers.mergeHead) return 'merge';
  if (markers.cherryPick) return 'cherry-pick';
  if (markers.revertHead) return 'revert';
  return null;
}

// ---- fetch ----

async function git(repoPath, args) {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args]);
  return stdout;
}

// ---- base-branch (fork parent) detection ----

const MAIN_BRANCHES = new Set(['main', 'master', 'develop', 'development', 'trunk']);

function lastSeg(ref) {
  const i = ref.lastIndexOf('/');
  return i === -1 ? ref : ref.slice(i + 1);
}

// The current branch's own refs (local + its remote-tracking copies) are the
// upstream relationship, not a fork parent — never treat them as the base.
function isOwnIdentity(ref, current) {
  if (ref === current) return true;
  const m = /^[^/]+\/(.+)$/.exec(ref);
  return !!m && m[1] === current;
}

// Pick the most likely fork parent from scored candidates. Primary signal:
// fewest commits on HEAD since the merge-base (most recent divergence). Ties
// break toward main-ish branches, then local, then shorter ref name.
function pickBaseBranch(cands) {
  if (!cands.length) return null;
  return cands.slice().sort((a, b) =>
    a.ahead - b.ahead
    || (b.mainish - a.mainish)
    || (b.local - a.local)
    || a.ref.length - b.ref.length
  )[0].ref;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The TRUE fork parent, read from the HEAD reflog: the branch you were on when
// this branch was created ("checkout: moving from <src> to <current>"). The
// reflog is newest-first, so we scan from the end for the earliest such entry
// (the creation event). Returns the source branch name, or null when there's no
// record (branch created in another clone, reflog expired, or forked off a
// detached SHA). Pure — takes raw reflog text.
function parseReflogParent(reflogText, current) {
  const lines = reflogText.split('\n').map(s => s.trim()).filter(Boolean);
  const re = new RegExp(`^checkout: moving from (.+) to ${escapeRegex(current)}$`);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = re.exec(lines[i]);
    if (m) {
      const src = m[1].trim();
      if (!src || src === current) return null;
      if (/^[0-9a-f]{7,40}$/i.test(src)) return null; // forked off a detached SHA, not a branch
      return src;
    }
  }
  return null;
}

async function reflogParent(repoPath, current) {
  let out = '';
  try { out = await git(repoPath, ['reflog', 'show', '--format=%gs', 'HEAD']); }
  catch { return null; }
  return parseReflogParent(out, current);
}

// Score every other branch by how recently HEAD diverged from it and pick the
// best. git doesn't record the true fork parent, so this is a heuristic.
//
// Fast path: `%(ahead-behind:HEAD)` (git >= 2.41) computes ahead/behind for
// every ref in a single revision walk, so this is ~2 git calls regardless of
// branch count — not one merge-base spawn per branch. For ref R vs HEAD it
// prints "<R-only> <HEAD-only>"; HEAD-only is how far HEAD diverged from R.
// Returns { ref, baseAhead, baseBehind } or null.
async function detectBase(repoPath, current) {
  // 1. Reflog — the actual branch this was forked from, when recorded locally.
  const rp = await reflogParent(repoPath, current);
  if (rp) {
    try {
      const ab = parseAheadBehind(await git(repoPath, ['rev-list', '--count', '--left-right', `${rp}...HEAD`]));
      if (ab) return { ref: rp, baseAhead: ab.ahead, baseBehind: ab.behind, exact: true };
    } catch { /* source branch is gone — fall through to the heuristic */ }
  }

  // 2. Heuristic — most recent divergence (no reflog record available).
  const cands = [];
  const collect = async (scope, local) => {
    let out = '';
    try {
      out = await git(repoPath, ['for-each-ref', '--format=%(refname:short) %(ahead-behind:HEAD)', scope]);
    } catch { return; }
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;                 // ref shares no history → no counts
      const ref = parts[0];
      const refOnly = Number(parts[1]);               // commits in ref not in HEAD (base "behind")
      const headOnly = Number(parts[2]);              // commits in HEAD not in ref (divergence)
      if (!Number.isFinite(headOnly) || headOnly === 0) continue; // ref contains HEAD → not a parent
      if (lastSeg(ref) === 'HEAD') continue;          // skip origin/HEAD alias
      if (isOwnIdentity(ref, current)) continue;
      cands.push({ ref, ahead: headOnly, refOnly, local, mainish: MAIN_BRANCHES.has(lastSeg(ref)) ? 1 : 0 });
    }
  };
  await Promise.all([collect('refs/heads', 1), collect('refs/remotes', 0)]);

  const ref = pickBaseBranch(cands);
  if (!ref) return null;
  const c = cands.find(x => x.ref === ref);
  return { ref, baseAhead: c.ahead, baseBehind: c.refOnly, exact: false };
}

// On-demand richer git state for the detail view's branch-info section.
// Never throws; fields fall back to safe defaults on error.
async function getRepoDetail(repoPath) {
  const out = { base: null, baseAhead: null, baseBehind: null, baseExact: false,
                stash: 0, conflicts: 0, inProgress: null, error: null };
  try {
    // Fork parent: the reflog's recorded source branch (exact) when available,
    // else the most-recent-divergence heuristic, else the remote default branch.
    try {
      const current = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      let info = (current && current !== 'HEAD') ? await detectBase(repoPath, current) : null;
      if (!info) {
        // Fall back to the remote default branch when no fork parent is found.
        const def = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).catch(() => '')).trim();
        if (def && def !== 'origin/HEAD' && def !== current) {
          const ab = parseAheadBehind(await git(repoPath, ['rev-list', '--count', '--left-right', `${def}...HEAD`]));
          if (ab) info = { ref: def, baseAhead: ab.ahead, baseBehind: ab.behind, exact: false };
        }
      }
      if (info) {
        out.base = info.ref; out.baseAhead = info.baseAhead;
        out.baseBehind = info.baseBehind; out.baseExact = !!info.exact;
      }
    } catch { /* detached / no refs */ }

    try { out.stash = countLines(await git(repoPath, ['stash', 'list'])); } catch { /* none */ }
    try { out.conflicts = countLines(await git(repoPath, ['diff', '--name-only', '--diff-filter=U'])); } catch { /* none */ }

    try {
      const gitDir = (await git(repoPath, ['rev-parse', '--absolute-git-dir'])).trim();
      const has = (p) => { try { return fs.existsSync(path.join(gitDir, p)); } catch { return false; } };
      out.inProgress = inProgressLabel({
        rebaseMerge: has('rebase-merge'),
        rebaseApply: has('rebase-apply'),
        mergeHead: has('MERGE_HEAD'),
        cherryPick: has('CHERRY_PICK_HEAD'),
        revertHead: has('REVERT_HEAD'),
      });
    } catch { /* leave null */ }
  } catch {
    out.error = 'git error';
  }
  return out;
}

module.exports = { countLines, inProgressLabel, pickBaseBranch, parseReflogParent, getRepoDetail };
