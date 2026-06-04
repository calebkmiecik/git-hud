// Builds the detail-view markup for one repo. Pure — renderer.js wires events.
(function () {
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

  function detailHtml(repo) {
    return `<div class="dhead">
        <button class="back" title="Back to list">←</button>
        <span class="dname">${esc(repo.name)}</span>
      </div>
      <div class="dmeta">
        <span class="dot ${repo.dirty ? 'dirty' : 'clean'}"></span>
        <span class="dbranch">${esc(repo.branch ?? '—')}</span>
        <span class="ab">${esc(abText(repo))}</span>
      </div>
      <div class="dactions">
        <button class="act" data-act="editor">VS Code</button>
        <button class="act" data-act="terminal">Terminal</button>
        <button class="act" data-act="explorer">Explorer</button>
        <button class="act" data-act="github">GitHub</button>
      </div>
      <div class="dstatus" hidden></div>`;
  }

  window.detailHtml = detailHtml;
})();
