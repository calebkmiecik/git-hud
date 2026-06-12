#!/usr/bin/env node
// Claude Code status-line command that doubles as a usage forwarder for git-hud.
//
// Claude Code pipes a JSON blob to its configured statusLine command on stdin;
// that blob is the ONLY place the live session/weekly rate-limit percentages are
// exposed (they're server-computed and not persisted anywhere on disk). This
// script extracts them, writes them to ~/.claude/githud-usage.json for git-hud
// to read, and prints a compact status line (model + usage %) to stdout.
//
// It must never crash the status line: any failure falls back to a minimal line.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const OUT_FILE = path.join(CLAUDE_DIR, 'githud-usage.json');
const DEBUG_FILE = path.join(CLAUDE_DIR, 'githud-statusline-debug.json'); // raw input, for field-shape verification

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Pull a {used_percentage, resets_at} pair out of a window object, tolerating
// snake_case / camelCase / a few likely field-name variants.
function win(o) {
  if (!o || typeof o !== 'object') return null;
  const pct = o.used_percentage ?? o.usedPercentage ?? o.utilization ?? o.percent_used ?? o.percentUsed ?? null;
  const reset = o.resets_at ?? o.resetsAt ?? o.reset_at ?? o.resetAt ?? null;
  return pct == null && reset == null ? null : { used_percentage: pct, resets_at: reset };
}

function main() {
  const raw = readStdin();
  let data = {};
  try { data = JSON.parse(raw); } catch { /* keep {} */ }

  // Always dump the raw input during bring-up so the real schema can be confirmed.
  try { fs.writeFileSync(DEBUG_FILE, raw || '{}'); } catch { /* ignore */ }

  const rl = data.rate_limits || data.rateLimits || (data.usage && data.usage.rate_limits) || {};
  const five = win(rl.five_hour || rl.fiveHour || rl['5h']);
  const seven = win(rl.seven_day || rl.sevenDay || rl.week || rl.weekly || rl['7d']);

  // Only write usage when we actually have a window — don't clobber good data
  // with nulls on renders that lack rate_limits (e.g. before the first API call).
  if (five || seven) {
    try {
      fs.writeFileSync(OUT_FILE, JSON.stringify({ five_hour: five, seven_day: seven, at: Date.now() }));
    } catch { /* ignore */ }
  }

  // Compose the visible status line.
  const model = (data.model && (data.model.display_name || data.model.id)) || 'Claude';
  const parts = [model];
  if (five && five.used_percentage != null) parts.push(`S ${Math.round(five.used_percentage)}%`);
  if (seven && seven.used_percentage != null) parts.push(`W ${Math.round(seven.used_percentage)}%`);
  process.stdout.write(parts.join('  ·  '));
}

main();
