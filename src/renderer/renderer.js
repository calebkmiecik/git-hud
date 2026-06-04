const hudEl = document.getElementById('hud');
const listEl = document.getElementById('list');
const pickerEl = document.getElementById('picker');
const gearEl = document.getElementById('gear');

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
  return `<div class="row">
    <span class="dot ${r.dirty ? 'dirty' : 'clean'}"></span>
    <span class="name">${esc(r.name)}</span>
    <span class="branch">${esc(r.branch)}</span>
    <span class="ab">${esc(abText(r))}</span>
  </div>`;
}

window.hud.onUpdate(({ repos, error }) => {
  const banner = error ? `<div class="banner">${esc(error)}</div>` : '';
  const rows = repos.length
    ? repos.map(rowHtml).join('')
    : '<div class="row loading">No repos selected — click ⚙</div>';
  listEl.innerHTML = banner + rows;
});

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

// ---- drag the window (pointer capture so it can't outrun the cursor) ----
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
  hudEl.setPointerCapture(pid);
  window.hud.getWinPos().then(([wx, wy]) => { drag = { sx, sy, wx, wy, pid }; });
});

hudEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  pendingPos = [drag.wx + (e.screenX - drag.sx), drag.wy + (e.screenY - drag.sy)];
  if (!rafId) rafId = requestAnimationFrame(flushMove);
});

function endDrag(e) {
  if (!drag) return;
  try { hudEl.releasePointerCapture(drag.pid); } catch {}
  drag = null;
}
hudEl.addEventListener('pointerup', endDrag);
hudEl.addEventListener('pointercancel', endDrag);

async function openPicker() {
  await renderPicker();
  pickerEl.hidden = false;
  listEl.hidden = true;
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
