// The always-on taskbar strip: three usage bars, nothing else. Rows persist
// across updates and are mutated in place so the fills can transition rather
// than snap (an innerHTML rebuild would destroy the elements mid-animation).
const rowsEl = document.getElementById('rows');

// Windows won't make a window shorter than 64px, so on a 48px taskbar the
// window overhangs the band by `pad`. Padding absorbs exactly the overhang —
// nothing more — so the remaining box IS the taskbar band and `justify-content:
// center` lands the bars dead-centre of it, the way tray icons sit.
function applyGeometry({ pad, edge }) {
  const p = Math.max(0, Number(pad) || 0);
  document.body.style.paddingTop = edge === 'bottom' ? `${p}px` : '0px';
  document.body.style.paddingBottom = edge === 'top' ? `${p}px` : '0px';
}
{
  const q = new URLSearchParams(location.search);
  applyGeometry({ pad: q.get('pad'), edge: q.get('edge') || 'bottom' });
}
window.strip.onGeometry(applyGeometry);

let built = null; // signature of the rows currently in the DOM (null = none)

function message(text) {
  rowsEl.innerHTML = `<div id="msg">${text}</div>`;
  built = null;
}

function rowHtml(label) {
  return `<div class="r">
    <span class="l"></span>
    <div class="b"><div class="t" hidden></div><div class="f"></div></div>
    <span class="p"></span>
  </div>`;
}

// ---- dial variant -------------------------------------------------------
// Same gauge as the HUD's peek view (usage.js), laid out for a wide, short
// strip: three dials in one row. The window is identified by a single character
// inside the arc's bottom gap; usage % sits above time-to-reset to the right,
// since width is plentiful here and height is not.
function paintDials(wins) {
  const sig = 'dials|' + wins.map(x => x.char).join('|');
  if (built !== sig) {
    rowsEl.innerHTML = `<div class="dials">` + wins.map(x =>
      `<div class="du">
         <div class="dial">${window.usage.dialSvg(window.usage.dialState(x.w, x.sec), x.char)}</div>
         <div class="dmeta"><span class="dp"></span><span class="dr"></span></div>
       </div>`).join('') + `</div>`;
    built = sig;
  }
  const units = rowsEl.querySelectorAll('.du');
  wins.forEach((x, i) => {
    const unit = units[i];
    if (!unit) return;
    const s = window.usage.dialState(x.w, x.sec);
    const dialEl = unit.querySelector('.dial');
    if (!window.usage.updateDialEl(dialEl, s)) {
      dialEl.innerHTML = window.usage.dialSvg(s, x.char);
    }
    const p = unit.querySelector('.dp');
    // Bare number: in a column of three, the % signs were pure repetition.
    p.textContent = s.pct != null ? String(Math.round(s.pct)) : '—';
    p.style.color = s.color;
    const at = x.w && x.w.resetsAt;
    unit.querySelector('.dr').textContent = window.usage.compactReset(at, x.fmt) || '—';
    // The tooltip keeps the unabbreviated form, since the strip's is shorthand.
    const reset = window.usage.humanReset(at);
    unit.title = `${x.label} · ${s.pct != null ? Math.round(s.pct) : '—'}% used${reset ? ` · resets in ${reset}` : ''}`;
  });
}

function paintBars(wins) {
  const sig = 'bars|' + wins.map(x => x.short).join('|');
  if (built !== sig) {
    rowsEl.innerHTML = wins.map(x => rowHtml(x.short)).join('');
    built = sig;
  }

  const rows = rowsEl.querySelectorAll('.r');
  wins.forEach((x, i) => {
    const row = rows[i];
    if (!row) return;
    const s = window.usage.barState(x.w, x.sec);
    if (!s) return;
    row.querySelector('.l').textContent = x.short;
    const fill = row.querySelector('.f');
    fill.style.width = s.width + '%';
    fill.style.backgroundColor = s.color;
    const tick = row.querySelector('.t');
    if (s.elapsed != null) { tick.hidden = false; tick.style.left = s.elapsed + '%'; }
    else tick.hidden = true;
    const pct = row.querySelector('.p');
    pct.textContent = Math.round(s.pct) + '%';
    pct.style.color = s.color;
    row.title = `${x.label} · ${Math.round(s.pct)}% used${s.reset ? ` · resets in ${s.reset}` : ''}`;
  });
}

// Which variant is showing. Switchable at runtime from the tray so the two can
// be compared back to back without a restart.
let style = new URLSearchParams(location.search).get('style') === 'dials' ? 'dials' : 'bars';
let latest = null;

function paint(payload) {
  if (payload) latest = payload;
  const u = latest && latest.usage;
  if (!u || (!u.session && !u.weekly && !u.fable)) {
    message(latest && latest.usageError ? String(latest.usageError) : 'loading usage…');
    return;
  }
  const wins = window.usage.windows(u).filter(x => x.w && x.w.pct != null);
  if (!wins.length) { message('no usage data'); return; }
  document.body.classList.toggle('is-dials', style === 'dials');
  if (style === 'dials') paintDials(wins); else paintBars(wins);
}

window.strip.onCost(paint);
window.strip.onStyle((s) => { style = s === 'dials' ? 'dials' : 'bars'; paint(null); });

// The whole strip is one click target: left opens the full HUD, right opens a
// context menu (style switch etc.) — the tray icon is easy to lose in Windows'
// hidden-icons overflow, so the strip carries its own menu.
document.body.addEventListener('click', (e) => { if (e.button === 0) window.strip.openHud(); });
document.body.addEventListener('contextmenu', (e) => { e.preventDefault(); window.strip.menu(); });
document.body.addEventListener('mouseenter', () => document.body.classList.add('dim'));
document.body.addEventListener('mouseleave', () => document.body.classList.remove('dim'));
