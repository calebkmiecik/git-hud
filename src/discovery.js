const fs = require('node:fs');
const path = require('node:path');

const SKIP = new Set(['node_modules', '.git']);
const MAX_DEPTH = 6;

// A directory is a repo if it contains a `.git` entry (dir for normal repos,
// file for worktrees/submodules).
function isRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

// Recursively collect repos under `dir`. A directory containing `.git` is a
// repo and we stop descending into it. Skips node_modules and hidden/.dot
// dirs, and caps depth so large trees stay fast.
function findReposUnder(dir, depth, acc) {
  if (depth > MAX_DEPTH) return;
  if (isRepo(dir)) { acc.push(dir); return; }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    findReposUnder(path.join(dir, e.name), depth + 1, acc);
  }
}

// For each root, returns every repo found at any depth beneath it (plus the
// root itself if it's a repo). Returns [{ root, repos: [absPath, ...] }].
function discoverRepos(roots) {
  const groups = [];
  for (const root of roots) {
    const repos = [];
    findReposUnder(root, 0, repos);
    groups.push({ root, repos });
  }
  return groups;
}

module.exports = { discoverRepos, isRepo };
