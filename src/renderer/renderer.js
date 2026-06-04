const hudEl = document.getElementById('hud');
const listEl = document.getElementById('list');
const pickerEl = document.getElementById('picker');
const detailEl = document.getElementById('detail');
const gearEl = document.getElementById('gear');

let reposByPath = new Map(); // path -> latest repo state, for opening the detail view

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

function abText(r) {
  if (r.ahead == null || r.behind == null) return '';
  const parts = [];
  if (r.ahead) parts.push(`↑${r.ahead}`);
  if (r.behind) parts.push(`↓${r.behind}`);
  return parts.join(' ');
}

function rowHtml(r) {
  if (r.loading) return `<div class="row"><span class="name">${esc(r.name)}</span><span class="loading">…</span></div>`;
  if (r.error) return `<div class="row"><span class="dot dirty"></span><span class="name">${esc(r.name)}</span><span class="err">${esc(r.error)}</span></div>`;
  return `<div class="row" data-path="${esc(r.path)}">
    <span class="dot ${r.dirty ? 'dirty' : 'clean'}"></span>
    <span class="name">${esc(r.name)}</span>
    <span class="branch">${esc(r.branch)}</span>
    <span class="ab">${esc(abText(r))}</span>
  </div>`;
}

window.hud.onUpdate(({ repos, error }) => {
  reposByPath = new Map(repos.map(r => [r.path, r]));
  const banner = error ? `<div class="banner">${esc(error)}</div>` : '';
  const rows = repos.length
    ? repos.map(rowHtml).join('')
    : '<div class="row loading">No repos selected — click ⚙</div>';
  listEl.innerHTML = banner + rows;
});

// ---- detail view ----
function showList() {
  detailEl.hidden = true;
  detailEl.innerHTML = '';
  pickerEl.hidden = true;
  listEl.hidden = false;
  hudEl.classList.remove('detailing');
}

function showDetail(repo) {
  detailEl.innerHTML = window.detailHtml(repo);
  detailEl.querySelector('.back').addEventListener('click', showList);

  // Click-to-push: the ↑N ahead indicator (present only when purely ahead).
  const pushArrow = detailEl.querySelector('.pusharrow');
  if (pushArrow) {
    let busy = false;
    pushArrow.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      statusEl.hidden = true;
      pushArrow.classList.add('pushing');
      const res = await window.hud.push(repo.path);
      pushArrow.classList.remove('pushing');
      if (res && res.ok) {
        pushArrow.classList.add('pushed');
        pushArrow.textContent = '✓';
        setTimeout(() => { if (pushArrow.isConnected) pushArrow.classList.add('done'); }, 1000);
        // stays busy — nothing left to push
      } else {
        busy = false;
        pushArrow.classList.add('failed');
        setTimeout(() => pushArrow.classList.remove('failed'), 450);
        statusEl.textContent = 'Push failed: ' + ((res && res.error) || 'unknown');
        statusEl.hidden = false;
      }
    });
  }

  // Fill the branch-info block once the on-demand git fetch resolves. The
  // isConnected guard skips the update if the user navigated away first.
  const infoEl = detailEl.querySelector('.dinfo');
  window.hud.getDetail(repo.path)
    .then(detail => { if (infoEl.isConnected) infoEl.innerHTML = window.branchInfoHtml(detail); })
    .catch(() => { if (infoEl.isConnected) infoEl.innerHTML = '<span class="dim">couldn\'t load branch info</span>'; });

  const statusEl = detailEl.querySelector('.dstatus');
  detailEl.querySelectorAll('.act').forEach(btn => {
    btn.addEventListener('click', async () => {
      statusEl.hidden = true;
      const res = await window.hud.openExternal(repo.path, btn.dataset.act);
      if (res && !res.ok) {
        statusEl.textContent = res.error === 'no remote'
          ? 'No git remote configured.'
          : `Couldn't open (${res.error}).`;
        statusEl.hidden = false;
      }
    });
  });
  listEl.hidden = true;
  pickerEl.hidden = true;
  detailEl.hidden = false;
  hudEl.classList.add('detailing');
}

// ---- picker ----
function baseName(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

// Path of repo relative to its root, using forward slashes, so nested
// structure (e.g. "category/project") is visible. Falls back to basename.
function relName(root, p) {
  let r = p.startsWith(root) ? p.slice(root.length) : p;
  r = r.replace(/^[\\/]+/, '').replace(/\\/g, '/');
  return r || baseName(p);
}

function paintPicker({ groups, enabled }) {
  const groupsHtml = groups.length
    ? groups.map(g => {
        const repos = g.repos.length
          ? g.repos.map(p => {
              const checked = enabled[p] === true ? 'checked' : '';
              return `<label class="opt"><input type="checkbox" data-path="${esc(p)}" ${checked}/> ${esc(relName(g.root, p))}</label>`;
            }).join('')
          : '<div class="empty">no repos found</div>';
        return `<div class="root"><span class="rootpath">${esc(g.root)}</span><button class="rm" data-root="${esc(g.root)}" title="Remove folder">&times;</button></div>${repos}`;
      }).join('')
    : '<div class="empty">No folders yet — add one below.</div>';
  pickerEl.innerHTML = '<div class="phead">Tracked folders</div>' + groupsHtml
    + '<button id="addRoot">+ Add folder…</button>';

  pickerEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => window.hud.setEnabled(cb.dataset.path, cb.checked));
  });
  pickerEl.querySelectorAll('.rm').forEach(btn => {
    btn.addEventListener('click', async () => paintPicker(await window.hud.removeRoot(btn.dataset.root)));
  });
  pickerEl.querySelector('#addRoot').addEventListener('click', async () => {
    paintPicker(await window.hud.addRoot());
  });
}

async function renderPicker() {
  paintPicker(await window.hud.getPicker());
}

// ---- drag the window / click a row (pointer capture so it can't outrun the cursor) ----
// The whole HUD is the drag surface, so we distinguish a click (open the repo's
// detail view) from a drag (move the window) by a small movement threshold.
const DRAG_THRESHOLD = 4; // px of total travel before it counts as a drag
let drag = null;
let rafId = 0;
let pendingPos = null;

function flushMove() {
  rafId = 0;
  if (pendingPos) window.hud.moveWin(pendingPos[0], pendingPos[1]);
}

hudEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('button, input, label, a')) return; // let controls work
  const pid = e.pointerId, sx = e.screenX, sy = e.screenY;
  const row = e.target.closest('.row[data-path]');
  hudEl.setPointerCapture(pid);
  drag = { sx, sy, wx: null, wy: null, pid, moved: false, row };
  window.hud.getWinPos().then(([wx, wy]) => { if (drag) { drag.wx = wx; drag.wy = wy; } });
});

hudEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.abs(e.screenX - drag.sx) + Math.abs(e.screenY - drag.sy) < DRAG_THRESHOLD) return;
    drag.moved = true;
  }
  if (drag.wx == null) return; // window position not resolved yet
  pendingPos = [drag.wx + (e.screenX - drag.sx), drag.wy + (e.screenY - drag.sy)];
  if (!rafId) rafId = requestAnimationFrame(flushMove);
});

function endDrag() {
  if (!drag) return;
  try { hudEl.releasePointerCapture(drag.pid); } catch {}
  const { moved, row } = drag;
  drag = null;
  // A click (no real movement) on a row, while the list is showing, drills in.
  if (!moved && row && !listEl.hidden) {
    const repo = reposByPath.get(row.dataset.path);
    if (repo) showDetail(repo);
  }
}
hudEl.addEventListener('pointerup', endDrag);
hudEl.addEventListener('pointercancel', endDrag);

async function openPicker() {
  if (!pickerEl.hidden) return; // already open or opening
  pickerEl.hidden = false;      // claim synchronously to block re-entry
  listEl.hidden = true;
  detailEl.hidden = true;       // picker supersedes the detail view if it was open
  hudEl.classList.remove('detailing');
  await renderPicker();
}

function closePicker() {
  pickerEl.hidden = true;
  listEl.hidden = false;
}

gearEl.addEventListener('click', () => {
  if (pickerEl.hidden) openPicker();
  else closePicker();
});

window.hud.onOpenSettings(() => openPicker());
