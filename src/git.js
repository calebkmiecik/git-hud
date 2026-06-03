const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const execFileAsync = promisify(execFile);

// ---- pure parsers ----
function parseBranch(abbrevRefStdout, shortSha) {
  const name = abbrevRefStdout.trim();
  return name === 'HEAD' ? shortSha : name;
}

function parseDirty(porcelainStdout) {
  return porcelainStdout.trim().length > 0;
}

function parseAheadBehind(revListStdout) {
  const line = revListStdout.trim();
  if (!line) return null;
  const [behind, ahead] = line.split(/\s+/).map(Number);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) return null;
  return { behind, ahead };
}

// ---- exec wrappers ----
async function git(repoPath, args) {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args]);
  return stdout;
}

async function getRepoState(repoPath) {
  const name = path.basename(repoPath);
  try {
    const abbrev = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const shortSha = (await git(repoPath, ['rev-parse', '--short', 'HEAD'])).trim();
    const branch = parseBranch(abbrev, shortSha);
    const detached = abbrev.trim() === 'HEAD';
    const dirty = parseDirty(await git(repoPath, ['status', '--porcelain']));

    let ahead = null, behind = null;
    try {
      const rl = await git(repoPath, ['rev-list', '--count', '--left-right', '@{upstream}...HEAD']);
      const ab = parseAheadBehind(rl);
      if (ab) { ahead = ab.ahead; behind = ab.behind; }
    } catch { /* no upstream */ }

    return { path: repoPath, name, branch, detached, dirty, ahead, behind, error: null };
  } catch (e) {
    // A failed spawn (ENOENT on the binary) => git missing. A non-zero git exit
    // (numeric e.code / stderr) => the path isn't a usable git repo.
    const gitMissing = e.code === 'ENOENT' && /spawn/i.test(e.syscall || '');
    return { path: repoPath, name, branch: null, detached: false, dirty: false,
             ahead: null, behind: null, error: gitMissing ? 'git not found' : 'not a git repo' };
  }
}

module.exports = { parseBranch, parseDirty, parseAheadBehind, getRepoState };
