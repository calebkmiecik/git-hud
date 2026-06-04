const fs = require('node:fs');
const path = require('node:path');

function statePath(appDir) {
  return path.join(appDir, 'state.json');
}

function loadState(appDir) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(appDir), 'utf8'));
    if (!s.enabled || typeof s.enabled !== 'object') s.enabled = {};
    if (!Array.isArray(s.roots)) s.roots = [];
    return s;
  } catch {
    return { enabled: {}, roots: [] };
  }
}

function saveState(appDir, state) {
  fs.writeFileSync(statePath(appDir), JSON.stringify(state, null, 2));
}

// Opt-in: unknown repos are NOT enabled.
function isEnabled(state, repoPath) {
  return state.enabled?.[repoPath] === true;
}

function setEnabled(state, repoPath, on) {
  if (!state.enabled) state.enabled = {};
  if (on) state.enabled[repoPath] = true;
  else delete state.enabled[repoPath];
  return state;
}

function addRoot(state, rootPath) {
  if (!Array.isArray(state.roots)) state.roots = [];
  if (!state.roots.includes(rootPath)) state.roots.push(rootPath);
  return state;
}

function removeRoot(state, rootPath) {
  if (!Array.isArray(state.roots)) state.roots = [];
  state.roots = state.roots.filter(r => r !== rootPath);
  return state;
}

// Manual compare-branch override, per repo. null/absent = auto-detect.
function getBase(state, repoPath) {
  return (state.base && state.base[repoPath]) || null;
}

function setBase(state, repoPath, branch) {
  if (!state.base) state.base = {};
  if (branch) state.base[repoPath] = branch;
  else delete state.base[repoPath];
  return state;
}

module.exports = {
  statePath, loadState, saveState, isEnabled, setEnabled,
  addRoot, removeRoot, getBase, setBase,
};
