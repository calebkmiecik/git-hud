// Daily cost tracker: today's Claude Code API spend (computed from the local
// JSONL transcripts under ~/.claude/projects) vs. today's Kickbacks ad-revenue
// earnings (fetched from the Kickbacks backend), so you can see if you break even.
//
// Nothing here throws to the caller — compute*/fetch* return result objects with
// an `error` field so the HUD can degrade gracefully (e.g. Claude cost still shows
// when Kickbacks isn't signed in, and vice-versa).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const earningsStore = require('./earningsStore');

// ---- Claude pricing (USD per 1M tokens) -------------------------------------
// Cache write is 1.25x base input for the 5-minute TTL, 2x for the 1-hour TTL;
// cache read is 0.1x base input. Matched by substring against message.model so a
// new dated/aliased id in the same family still resolves.
const PRICING = [
  { test: /fable|mythos/,        input: 10, output: 50, cw5m: 12.5, cw1h: 20, read: 1.0 },
  { test: /opus/,                input: 5,  output: 25, cw5m: 6.25, cw1h: 10, read: 0.5 },
  { test: /sonnet/,              input: 3,  output: 15, cw5m: 3.75, cw1h: 6,  read: 0.3 },
  { test: /haiku/,               input: 1,  output: 5,  cw5m: 1.25, cw1h: 2,  read: 0.1 },
];

function ratesFor(model) {
  const m = String(model || '').toLowerCase();
  return PRICING.find(p => p.test.test(m)) || null;
}

// Cost (USD) of a single message.usage block under the given model's rates.
function usageCost(usage, rates) {
  if (!usage || !rates) return 0;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  // Prefer the 5m/1h cache-creation breakdown when present; otherwise treat the
  // whole cache_creation_input_tokens bucket as the (cheaper) 5-minute write.
  const cc = usage.cache_creation || {};
  let cw5m = cc.ephemeral_5m_input_tokens;
  let cw1h = cc.ephemeral_1h_input_tokens;
  if (cw5m == null && cw1h == null) { cw5m = usage.cache_creation_input_tokens || 0; cw1h = 0; }
  else { cw5m = cw5m || 0; cw1h = cw1h || 0; }
  return (
    input * rates.input +
    output * rates.output +
    cw5m * rates.cw5m +
    cw1h * rates.cw1h +
    cacheRead * rates.read
  ) / 1e6;
}

function claudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// List *.jsonl transcripts touched today (mtime since local midnight). A file
// not modified today can't contain today's entries, so this bounds the scan.
function todaysTranscripts(dir, sinceMs) {
  let entries;
  try { entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    // Node 20 dirents carry parentPath; fall back to the scanned dir.
    const full = path.join(e.parentPath || e.path || dir, e.name);
    try { if (fs.statSync(full).mtimeMs >= sinceMs) out.push(full); } catch { /* vanished */ }
  }
  return out;
}

// Sum today's assistant-message token cost across all transcripts. Dedups by
// message.id so resumed sessions / re-logged lines aren't counted twice.
function computeClaudeCostToday() {
  const dir = claudeProjectsDir();
  if (!fs.existsSync(dir)) return { cost: 0, tokens: 0, error: null, unknownModels: [] };

  const since = startOfTodayMs();
  const sinceIso = new Date(since).toISOString(); // entries before today sort lower as ISO strings
  const seen = new Set();
  const unknown = new Set();
  let cost = 0, tokens = 0;

  for (const file of todaysTranscripts(dir, since)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const msg = rec.message;
      if (!msg || !msg.usage) continue;
      const ts = rec.timestamp || msg.timestamp;
      if (!ts || ts < sinceIso) continue; // not today
      if (msg.id && seen.has(msg.id)) continue;
      if (msg.id) seen.add(msg.id);
      const rates = ratesFor(msg.model);
      if (!rates) { if (msg.model) unknown.add(msg.model); continue; }
      cost += usageCost(msg.usage, rates);
      const u = msg.usage;
      tokens += (u.input_tokens || 0) + (u.output_tokens || 0)
        + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    }
  }
  return { cost, tokens, error: null, unknownModels: [...unknown] };
}

// ---- Kickbacks earnings -----------------------------------------------------
// The Kickbacks VS Code extension keeps a DPAPI-sealed refresh token at
// ~/.kickbacks/auth.json. We unseal it, exchange it for an access token, and
// read /v1/earnings. Access token is cached in memory and only re-minted on
// expiry/401 to keep refresh calls (and thus token rotation) rare.
const KB_AUTH_FILE = path.join(os.homedir(), '.kickbacks', 'auth.json');
const KB_API_BASE = 'https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app';
const DPAPI_PREFIX = 'dpapi:1:';

let kbAccessToken = null;

// DPAPI unprotect/protect via PowerShell (CurrentUser scope, no entropy) — the
// exact scheme the extension uses, so we read/write the same sealed format.
async function dpapiUnprotect(b64) {
  const ps = "Add-Type -AssemblyName System.Security;$e=[Convert]::FromBase64String($env:VIBE_ADS_SECRET);[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser'))";
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { env: { ...process.env, VIBE_ADS_SECRET: b64 } });
  return stdout.replace(/\r?\n$/, '');
}
async function dpapiProtect(text) {
  const ps = "Add-Type -AssemblyName System.Security;$b=[Text.Encoding]::UTF8.GetBytes($env:VIBE_ADS_SECRET);[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { env: { ...process.env, VIBE_ADS_SECRET: text } });
  return stdout.replace(/\r?\n$/, '').trim();
}

// Minimal JSON-over-HTTPS. Resolves { status, body } and never rejects on a
// non-2xx (so a 401 routes to a refresh rather than blowing up).
function requestJson(method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const headers = { accept: 'application/json' };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (token) headers['authorization'] = `Bearer ${token}`;
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 10000 },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = buf ? JSON.parse(buf) : null; } catch { /* leave null */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

// Decrypt the stored refresh token (handles a plain, unsealed value too).
async function readRefreshToken() {
  const raw = JSON.parse(fs.readFileSync(KB_AUTH_FILE, 'utf8'));
  const v = raw.refresh;
  if (typeof v !== 'string' || !v) throw new Error('no refresh token in auth.json');
  if (v.startsWith(DPAPI_PREFIX)) return await dpapiUnprotect(v.slice(DPAPI_PREFIX.length));
  return v;
}

// Exchange the refresh token for an access token. If the server rotates the
// refresh token, re-seal and write it back so our copy stays valid next time.
async function refreshAccessToken() {
  const rt = await readRefreshToken();
  const { status, body } = await requestJson('POST', `${KB_API_BASE}/v1/auth/refresh`, { body: { refresh_token: rt } });
  if (status < 200 || status >= 300 || !body || !body.access_token) {
    throw new Error(`refresh failed (${status})`);
  }
  if (body.refresh_token && body.refresh_token !== rt) {
    try {
      const sealed = DPAPI_PREFIX + (await dpapiProtect(body.refresh_token));
      const raw = JSON.parse(fs.readFileSync(KB_AUTH_FILE, 'utf8'));
      raw.refresh = sealed;
      fs.writeFileSync(KB_AUTH_FILE, JSON.stringify(raw), { mode: 0o600 });
    } catch (e) { console.error('kickbacks: failed to persist rotated token:', e.message); }
  }
  kbAccessToken = body.access_token;
  return kbAccessToken;
}

// { today, lifetime, error }. today/lifetime are numbers (USD); error is a short
// reason string when earnings can't be read (not signed in, offline, etc.).
async function fetchKickbacksEarnings() {
  if (!fs.existsSync(KB_AUTH_FILE)) {
    return { today: null, lifetime: null, error: 'not signed in' };
  }
  try {
    if (!kbAccessToken) await refreshAccessToken();
    let res = await requestJson('GET', `${KB_API_BASE}/v1/earnings`, { token: kbAccessToken });
    if (res.status === 401) { await refreshAccessToken(); res = await requestJson('GET', `${KB_API_BASE}/v1/earnings`, { token: kbAccessToken }); }
    if (res.status < 200 || res.status >= 300 || !res.body) throw new Error(`earnings ${res.status}`);
    const today = parseFloat(res.body.today_usd);
    const lifetime = parseFloat(res.body.lifetime_usd);
    return {
      today: Number.isFinite(today) ? today : null,
      lifetime: Number.isFinite(lifetime) ? lifetime : null,
      error: null,
    };
  } catch (e) {
    return { today: null, lifetime: null, error: e.message || 'fetch failed' };
  }
}

// ---- monthly earnings ledger -----------------------------------------------
// The Kickbacks API only reports today + lifetime — no historical/monthly
// query. So we keep a local ledger of each day's `today_usd` and sum the current
// month from it. It self-completes as the month runs and is exact from the 1st
// of any month we track end-to-end; mid-month adoption leaves earlier days
// unknown (surfaced via `partialDays`).
function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ledgerFile(dir) {
  return path.join(dir, 'costLedger.json');
}

// Record today's earnings (if known) and return this month's accumulated total.
// today_usd only grows within a day, so we keep the max seen for the date.
function updateLedger(dir, todayUsd) {
  const file = ledgerFile(dir);
  let led = { days: {} };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.days) led = j; } catch { /* fresh */ }

  const todayKey = localDateKey();
  if (todayUsd != null && Number.isFinite(todayUsd)) {
    led.days[todayKey] = Math.max(led.days[todayKey] || 0, todayUsd);
  }
  // Prune entries older than ~70 days to bound the file.
  const cutoff = localDateKey(new Date(Date.now() - 70 * 86400_000));
  for (const d of Object.keys(led.days)) if (d < cutoff) delete led.days[d];

  const monthPrefix = todayKey.slice(0, 7); // YYYY-MM
  let monthToDate = 0, trackedDays = 0;
  for (const d of Object.keys(led.days)) {
    if (d.slice(0, 7) === monthPrefix) { monthToDate += led.days[d]; trackedDays++; }
  }
  try { fs.writeFileSync(file, JSON.stringify(led)); } catch (e) { console.error('cost ledger write failed:', e.message); }
  return { monthToDate, trackedDays };
}

// ---- Claude usage allowance -------------------------------------------------
// Session (5h) and weekly (7d) used-% come only from Claude Code's status-line
// JSON, which a forwarder script (scripts/statusline-usage.js) tees to this file.
// We read it here; `stale` flags data older than ~20m (Claude Code idle, or the
// forwarder not wired yet).
const USAGE_FILE = path.join(os.homedir(), '.claude', 'githud-usage.json');
const USAGE_STALE_MS = 20 * 60_000;

function readUsage() {
  try {
    const j = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    const stale = !j.at || (Date.now() - j.at) > USAGE_STALE_MS;
    return {
      session: j.five_hour ? { pct: j.five_hour.used_percentage, resetsAt: j.five_hour.resets_at } : null,
      weekly: j.seven_day ? { pct: j.seven_day.used_percentage, resetsAt: j.seven_day.resets_at } : null,
      at: j.at || null,
      stale,
    };
  } catch {
    return null; // CLI status-line forwarder not wired / unreadable
  }
}

// Live usage via API rate-limit headers. The VS Code extension doesn't run the
// status-line command, but the unified rate-limit headers come back on any
// /v1/messages call — so we make a tiny Haiku call with the OAuth token Claude
// Code already stores and read session (5h) / weekly (7d) utilization from the
// `anthropic-ratelimit-unified-*` response headers. Token is used in-memory only.
const CREDS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const OAUTH_BETA = 'oauth-2025-04-20';
let usageCache = null; // { data, at } — bounds how often we actually hit the API

function readOAuthToken() {
  try {
    const o = (JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')).claudeAiOauth) || {};
    return { token: o.accessToken || null, expiresAt: o.expiresAt || 0 };
  } catch { return { token: null, expiresAt: 0 }; }
}

function fetchClaudeUsage() {
  return new Promise((resolve) => {
    const { token } = readOAuthToken();
    if (!token) { resolve({ error: 'no Claude login found' }); return; }
    const body = JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: '.' }] });
    const req = https.request({
      method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages', timeout: 10000,
      headers: {
        authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01',
        'anthropic-beta': OAUTH_BETA, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const h = res.headers;
      res.on('data', () => {}); // drain
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) { resolve({ error: 'auth expired — open Claude Code' }); return; }
        const num = (k) => { const v = h['anthropic-ratelimit-unified-' + k]; return v == null ? null : parseFloat(v); };
        const u5 = num('5h-utilization'), u7 = num('7d-utilization');
        if (u5 == null && u7 == null) { resolve({ error: `no rate-limit headers (HTTP ${res.statusCode})` }); return; }
        resolve({
          session: u5 == null ? null : { pct: u5 * 100, resetsAt: num('5h-reset'), status: h['anthropic-ratelimit-unified-5h-status'] },
          weekly: u7 == null ? null : { pct: u7 * 100, resetsAt: num('7d-reset'), status: h['anthropic-ratelimit-unified-7d-status'] },
          at: Date.now(), source: 'api', error: null,
        });
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(body); req.end();
  });
}

// Cached usage fetch — only hits the API when the cache is older than maxAgeMs
// (or force). On error, returns the last good reading flagged stale, so a blip
// doesn't blank the bars.
async function getUsage(maxAgeMs, force) {
  if (!force && usageCache && (Date.now() - usageCache.at) < maxAgeMs) return usageCache.data;
  const d = await fetchClaudeUsage();
  if (!d.error) { usageCache = { data: d, at: Date.now() }; return d; }
  if (usageCache) return { ...usageCache.data, stale: true, error: d.error };
  return { session: null, weekly: null, at: null, error: d.error };
}

// Adaptive poll cadence: base interval until the closest window crosses hotPct,
// then ramp linearly down to floor by 100%. Cheap insurance near the wall.
function pollDelayFor(maxPct, base, floor, hotPct) {
  if (!(maxPct >= hotPct)) return base;
  const t = Math.min(1, Math.max(0, (maxPct - hotPct) / (100 - hotPct))); // 0 at hotPct → 1 at 100
  return Math.round(base - t * (base - floor));
}

// A window's rate-limit status is "capped" only when it's actually rejecting.
// The unified header reports `allowed`, `allowed_warning` (near the limit but
// still usable), and `rejected` — so anything outside the `allowed*` family is
// a real cap. (Treating `allowed_warning` as capped wrongly read 75% as "out".)
function isCappedStatus(s) {
  return !!s && !String(s).startsWith('allowed');
}

// ---- pacing: weekly ration + 5h session, most-binding wins ------------------
// Two questions, one verdict. WEEKLY (strategic): weight each hour of the
// reset-to-reset cycle (weekdays heavier than weekends), integrate to "where a
// steady worker should be by now", and compare to actual weekly utilization.
// SESSION (tactical): how close is the rolling 5h window to its wall right now.
// The pill reflects whichever constraint is tighter, so "grind" never overrides
// an imminent short-term throttle. State ∈ go | onpace | slow | capped; binding
// ∈ weekly | session tells the HUD which one drove it (and how to word it).
function computePacing(usage, { weekendWeight = 0, targetPct = 90, bandPct = 5, sessionTargetPct = 100, sessionBandPct = 10, nowSec } = {}) {
  const weekly = usage && usage.weekly;
  if (!weekly || weekly.pct == null || !weekly.resetsAt) return null;
  const reset = weekly.resetsAt;            // unix seconds
  const start = reset - 7 * 86400;          // rolling 7-day cycle start
  const now = nowSec != null ? nowSec : Date.now() / 1000;

  // Weighted-time integral over the cycle, hour by hour (local day-of-week).
  let total = 0, elapsed = 0;
  for (let t = start; t < reset; t += 3600) {
    const dow = new Date(t * 1000).getDay(); // 0=Sun … 6=Sat (local)
    const w = (dow === 0 || dow === 6) ? weekendWeight : 1;
    total += w;
    if (t < now) elapsed += w * Math.min(1, (now - t) / 3600); // partial current hour
  }
  if (total <= 0) return null;

  const pacedFraction = Math.max(0, Math.min(1, elapsed / total));
  const expectedPct = pacedFraction * targetPct;
  const actualPct = weekly.pct;
  const deltaPct = actualPct - expectedPct; // positive = ahead of budget → slow down

  let weeklyState;
  if (isCappedStatus(weekly.status)) weeklyState = 'capped';
  else if (deltaPct <= -bandPct) weeklyState = 'go';
  else if (deltaPct >= bandPct) weeklyState = 'slow';
  else weeklyState = 'onpace';

  // Session (5h) tactical state: position-based against its own time-tick.
  // The 5h window is a fixed budget that resets at resetsAt; expected % = how
  // far the clock is through that window. Running far ahead of the tick means
  // you'll hit the wall before it resets → flag.
  const SESSION_WIN = 5 * 3600;
  const session = usage && usage.session;
  let sessionState = 'ok', sessionPct = null, sessionResetsAt = null, sessionExpectedPct = null, sessionDeltaPct = null;
  if (session && session.pct != null) {
    sessionPct = session.pct; sessionResetsAt = session.resetsAt;
    if (isCappedStatus(session.status)) {
      sessionState = 'capped';
    } else if (sessionResetsAt) {
      const elapsedFrac = Math.max(0, Math.min(1, 1 - (sessionResetsAt - now) / SESSION_WIN));
      sessionExpectedPct = elapsedFrac * sessionTargetPct;
      sessionDeltaPct = sessionPct - sessionExpectedPct; // positive = ahead of the tick
      if (sessionDeltaPct >= sessionBandPct) sessionState = 'warn';
    }
  }

  // Combine by severity; capped > slow/warn > onpace > go. Session ties go to
  // session (it's the more immediate wall).
  const sev = { go: 0, onpace: 1, slow: 2, capped: 3 };
  const wSev = sev[weeklyState];
  const sSev = sessionState === 'capped' ? 3 : sessionState === 'warn' ? 2 : 0;
  let state, binding;
  if (weeklyState === 'capped') { state = 'capped'; binding = 'weekly'; }
  else if (sessionState === 'capped') { state = 'capped'; binding = 'session'; }
  else {
    const finalSev = Math.max(wSev, sSev);
    state = finalSev === 0 ? 'go' : finalSev === 1 ? 'onpace' : 'slow';
    binding = (finalSev >= 2 && sSev >= 2) ? 'session' : 'weekly';
  }

  return {
    state, binding,
    actualPct, expectedPct, deltaPct, pacedFraction, targetPct,
    weeklyState, sessionState, sessionPct, sessionResetsAt, sessionExpectedPct, sessionDeltaPct,
  };
}

// Top-level snapshot for the HUD. Frames cost as the user's plan/seat cost
// (prorated through the month) rather than per-token API spend, since on a seat
// plan the API-equivalent isn't real money out. Includes the API-equivalent as
// an informational figure.
//
// opts: { ledgerDir, monthlyCost }  — monthlyCost in USD (0/unset disables the
// seat-cost math and the bar just shows earnings).
async function getCostSnapshot(opts = {}) {
  const { ledgerDir, monthlyCost = 0, usageAlertPct = 0, fetchUsage = false, usagePollMs = 120000, forceUsage = false, pacingConfig,
          earningsDir = null, machine = null, earningsSyncMs = 600000 } = opts;
  const claude = computeClaudeCostToday();

  // Usage: poll the API for live rate-limit headers when asked (HUD visible);
  // otherwise reuse the cached reading. Fall back to the CLI status-line file
  // if the API yields nothing (e.g. token issue but a CLI session wrote it).
  let usageRes = null;
  if (fetchUsage) usageRes = await getUsage(usagePollMs, forceUsage);
  else if (usageCache) usageRes = { ...usageCache.data, stale: true };
  if (!usageRes || (!usageRes.session && !usageRes.weekly)) {
    const f = readUsage();
    if (f && (f.session || f.weekly)) usageRes = { ...f, error: usageRes && usageRes.error };
  }
  const usage = usageRes && (usageRes.session || usageRes.weekly)
    ? { session: usageRes.session, weekly: usageRes.weekly, at: usageRes.at, stale: !!usageRes.stale }
    : null;
  const usageError = usageRes ? (usageRes.error || null) : null;
  const kb = await fetchKickbacksEarnings();

  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  // Month-to-date earnings, in priority order:
  //   1. shared git store — lifetime delta vs end of last month (cross-machine, exact)
  //   2. legacy local ledger (sum of per-day today_usd)
  //   3. today's lifetime (correct while the account is younger than this month)
  const earnedToday = kb.today;
  let earnedMonth = null, trackedDays = 0, monthExact = false;
  if (earningsDir && kb.lifetime != null) {
    try { earningsStore.recordSnapshot(earningsDir, machine || earningsStore.machineId(), { lifetime: kb.lifetime, today: kb.today }, earningsSyncMs); } catch { /* best-effort */ }
    const mp = earningsStore.localMonthKey(now);
    const snaps = earningsStore.readSnapshots(earningsDir);
    earnedMonth = earningsStore.monthToDate(snaps, kb.lifetime, mp);
    monthExact = earningsStore.pickBaseline(snaps, mp) != null;
    trackedDays = dayOfMonth; // MTD is exact-through-today → projection uses elapsed days
  }
  if (earnedMonth == null && ledgerDir) {
    const ledger = updateLedger(ledgerDir, kb.today);
    earnedMonth = ledger.monthToDate; trackedDays = ledger.trackedDays;
    monthExact = ledger.trackedDays >= dayOfMonth;
  }
  if (earnedMonth == null) earnedMonth = kb.lifetime != null ? kb.lifetime : kb.today;

  const hasPlan = Number.isFinite(monthlyCost) && monthlyCost > 0;
  const seatPerDay = hasPlan ? monthlyCost / daysInMonth : null;
  const targetSoFar = hasPlan ? monthlyCost * (dayOfMonth / daysInMonth) : null; // break-even target by now

  // Seat cost so far this month is exact from the calendar (day-of-month × daily rate).
  const coverageCost = targetSoFar; // = dayOfMonth × seatPerDay
  const coveragePct = (coverageCost && coverageCost > 0 && earnedMonth != null)
    ? (earnedMonth / coverageCost) * 100 : null;
  const coverage = {
    earned: earnedMonth,
    cost: coverageCost,
    pct: coveragePct,
    trackedDays,
    fullMonth: monthExact, // month-to-date is exact (real prior-month baseline or full ledger)
  };

  return {
    // Claude usage allowance (session 5h + weekly 7d), via API rate-limit headers
    usage,
    usageError,
    usageAlertPct,
    // Pacing: weekday-weighted weekly ration + 5h session, most-binding wins
    pacing: usage ? computePacing(usage, pacingConfig) : null,

    // plan / break-even framing
    monthlyCost: hasPlan ? monthlyCost : null,
    seatPerDay,
    targetSoFar,
    dayOfMonth,
    daysInMonth,

    // earnings (real money in)
    earnedToday,
    earnedMonth,
    coverage, // earned vs seat cost over the tracked period (headline)
    kickbacksLifetime: kb.lifetime,
    kickbacksError: kb.error,

    // break-even deltas (earned − cost); positive = ahead
    todayNet: hasPlan && earnedToday != null ? earnedToday - seatPerDay : null,
    monthNet: hasPlan && earnedMonth != null ? earnedMonth - targetSoFar : null,

    // honesty: how many of this month's elapsed days we actually have earnings for
    trackedDays,
    partialMonth: !monthExact,

    // informational: today's token throughput + its API list-price equivalent (not billed on a seat plan)
    apiEquivToday: claude.error ? null : claude.cost,
    tokensToday: claude.error ? null : claude.tokens,
    apiEquivError: claude.error,

    at: Date.now(),
  };
}

module.exports = {
  getCostSnapshot,
  computeClaudeCostToday,
  fetchKickbacksEarnings,
  updateLedger,
  readUsage,
  fetchClaudeUsage,
  computePacing,
  pollDelayFor,
  localDateKey,
  ratesFor,
  usageCost,
  PRICING,
};
