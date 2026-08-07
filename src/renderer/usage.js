// Shared usage-bar logic for both renderers: the full HUD (index.html) and the
// always-on taskbar strip (strip.html). Loaded as a plain script in each; it
// publishes `window.usage`. Kept in one place so the two surfaces can't drift —
// a bar in the strip and the same bar in the HUD must read identically.
(function () {
  // Pace → colour. A bar's fill is a solid colour sampled from a continuous
  // green→amber→red scale by how far the fill sits ahead of / behind its
  // time-tick (fill% − elapsed%). Amber sits at dead-on pace (delta 0); the
  // colour ramps to full green PACE_SPAN points behind and full red PACE_SPAN
  // points ahead, so the hue reads the exact margin, not a bucket. Capped or
  // ≥100% pins to full red.
  const PACE_SPAN = 25;            // points from on-pace to a fully saturated end
  const C_GREEN = [106, 157, 114]; // --green  #6a9d72 — comfortably behind pace
  const C_AMBER = [193, 154, 84];  // --amber  #c19a54 — on pace
  const C_RED   = [189, 98, 89];   // --red    #bd6259 — ahead of pace / capped

  function lerpRgb(a, b, t) {
    return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t));
  }

  function paceColor(pct, elapsed, capped) {
    let rgb;
    if (capped || pct >= 100) rgb = C_RED;
    else if (elapsed == null) rgb = C_GREEN;
    else {
      const t = Math.max(-1, Math.min(1, (pct - elapsed) / PACE_SPAN)); // −1 behind … +1 ahead
      rgb = t <= 0 ? lerpRgb(C_AMBER, C_GREEN, -t) : lerpRgb(C_AMBER, C_RED, t);
    }
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  // How far the clock is through this window, 0-100 (null if reset unknown).
  function elapsedOf(w, windowSec) {
    return w && w.resetsAt
      ? Math.max(0, Math.min(100, (1 - (w.resetsAt - Date.now() / 1000) / windowSec) * 100))
      : null;
  }

  function isCapped(w) {
    return !!(w && w.status && !String(w.status).startsWith('allowed'));
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

  // Terse reset for the strip, where every pixel counts: "2h14" is 2h14m on the
  // 5-hour window, "4d03" is 4d3h on the weekly ones.
  //
  // One shape throughout — <n><unit><nn>. The embedded unit letter is
  // load-bearing: a bare decimal ("2.14") reads as decimal hours, a real
  // convention meaning 2h08m — wrong but plausible, the worst kind of misread.
  // The letter also keeps the two windows distinct, so the same digits can't
  // mean different things depending on which dial they sit under. Padding the
  // second component fixes every value at four characters, so the column never
  // jitters as the numbers tick. Full "2h 14m" form still goes in the tooltip.
  function compactReset(sec, unit) {
    if (!sec) return '';
    const ms = sec * 1000 - Date.now();
    if (ms <= 0) return 'now';
    const [big, small, div] = unit === 'hm'
      ? [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, 'h']
      : [Math.floor(ms / 86400000), Math.floor(ms / 3600000) % 24, 'd'];
    return `${big}${div}${String(small).padStart(2, '0')}`;
  }

  // Everything a bar needs, derived once: width, pace colour, time-tick position.
  function barState(w, windowSec) {
    if (!w || w.pct == null) return null;
    const elapsed = elapsedOf(w, windowSec);
    return {
      pct: w.pct,
      width: Math.min(100, Math.max(0, w.pct)),
      elapsed,
      color: paceColor(w.pct, elapsed, isCapped(w)),
      reset: humanReset(w.resetsAt),
    };
  }

  // The three windows in display order, with the labels each surface uses.
  // `label` is the full name (tooltips), `short` the compact form, and `char` a
  // single glyph for the dial face, where anything longer crowds the arc.
  function windows(u) {
    if (!u) return [];
    const fableModel = (u.fable && u.fable.model) || '';
    // `fmt` picks the compact reset form: h.mm for the 5-hour window, d.hr for
    // the week-long ones.
    return [
      { key: 'session', label: '5h', short: '5h', char: '5', fmt: 'hm', w: u.session, sec: 5 * 3600 },
      { key: 'weekly',  label: '7d', short: '7d', char: '7', fmt: 'dh', w: u.weekly,  sec: 7 * 86400 },
      { key: 'fable',   label: fableModel || 'Fable', short: fableModel.slice(0, 3) || 'Fab',
        char: (fableModel[0] || 'F').toUpperCase(), fmt: 'dh', w: u.fable, sec: 7 * 86400 },
    ];
  }

  // ── dial (gauge) rendering ──────────────────────────────────────────────
  // 270° of arc with a 90° gap at the bottom. Colour reads pace/pressure; hand
  // *position* reads absolute level. Bold hand = usage, thin hand = time through
  // the window, so the gap between them is the pace at a glance.
  //
  // The scale is normally linear (0% bottom-left → 50% up → 100% bottom-right).
  // Once a window reaches BREAK_PCT the dial rescales: 0–90% squeezes into the
  // first two-thirds of the arc and 90–100% opens across the last third, giving
  // the zone that matters 4.5× the angular resolution. The switch is animated,
  // so it reads as the gauge zooming in rather than the hands teleporting. Both
  // hands share the current scale — each mapping is monotonic, so
  // bold-hand-ahead-of-thin-hand still means exactly usage% > elapsed%.
  const SWEEP_DEG = 135;
  const SWEEP = SWEEP_DEG * Math.PI / 180;
  const BREAK_PCT = 90;    // usage at/above which the dial rescales
  const BREAK_POS = 1 / 3; // where 90% sits once expanded (last third = 90–100%)
  const CX = 30, CY = 26, R = 21;

  function dialTip(pos, len) {
    const a = Math.max(-1, Math.min(1, pos)) * SWEEP;
    return [CX + len * Math.sin(a), CY - len * Math.cos(a)];
  }

  // percent (0–100) → hand position (−1 bottom-left … +1 bottom-right).
  function dialPos(pct, expanded) {
    const p = Math.max(0, Math.min(100, pct));
    if (!expanded) return p / 50 - 1;
    return p <= BREAK_PCT
      ? -1 + (p / BREAK_PCT) * (BREAK_POS + 1)
      : BREAK_POS + ((p - BREAK_PCT) / (100 - BREAK_PCT)) * (1 - BREAK_POS);
  }

  // Static geometry, identical for every dial: the arc path and the 90% tick.
  const ARC = (() => {
    const [sx, sy] = dialTip(-1, R), [ex, ey] = dialTip(1, R);
    return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${R} ${R} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  })();
  const TICK = (() => {
    const [x1, y1] = dialTip(BREAK_POS, R - 4), [x2, y2] = dialTip(BREAK_POS, R + 3);
    return { x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2) };
  })();

  // Everything that varies with the data: colour, both hand angles, expanded flag.
  function dialState(w, windowSec) {
    const has = !!(w && w.pct != null);
    const elapsed = elapsedOf(w, windowSec);
    const expanded = has && w.pct >= BREAK_PCT;
    return {
      has,
      pct: has ? w.pct : null,
      color: has ? paceColor(w.pct, elapsed, isCapped(w)) : 'var(--dim)',
      needleDeg: dialPos(has ? w.pct : 0, expanded) * SWEEP_DEG,
      timeDeg: elapsed != null ? dialPos(elapsed, expanded) * SWEEP_DEG : null,
      expanded,
    };
  }

  // Markup with current values already applied, so the first paint doesn't
  // animate in from centre. Hands are drawn pointing straight up and rotated
  // about the hub, so updates only touch `transform` (cheap and animatable).
  // `label` renders inside the arc's bottom gap; omit it to label externally.
  function dialSvg(s, label) {
    const timeHand = s.timeDeg != null
      ? `<line class="dtime dhand" style="transform:rotate(${s.timeDeg.toFixed(2)}deg)"
           x1="${CX}" y1="${CY}" x2="${CX}" y2="${CY - 15}"/>`
      : '';
    const text = label
      ? `<text class="dlab" x="${CX}" y="44">${String(label).replace(/[&<>]/g, '')}</text>` : '';
    return `<svg viewBox="0 0 60 50">
      <path class="darc" style="stroke:${s.color}" d="${ARC}"/>
      <line class="dbreak" style="opacity:${s.expanded ? 1 : 0}"
        x1="${TICK.x1}" y1="${TICK.y1}" x2="${TICK.x2}" y2="${TICK.y2}"/>
      ${timeHand}
      <line class="dneedle dhand" style="transform:rotate(${s.needleDeg.toFixed(2)}deg)"
        x1="${CX}" y1="${CY}" x2="${CX}" y2="${CY - 18}"/>
      <circle class="dhub" cx="${CX}" cy="${CY}" r="2"/>
      ${text}
    </svg>`;
  }

  // Mutate an existing dial in place — this is what lets CSS animate the
  // rescale. Returns false when the time hand appeared/vanished (structure
  // changed), so the caller knows to rebuild instead.
  function updateDialEl(el, s) {
    const arc = el.querySelector('.darc');
    const needle = el.querySelector('.dneedle');
    const tick = el.querySelector('.dbreak');
    const time = el.querySelector('.dtime');
    if (arc) arc.style.stroke = s.color;
    if (needle) needle.style.transform = `rotate(${s.needleDeg.toFixed(2)}deg)`;
    if (tick) tick.style.opacity = s.expanded ? 1 : 0;
    if ((s.timeDeg != null) !== !!time) return false;
    if (time) time.style.transform = `rotate(${s.timeDeg.toFixed(2)}deg)`;
    return true;
  }

  window.usage = {
    paceColor, elapsedOf, isCapped, humanReset, compactReset, barState, windows, PACE_SPAN,
    dialState, dialSvg, updateDialEl, dialPos, BREAK_PCT,
  };
})();
