const hudEl = document.getElementById('hud');
const listEl = document.getElementById('list');
const pickerEl = document.getElementById('picker');
const detailEl = document.getElementById('detail');
const gearEl = document.getElementById('gear');
const costEl = document.getElementById('cost');

let reposByPath = new Map(); // path -> latest repo state, for opening the detail view
let latestRepos = [];        // last payload, so agent events can re-render the list
let latestError = null;
const attention = new Map();  // repoPath -> 'attn' | 'turn' (agent-event row highlight)
const turnTimers = new Map(); // repoPath -> timeout ('turn' highlight auto-expires)

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
  const att = attention.get(r.path);
  const attClass = att === 'attn' ? ' att-attn' : att === 'turn' ? ' att-turn' : '';
  return `<div class="row${attClass}" data-path="${esc(r.path)}">
    <span class="dot ${r.dirty ? 'dirty' : 'clean'}"></span>
    <span class="name">${esc(r.name)}</span>
    <span class="branch">${esc(r.branch)}</span>
    <span class="ab">${esc(abText(r))}</span>
  </div>`;
}

function renderList() {
  const banner = latestError ? `<div class="banner">${esc(latestError)}</div>` : '';
  const rows = latestRepos.length
    ? latestRepos.map(rowHtml).join('')
    : '<div class="row loading">No repos selected — click ⚙</div>';
  listEl.innerHTML = banner + rows;
}

window.hud.onUpdate(({ repos, error }) => {
  latestRepos = repos;
  latestError = error;
  reposByPath = new Map(repos.map(r => [r.path, r]));
  renderList();
});

// ---- cost/usage bar ----
let latestCost = null;
let usageExpanded = false;                      // usage/pace detail collapsed by default
let earnExpanded = false;                       // earnings detail collapsed by default
const usageAlerted = { session: false, weekly: false, fable: false }; // one chime per threshold crossing

function money(n) {
  return '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Unix-seconds reset time → compact relative string ("2h 14m", "4d 3h", "now").
function humanReset(sec) {
  if (!sec) return '';
  const ms = sec * 1000 - Date.now();
  if (ms <= 0) return 'now';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

// Pacing → pill label/color/reason. Reflects the binding constraint: weekly
// ration most of the time, but the 5h session when it's near its wall.
function paceInfo(p) {
  if (!p) return null;
  const dn = Math.round(Math.abs(p.deltaPct));
  const sReset = humanReset(p.sessionResetsAt) || 'soon';
  if (p.state === 'capped') {
    return p.binding === 'session'
      ? { cls: 'capped', label: 'SESSION CAP', reason: `throttled · resets ${sReset}` }
      : { cls: 'capped', label: 'WEEKLY CAP', reason: 'out for the week' };
  }
  if (p.state === 'go') return { cls: 'go', label: 'GOOD TO GO', reason: `${dn}% under pace · grind` };
  if (p.state === 'onpace') return { cls: 'onpace', label: 'ON PACE', reason: 'right on pace' };
  // slow
  return p.binding === 'session'
    ? { cls: 'slow', label: 'EASE OFF', reason: `session ${Math.round(p.sessionPct)}% · resets ${sReset}` }
    : { cls: 'slow', label: 'SLOW DOWN', reason: `${dn}% over pace · ease up` };
}

// One compact usage line: label · bar (fill + time-tick) · % · reset.
// windowSec sizes the time-tick (how far the clock is through this window);
// flag ∈ '' | 'flag' (subtle, ahead of pace) | 'capped' (throttled).
function urow(label, w, windowSec, flag) {
  if (!w || w.pct == null) return '';
  const width = Math.min(100, Math.max(0, w.pct));
  const tick = w.resetsAt
    ? Math.max(0, Math.min(100, (1 - (w.resetsAt - Date.now() / 1000) / windowSec) * 100))
    : null;
  const tickEl = tick != null ? `<div class="umark" style="left:${tick}%" title="time so far"></div>` : '';
  const cls = flag === 'capped' ? ' capped' : flag === 'flag' ? ' flag' : '';
  return `<div class="urow2${cls}">
    <span class="ulab">${label}</span>
    <div class="ubar">${tickEl}<div class="ufill" style="width:${width}%"></div></div>
    <span class="upct">${Math.round(w.pct)}%</span>
    <span class="ureset2">${humanReset(w.resetsAt) || ''}</span>
  </div>`;
}

// Map a window's pacing state to its bar-highlight class.
function barFlag(state) {
  return state === 'capped' ? 'capped' : (state === 'slow' || state === 'warn') ? 'flag' : '';
}

// Bar-highlight class straight from a window's rate-limit status (for windows
// with no pacing state, like the model-scoped weekly). Anything outside the
// `allowed*` family is a hard cap; `allowed_warning` is a subtle flag.
function statusFlag(w) {
  if (!w || !w.status) return '';
  const s = String(w.status);
  if (!s.startsWith('allowed')) return 'capped';
  return s === 'allowed_warning' ? 'flag' : '';
}

// Headline pacing pill + the two compact allowance rows (each with a time-tick).
function usageBlock(c) {
  const u = c.usage;
  const p = c.pacing;
  const pace = paceInfo(p);
  const chev = `<span class="cexp">${usageExpanded ? '▴' : '▾'}</span>`;
  const pill = pace
    ? `<div class="pace ${pace.cls}"><span class="pdot"></span><span class="plabel">${pace.label}</span><span class="pdelta">${pace.reason}</span>${chev}</div>`
    : '';
  if (!u || (!u.session && !u.weekly && !u.fable)) {
    return pill + `<div class="csub">${c.usageError ? esc(c.usageError) : 'loading usage…'}</div>`;
  }
  // Model-scoped weekly ration (e.g. Fable). Pacing doesn't compute a state for
  // it, so flag straight off its own status (capped when rejecting, flag near it).
  const fableFlag = statusFlag(u.fable);
  return pill
    + urow('5h', u.session, 5 * 3600, p ? barFlag(p.sessionState) : '')
    + urow('7d', u.weekly, 7 * 86400, p ? barFlag(p.weeklyState) : '')
    + urow((u.fable && u.fable.model) || 'Fable', u.fable, 7 * 86400, fableFlag)
    + (u.stale ? `<div class="csub">usage stale — reopen to refresh</div>` : '');
}

// Headline earnings line: have Kickbacks covered the seat cost of the days
// we've tracked? "$earned / $cost · coverage%" (green ≥100, amber below).
function earnLine(c) {
  const chev = `<span class="cexp">${earnExpanded ? '▴' : '▾'}</span>`;
  const cov = c.coverage;
  if (c.kickbacksError || !cov || cov.earned == null) {
    return `<div class="cearn"><span class="cv muted">Kickbacks ${esc(c.kickbacksError || 'n/a')}</span>${chev}</div>`;
  }
  if (cov.cost == null) { // no plan cost configured — just show what's earned
    return `<div class="cearn">KB ${money(cov.earned)} earned${chev}</div>`;
  }
  const covered = cov.pct != null && cov.pct >= 100;
  const pctStr = cov.pct != null ? `<span class="pcov ${covered ? 'over' : 'under'}">${Math.round(cov.pct)}%</span>` : '';
  return `<div class="cearn">KB ${money(cov.earned)} / ${money(cov.cost)} seat · ${pctStr}${chev}</div>`;
}

// A repo-list-style detail row: dot · label · value.
function drow(label, value, dot = '') {
  return `<div class="drow"><span class="ddot ${dot}"></span><span class="dk">${esc(label)}</span><span class="dv">${value}</span></div>`;
}

// 124900000 → "124.9M"
function compactNum(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

// Usage section detail: what you've actually burned today (throughput + API-value).
function usageDetail(c) {
  if (c.tokensToday == null && c.apiEquivToday == null) {
    return `<div class="dhd">Today's usage</div><div class="csub">no usage recorded today</div>`;
  }
  const rows = [`<div class="dhd">Today's usage</div>`];
  rows.push(drow('tokens', compactNum(c.tokensToday), 'wk'));
  if (c.apiEquivToday != null) rows.push(drow('API value', '≈' + money(c.apiEquivToday), 'se'));
  rows.push(`<div class="csub">what this would cost on the metered API — your plan covers it</div>`);
  return rows.join('');
}

// Earnings section detail: the forward-looking + context numbers (not the
// $earned/$cost already on the collapsed line).
function earnDetail(c) {
  const rows = [`<div class="dhd">Earnings</div>`];
  const cov = c.coverage;
  if (cov && cov.cost != null && cov.earned != null && cov.trackedDays > 0 && c.monthlyCost != null && c.daysInMonth) {
    const projMonth = (cov.earned / cov.trackedDays) * c.daysInMonth;
    const projPct = Math.round((projMonth / c.monthlyCost) * 100);
    rows.push(drow('projected', `${money(projMonth)}/mo · ${projPct}%`, 'earn'));
  }
  if (c.earnedToday != null) rows.push(drow('today', money(c.earnedToday), 'earn'));
  if (c.kickbacksLifetime != null) rows.push(drow('lifetime', money(c.kickbacksLifetime), 'cost'));
  if (cov && !cov.fullMonth && cov.earned != null) {
    rows.push(`<div class="csub warn">earnings tracked ${cov.trackedDays} of ${c.dayOfMonth}d — under-reads until a full month</div>`);
  }
  return rows.join('');
}

// Chime once each time a window first crosses the alert threshold (re-arms when it drops back).
function maybeAlert(c) {
  const u = c.usage, thr = c.usageAlertPct;
  if (!u || !thr || u.stale) return;
  let fire = false;
  for (const k of ['session', 'weekly', 'fable']) {
    const w = u[k];
    const over = w && w.pct != null && w.pct >= thr;
    if (over && !usageAlerted[k]) { usageAlerted[k] = true; fire = true; }
    else if (!over) usageAlerted[k] = false;
  }
  if (fire) playUsageAlarm();
}

function renderCost() {
  const c = latestCost;
  if (!c) { costEl.hidden = true; return; }
  maybeAlert(c);
  const usage = usageBlock(c) + (usageExpanded ? usageDetail(c) : '');
  const earn = earnLine(c) + (earnExpanded ? earnDetail(c) : '');
  costEl.innerHTML =
    `<div class="usect" data-sec="usage">${usage}</div>` +
    `<div class="usect" data-sec="earn">${earn}</div>`;
  costEl.classList.remove('refreshing');
  updateCostVisibility();
}

// The cost bar belongs to the list view only — hide it behind picker/detail.
function updateCostVisibility() {
  costEl.hidden = !latestCost || listEl.hidden;
}

window.hud.onCost((payload) => { latestCost = payload; renderCost(); });

// Toggle the earnings/pace detail and refresh in the background. Invoked from
// the drag handler's tap path (a plain click listener is swallowed because the
// HUD captures the pointer for window-dragging — same reason rows are handled there).
async function toggleSection(sec) {
  if (!latestCost) return;
  if (sec === 'usage') usageExpanded = !usageExpanded;
  else if (sec === 'earn') earnExpanded = !earnExpanded;
  else return;
  renderCost();
  costEl.classList.add('refreshing');
  try { latestCost = await window.hud.getCost(); } catch { /* keep prior */ }
  renderCost();
}

// ---- detail view ----
function showList() {
  detailEl.hidden = true;
  detailEl.innerHTML = '';
  pickerEl.hidden = true;
  listEl.hidden = false;
  hudEl.classList.remove('detailing');
  updateCostVisibility();
}

// Tick the ahead count down one-by-one to 0, then pop a green check. The pace
// ramps up quickly to a high top speed through the middle, then eases down as it
// nears 1 — shaped by a sine velocity curve (slow at both ends, fast in between).
function countdownThenCheck(pushArrow, from) {
  const numEl = pushArrow.querySelector('.pa-num');
  const showCheck = () => {
    pushArrow.classList.add('pushed');
    pushArrow.textContent = '✓';
    setTimeout(() => { if (pushArrow.isConnected) pushArrow.classList.add('done'); }, 1000);
  };
  if (!numEl || from <= 0) { showCheck(); return; }

  const N = from;
  const total = Math.min(1700, 450 + N * 60);
  const FLOOR = 0.14; // min speed at the ends; lower => higher peak-to-end ratio
  const speed = (x) => FLOOR + (1 - FLOOR) * Math.sin(Math.PI * x); // 0..1 position -> speed
  // Per-step gaps are inverse to speed, normalized so they sum to `total`.
  const raw = [];
  for (let k = 1; k <= N; k++) raw.push(1 / speed((k - 0.5) / N));
  const sum = raw.reduce((a, b) => a + b, 0);
  let cum = 0;
  const times = raw.map(g => (cum += (g / sum) * total)); // absolute time of each decrement

  const t0 = performance.now();
  let k = 0;
  function step() {
    if (!numEl.isConnected) return; // navigated away mid-countdown
    k++;
    numEl.textContent = String(N - k);
    if (k >= N) { showCheck(); return; }
    setTimeout(step, Math.max(0, times[k] - (performance.now() - t0)));
  }
  setTimeout(step, times[0]);
}

function clearAttention(path) {
  if (turnTimers.has(path)) { clearTimeout(turnTimers.get(path)); turnTimers.delete(path); }
  if (attention.delete(path)) renderList();
}

function showDetail(repo) {
  clearAttention(repo.path); // opening a repo acknowledges its agent highlight
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
        // Ticker the ahead count down to zero (ease-in: gentle, then quick),
        // then pop the green check.
        countdownThenCheck(pushArrow, repo.ahead || 0);
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
  function fillInfo(detail) {
    if (!infoEl.isConnected) return;
    infoEl.innerHTML = window.branchInfoHtml(detail);
    wireBasePicker(detail);
  }

  // Custom searchable, "/"-grouped compare-branch picker.
  function wireBasePicker(detail) {
    const box = infoEl.querySelector('.basetrigger');
    const pop = infoEl.querySelector('.basepop');
    if (!box || !pop) return;
    const search = pop.querySelector('.basesearch');
    const list = pop.querySelector('.baselist');
    const current = detail.baseManual ? detail.base : null;
    const render = () => { list.innerHTML = window.branchListHtml(detail.branches, search.value, current); };

    const onDocDown = (e) => { if (!pop.contains(e.target) && e.target !== box) close(); };
    function open() {
      pop.hidden = false; search.value = ''; render();
      search.focus();
      document.addEventListener('mousedown', onDocDown, true);
    }
    function close() {
      pop.hidden = true;
      document.removeEventListener('mousedown', onDocDown, true);
    }
    async function choose(value) { close(); fillInfo(await window.hud.setBase(repo.path, value || null)); }

    box.addEventListener('click', () => pop.hidden ? open() : close());
    search.addEventListener('input', render);
    list.addEventListener('mousedown', (e) => {
      const it = e.target.closest('.baseitem');
      if (it) { e.preventDefault(); choose(it.dataset.branch); }
    });
    search.addEventListener('keydown', (e) => {
      const items = [...list.querySelectorAll('.baseitem')];
      if (!items.length) return;
      let i = items.findIndex(el => el.classList.contains('kbd'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (i >= 0) items[i].classList.remove('kbd');
        i = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
        items[i].classList.add('kbd');
        items[i].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const t = items[i] || items[0];
        if (t) choose(t.dataset.branch);
      } else if (e.key === 'Escape') {
        e.preventDefault(); close(); box.focus();
      }
    });
  }

  window.hud.getDetail(repo.path)
    .then(fillInfo)
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
  updateCostVisibility();
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
  const secEl = e.target.closest('[data-sec]');
  hudEl.setPointerCapture(pid);
  drag = { sx, sy, wx: null, wy: null, pid, moved: false, row, sec: secEl ? secEl.dataset.sec : null };
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
  const { moved, row, sec } = drag;
  drag = null;
  // A tap (no real movement) on a cost section toggles that section's detail.
  if (!moved && sec && !costEl.hidden) { toggleSection(sec); return; }
  // A click (no real movement) on a row, while the list is showing, drills in.
  if (!moved && row && !listEl.hidden) {
    const repo = reposByPath.get(row.dataset.path);
    if (repo) {
      // A notifying row jumps straight to its VS Code window (focuses the open
      // folder) and clears the highlight; otherwise it drills into the detail view.
      if (attention.has(repo.path)) {
        window.hud.openExternal(repo.path, 'editor');
        clearAttention(repo.path);
      } else {
        showDetail(repo);
      }
    }
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
  updateCostVisibility();
  await renderPicker();
}

function closePicker() {
  pickerEl.hidden = true;
  listEl.hidden = false;
  updateCostVisibility();
}

gearEl.addEventListener('click', () => {
  if (pickerEl.hidden) openPicker();
  else closePicker();
});

window.hud.onOpenSettings(() => openPicker());

// ---- agent pings (sound + repo-row highlight on Claude Code hook events) ----
let audioCtx = null;
function audio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// A single sine note with a quick attack and exponential decay.
function tone(c, freq, start, dur, peak) {
  const osc = c.createOscillator(), g = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g); g.connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.03);
}

function playYourTurn() { const c = audio(), t = c.currentTime; tone(c, 660, t, 0.16, 0.13); tone(c, 880, t + 0.13, 0.22, 0.13); }
function playNeedsYou() { const c = audio(), t = c.currentTime; tone(c, 600, t, 0.12, 0.20); tone(c, 600, t + 0.18, 0.16, 0.20); }
// Usage-threshold alarm: three urgent descending beeps.
function playUsageAlarm() { const c = audio(), t = c.currentTime; tone(c, 880, t, 0.12, 0.2); tone(c, 740, t + 0.15, 0.12, 0.2); tone(c, 620, t + 0.30, 0.2, 0.2); }

// Match an event's project dir to a tracked repo path (case-insensitive, slash- and
// trailing-slash-insensitive), so we can highlight the right row.
function normPath(p) { return String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase(); }
function findRepoPath(project) {
  if (!project) return null;
  const target = normPath(project);
  for (const p of reposByPath.keys()) if (normPath(p) === target) return p;
  return null;
}

// stop + idle both mean "your turn" and fire back-to-back; collapse per category.
const lastPing = {};
window.hud.onAgentEvent(({ type, project }) => {
  const attn = type === 'permission';
  const category = attn ? 'attn' : 'turn';
  const now = performance.now();
  if (lastPing[category] && now - lastPing[category] < 1200) return;
  lastPing[category] = now;

  if (attn) playNeedsYou(); else playYourTurn();

  // Highlight the matching repo row (sound-only if the project isn't tracked).
  const path = findRepoPath(project);
  if (!path) return;
  if (turnTimers.has(path)) { clearTimeout(turnTimers.get(path)); turnTimers.delete(path); }
  // "needs you" outranks a pending "your turn"; don't downgrade attn -> turn.
  if (attn || attention.get(path) !== 'attn') attention.set(path, category);
  renderList();
  // "your turn" is ambient — auto-clear after a bit; "needs you" persists until acknowledged.
  if (!attn) {
    turnTimers.set(path, setTimeout(() => {
      if (attention.get(path) === 'turn') { attention.delete(path); renderList(); }
      turnTimers.delete(path);
    }, 8000));
  }
});
