const hudEl = document.getElementById('hud');

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

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

window.hud.onUpdate(({ repos, error }) => {
  const banner = error ? `<div class="banner">${esc(error)}</div>` : '';
  const rows = repos.length ? repos.map(rowHtml).join('') : '<div class="row loading">No repos configured</div>';
  hudEl.innerHTML = banner + rows;
});
