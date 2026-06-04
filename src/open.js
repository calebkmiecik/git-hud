// Pure helpers for the detail view's "open externally" quick actions.

// Normalize a git remote URL to a browsable web URL. Returns null if the remote
// is empty or not in a recognizable form. Handles:
//   git@host:owner/repo(.git)         (scp-style ssh)
//   ssh://git@host/owner/repo(.git)
//   https://host/owner/repo(.git)
function githubUrlFromRemote(remote) {
  if (!remote || typeof remote !== 'string') return null;
  const r = remote.trim().replace(/\.git$/, '');
  let m = r.match(/^git@([^:]+):(.+)$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = r.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = r.match(/^https?:\/\/(.+)$/);
  if (m) return `https://${m[1]}`;
  return null;
}

// Resolve the local "open" command for a target. Returns { cmd, args } for the
// targets launched via a child process; null for targets handled by Electron's
// shell (explorer, github) or unknown targets.
function resolveOpenCommand(target, repoPath) {
  switch (target) {
    case 'editor': return { cmd: 'code', args: [repoPath] };
    case 'terminal': return { cmd: 'wt', args: ['-d', repoPath] };
    default: return null;
  }
}

module.exports = { githubUrlFromRemote, resolveOpenCommand };
