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

  // Brand logos as inline SVG (fill: currentColor, so they inherit the HUD color).
  const VSCODE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg>';
  const GITHUB_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">'
    + '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
  // Terminal + Explorer use Segoe Fluent / MDL2 Assets glyphs (command prompt, folder).
  const TERMINAL_GLYPH = '<span class="glyph"></span>';
  const EXPLORER_GLYPH = '<span class="glyph"></span>';

  // Push button only when the branch is purely ahead of its upstream
  // (ahead > 0, behind 0/none) — the one safe, one-click push case.
  function pushButtonHtml(repo) {
    const ahead = repo.ahead, behind = repo.behind;
    if (!ahead || behind) return '';
    return `<div class="dpush"><button class="pushbtn">↑ Push ${ahead} commit${ahead === 1 ? '' : 's'}</button></div>`;
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
      <div class="dinfo"><span class="dim">loading…</span></div>
      ${pushButtonHtml(repo)}
      <div class="dactions">
        <button class="act" data-act="editor" title="Open in VS Code"><span class="ico">${VSCODE_SVG}</span><span class="lbl">Code</span></button>
        <button class="act" data-act="terminal" title="Open a terminal here"><span class="ico">${TERMINAL_GLYPH}</span><span class="lbl">Terminal</span></button>
        <button class="act" data-act="explorer" title="Reveal in Explorer"><span class="ico">${EXPLORER_GLYPH}</span><span class="lbl">Explorer</span></button>
        <button class="act" data-act="github" title="Open remote in browser"><span class="ico">${GITHUB_SVG}</span><span class="lbl">GitHub</span></button>
      </div>
      <div class="dstatus" hidden></div>`;
  }

  // ---- branch-info block (filled in after the async hud.getDetail fetch) ----
  function infoRow(k, v, opts) {
    opts = opts || {};
    const cls = opts.warn ? ' warn' : '';
    const title = opts.title ? ` title="${esc(opts.title)}"` : '';
    return `<div class="dinfo-row${cls}"${title}><span class="k">${k}</span><span class="v">${v}</span></div>`;
  }

  // "X ahead · Y behind" / "even", or null when counts are unknown.
  function aheadBehindWords(ahead, behind) {
    if (ahead == null || behind == null) return null;
    if (!ahead && !behind) return 'even';
    const parts = [];
    if (ahead) parts.push(`${ahead} ahead`);
    if (behind) parts.push(`${behind} behind`);
    return parts.join(' · ');
  }

  function divergedText(detail) {
    const words = aheadBehindWords(detail.baseAhead, detail.baseBehind);
    if (words == null) return '<span class="dim">—</span>';
    return words === 'even' ? '<span class="dim">even</span>' : esc(words);
  }

  function branchInfoHtml(detail) {
    if (detail && detail.error) return '<span class="dim">couldn\'t load branch info</span>';
    detail = detail || {};
    const rows = [];
    if (detail.base) {
      rows.push(infoRow('Base', `<span class="dim">${esc(detail.base)}</span>`, { title: detail.base }));
      rows.push(infoRow('Diverged', divergedText(detail)));
    } else {
      rows.push(infoRow('Base', '<span class="dim">no remote default branch</span>'));
    }
    if (detail.stash > 0) rows.push(infoRow('Stashes', String(detail.stash)));
    if (detail.inProgress) rows.push(infoRow('In progress', esc(detail.inProgress), { warn: true }));
    if (detail.conflicts > 0) rows.push(infoRow('Conflicts', String(detail.conflicts), { warn: true }));
    return rows.join('');
  }

  window.detailHtml = detailHtml;
  window.branchInfoHtml = branchInfoHtml;
})();
