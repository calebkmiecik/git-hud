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

// On-demand richer git state for the detail view's branch-info section.
// Never throws; fields fall back to safe defaults on error.
async function getRepoDetail(repoPath) {
  const out = { base: null, baseAhead: null, baseBehind: null,
                stash: 0, conflicts: 0, inProgress: null, error: null };
  try {
    // Ahead/behind vs the remote default branch (origin/HEAD) — used as "the
    // branch you branched off of". git doesn't record the true fork parent, so
    // the remote's default branch (e.g. origin/master) stands in for it.
    try {
      const base = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim();
      if (base && base !== 'origin/HEAD') {
        const ab = parseAheadBehind(await git(repoPath, ['rev-list', '--count', '--left-right', `${base}...HEAD`]));
        if (ab) { out.base = base; out.baseAhead = ab.ahead; out.baseBehind = ab.behind; }
      }
    } catch { /* no remote default / detached */ }

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

module.exports = { countLines, inProgressLabel, getRepoDetail };
