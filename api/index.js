// pinfra status — a single edge function, zero npm dependencies.
// Probes the public surfaces, keeps per-day history in Upstash Redis
// (Vercel Marketplace KV) when configured, and renders the page.
// Without KV env vars it still works: live checks only (fail-open).
export const config = { runtime: 'edge' };

const COMPONENTS = [
  { key: 'platform', name: 'Platform', desc: 'platform.pinfra.app — dashboard, publishing & API', url: 'https://platform.pinfra.app/healthz' },
  { key: 'website',  name: 'Website',  desc: 'pinfra.app — landing & guides',                    url: 'https://pinfra.app/es' },
  // Tenant apps are heavier SSR and may pay a scale-to-zero resume on the
  // first hit, so they get a wider degraded threshold than the platform.
  // wake: two-phase probe. Request 1 measures the wake-up (cold start), request 2,
  // sent right after, measures the warm app. degradedMs applies to the warm
  // request only; wakeDegradedMs bounds the whole first visit (edge -> app).
  { key: 'apps',     name: 'Published apps', desc: '*.pinfra.app — the apps our users ship. They sleep after 15 minutes without traffic; the first visit wakes them, which is slower and is expected.', url: 'https://gestion-de-comercio.pinfra.app/', degradedMs: 3000, wake: true, wakeDegradedMs: 5000 },
];
const DEGRADED_MS = 1500;
const TIMEOUT_MS = 6000;
const WAKE_TIMEOUT_MS = 8000;   // the first (possibly cold) request gets more room
// Without a Server-Timing header, a wake-up is inferred when the first request
// is clearly slower than the warm one: >= 1.2 s more AND >= 1.8x. A fresh TLS
// handshake alone costs well under that.
const INFER_MIN_DIFF_MS = 1200;
const INFER_MIN_RATIO = 1.8;
const WAKES_KEPT = 100;         // wake durations stored per day (median/max)
const DAYS = 90;

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

async function kv(cmd) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    if (!r.ok) return null;
    return (await r.json()).result ?? null;
  } catch { return null; }
}

// Server-Timing: "wake;dur=1100, app;dur=210" -> {wake: 1100, app: 210}
function parseServerTiming(h) {
  const out = {};
  if (!h) return out;
  for (const part of h.split(',')) {
    const [name, ...params] = part.trim().split(';');
    const m = /dur=([\d.]+)/.exec(params.join(';'));
    if (name && m) out[name.trim().toLowerCase()] = parseFloat(m[1]);
  }
  return out;
}

// One timed request that follows redirects by hand, so a Server-Timing header
// sent on any hop (the wake happens on the first one) is not lost.
async function timed(url, timeoutMs) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const timing = {};
  try {
    let cur = url;
    for (let hop = 0; ; hop++) {
      const r = await fetch(cur, { signal: ctrl.signal, redirect: 'manual', cache: 'no-store' });
      Object.assign(timing, parseServerTiming(r.headers.get('server-timing')));
      r.body?.cancel().catch(() => {});
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc && hop < 4) { cur = new URL(loc, cur).href; continue; }
      return { ms: Date.now() - t0, status: r.status, timing };
    }
  } catch { return { ms: Date.now() - t0, status: 0, timing, err: true }; }
  finally { clearTimeout(timer); }
}

const isDown = x => x.err || x.status >= 500;

async function probe(c) {
  if (!c.wake) {
    const a = await timed(c.url, TIMEOUT_MS);
    if (isDown(a)) return { state: 'down', ms: a.ms };
    return { state: a.ms >= (c.degradedMs || DEGRADED_MS) ? 'deg' : 'ok', ms: a.ms };
  }
  // Two phases: cold-or-warm first request, then an immediate warm one.
  const a = await timed(c.url, WAKE_TIMEOUT_MS);
  if (isDown(a)) return { state: 'down', ms: a.ms, first: a.ms };
  const b = await timed(c.url, TIMEOUT_MS);
  if (isDown(b)) return { state: 'down', ms: b.ms, first: a.ms };
  // Server-Timing is authoritative when present (even "no wake"); otherwise infer.
  const hasHeader = 'wake' in a.timing || 'app' in a.timing;
  const woke = hasHeader
    ? (a.timing.wake || 0) > 0
    : a.ms - b.ms >= INFER_MIN_DIFF_MS && a.ms >= INFER_MIN_RATIO * b.ms;
  const slow = b.ms >= (c.degradedMs || DEGRADED_MS) || a.ms >= (c.wakeDegradedMs || 5000);
  return {
    state: slow ? 'deg' : 'ok',
    ms: b.ms, first: a.ms, woke,
    wakeMs: woke ? a.ms : null,
    wakeServerMs: woke && hasHeader ? Math.round(a.timing.wake) : null,
    src: hasHeader ? 'header' : 'inferred',
  };
}

const WORSE = { ok: 0, deg: 1, down: 2 };
function todayUTC() { return new Date().toISOString().slice(0, 10); }

// A day is stored as {w: worst state, ok, deg, down: check counters,
// wk: wake-ups seen, wl: their durations in ms (last WAKES_KEPT)}.
// Older days hold only the worst-state string; normalise both shapes.
function dayEntry(v) {
  if (v && typeof v === 'object') return { w: v.w || 'ok', ok: v.ok | 0, deg: v.deg | 0, down: v.down | 0, wk: v.wk | 0, wl: Array.isArray(v.wl) ? v.wl : [] };
  const e = { w: v || null, ok: 0, deg: 0, down: 0, wk: 0, wl: [] };
  if (v) e[v] = 1;
  return e;
}

async function recordHistory(results) {
  // at most one write batch per 55s, guarded by a NX key
  const gate = await kv(['SET', 'probe:gate', '1', 'NX', 'EX', '55']);
  if (gate !== 'OK') return;
  const day = todayUTC();
  for (const { c, r } of results) {
    const raw = await kv(['GET', `hist:${c.key}`]);
    let hist = {};
    try { hist = raw ? JSON.parse(raw) : {}; } catch { hist = {}; }
    const e = dayEntry(hist[day]);
    e[r.state]++;
    if (r.woke) { e.wk++; e.wl = [...e.wl, Math.round(r.wakeMs)].slice(-WAKES_KEPT); }
    if (!e.w || WORSE[r.state] > WORSE[e.w]) e.w = r.state;
    hist[day] = e;
    // keep only the window we render
    const cutoff = new Date(Date.now() - (DAYS + 5) * 864e5).toISOString().slice(0, 10);
    for (const d of Object.keys(hist)) if (d < cutoff) delete hist[d];
    await kv(['SET', `hist:${c.key}`, JSON.stringify(hist)]);
  }
}

async function loadHistory() {
  const out = {};
  for (const c of COMPONENTS) {
    const raw = await kv(['GET', `hist:${c.key}`]);
    try { out[c.key] = raw ? JSON.parse(raw) : {}; } catch { out[c.key] = {}; }
  }
  return out;
}

function stripHTML(hist, live) {
  // Uptime = availability: checks that were not an outage / total checks.
  // A slow answer (deg) still counts as available; performance shows in the
  // bars. Legacy days (worst state only, no counters) weigh as many checks
  // as the average counted day and follow the same rule (deg up, down not).
  const day = todayUTC();
  const cells = [], legacyUp = [];
  let avail = 0, total = 0, countedDays = 0;
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    const e = hist[d] ? dayEntry(hist[d]) : null;
    const n = e ? e.ok + e.deg + e.down : 0;
    let s = e && e.w;
    if (d === day) s = !s || WORSE[live] > WORSE[s] ? live : s;
    let tip = s ? ' · ' + s : '';
    if (e && e.w && e.ok + e.deg + e.down > 0 && typeof hist[d] === 'object') {
      avail += e.ok + e.deg; total += n; countedDays++;
      tip += ` · ${e.ok + e.deg}/${n} checks available`;
      if (e.wk && e.wl.length) tip += ` · ${e.wk} wake-up${e.wk > 1 ? 's' : ''} (median ${secs(median(e.wl))}, max ${secs(Math.max(...e.wl))})`;
    } else if (d === day && !hist[d]) {
      total++; if (live !== 'down') avail++; // live check not persisted yet
    } else if (s) {
      legacyUp.push(s !== 'down');
    }
    const cls = s === 'deg' ? ' class="deg"' : s === 'down' ? ' class="down"' : s ? '' : ' class="nodata"';
    cells.push(`<i${cls} title="${d}${tip}"></i>`);
  }
  const w = countedDays ? Math.max(1, Math.round(total / countedDays)) : 1;
  for (const up of legacyUp) { total += w; if (up) avail += w; }
  const uptime = total ? ((avail / total) * 100).toFixed(2).replace(/\.?0+$/, '') : null;
  return { cells: cells.join(''), uptime };
}

function median(a) {
  if (!a.length) return null;
  const x = [...a].sort((p, q) => p - q), m = x.length >> 1;
  return x.length % 2 ? x[m] : Math.round((x[m - 1] + x[m]) / 2);
}
const fmt = n => Math.round(n).toLocaleString('en-US');
const secs = n => (n / 1000).toFixed(1) + ' s';

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

import incidentsData from './incidents.js';

function incidentsHTML() {
  // Only days that actually had incidents, newest first, capped at the
  // last WINDOW days — a wall of "No incidents reported." is noise.
  const WINDOW = 30;
  const cutoff = new Date(Date.now() - WINDOW * 864e5).toISOString().slice(0, 10);
  const byDate = {};
  for (const inc of incidentsData) if (inc.date >= cutoff) (byDate[inc.date] ??= []).push(inc);
  const days = Object.keys(byDate).sort().reverse();
  if (!days.length) {
    return `<div class="day"><div class="none">No incidents reported in the last ${WINDOW} days.</div></div>`;
  }
  return days.map(key => {
    const label = new Date(key + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const bodies = byDate[key].map(inc => `<div class="inc"><div class="t">${esc(inc.title)}</div><p><b>${esc(inc.status)}</b> — ${esc(inc.body)}</p><p class="ts">${esc(inc.window)}</p></div>`).join('');
    return `<div class="day"><div class="date">${label}</div>${bodies}</div>`;
  }).join('\n');
}

const BANNER = {
  ok:   { text: 'All Systems Operational', color: '#2fbf71', ink: '#0d1f15' },
  deg:  { text: 'Degraded Performance',    color: '#f5c66b', ink: '#241c08' },
  down: { text: 'Partial Outage',          color: '#f08a8a', ink: '#2a0f0f' },
};

export default async function handler(request, context) {
  const results = await Promise.all(COMPONENTS.map(async c => ({ c, r: await probe(c) })));
  // The edge runtime cancels un-awaited promises once the Response is
  // returned — waitUntil keeps the history write alive past the response.
  // Falls back to fire-and-forget if the runtime doesn't provide context.
  const historyWrite = recordHistory(results).catch(() => {});
  context?.waitUntil?.(historyWrite);
  const hist = await loadHistory();

  const overall = results.reduce((w, { r }) => (WORSE[r.state] > WORSE[w] ? r.state : w), 'ok');
  const b = BANNER[overall];
  const STATE_LABEL = { ok: 'Operational', deg: 'Degraded', down: 'Outage' };
  const STATE_COLOR = { ok: '#2fbf71', deg: '#f5c66b', down: '#f08a8a' };

  const REGIONS = { gru1: 'São Paulo', iad1: 'Washington, D.C.', sfo1: 'San Francisco', pdx1: 'Portland', cle1: 'Cleveland', fra1: 'Frankfurt', cdg1: 'Paris', lhr1: 'London', dub1: 'Dublin', arn1: 'Stockholm', hnd1: 'Tokyo', kix1: 'Osaka', icn1: 'Seoul', sin1: 'Singapore', hkg1: 'Hong Kong', bom1: 'Mumbai', syd1: 'Sydney', cpt1: 'Cape Town' };
  const regionCode = (request.headers.get('x-vercel-id') || '').split('::')[0];
  const region = REGIONS[regionCode] || null;

  // Wake-up figure: this check's if it woke the app, otherwise the median of
  // the most recent day that saw wake-ups (the app was already awake now).
  function wakeLine(c, r) {
    let wakes = `<span class="dim">Wakes in — not seen yet</span>`, tip = 'No wake-up has been observed yet.';
    if (r.woke) {
      wakes = `Wakes in <b>${fmt(r.wakeMs)} ms</b>`;
      tip = r.src === 'header' ? `Measured now. Server-side wake: ${fmt(r.wakeServerMs)} ms.` : 'Measured now (inferred: the first request was much slower than the second).';
    } else {
      const h = hist[c.key] || {};
      const d = Object.keys(h).sort().reverse().find(k => dayEntry(h[k]).wl.length);
      if (d) { wakes = `Wakes in <b>~${fmt(median(dayEntry(h[d]).wl))} ms</b>`; tip = `Median of the wake-ups seen on ${d}; the app was already awake on this check.`; }
    }
    const from = region ? `${region} to Helsinki` : `Vercel's edge to Helsinki`;
    const rtt = regionCode === 'gru1' ? ' (that round trip alone costs about 1 s)' : '';
    return `<div class="meta"><span>Responds in <b>${fmt(r.ms)} ms</b></span><span class="sep">·</span><span title="${esc(tip)}">${wakes}</span><span class="idle">first visit after 15 min without use</span></div>
      <div class="net">Both include network time: this check runs from ${esc(from)}${rtt}. The app itself is faster.</div>`;
  }

  const comps = results.map(({ c, r }) => {
    const { cells, uptime } = stripHTML(hist[c.key] || {}, r.state);
    return `<div class="comp">
      <div class="crow"><span class="name">${c.name}</span><span class="q" title="${esc(c.desc)}">?</span><span class="lat">${fmt(r.ms)} ms</span><span class="stat" style="color:${STATE_COLOR[r.state]}">${STATE_LABEL[r.state]}</span></div>
      ${c.wake && r.state !== 'down' ? wakeLine(c, r) : ''}
      <div class="strip">${cells}</div>
      <div class="striplbl"><span class="l">90 days ago</span><hr><span>${uptime ? uptime + ' % uptime' : 'collecting data…'}</span><hr><span class="l">Today</span></div>
    </div>`;
  }).join('\n');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pinfra status</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;650&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{--bg:#191c21;--panel:#20242a;--line:rgba(164,216,255,.12);--txt:#e6edf5;--dim:rgba(230,237,245,.55);--acc:#A4D8FF;--ok:#2fbf71;--warn:#f5c66b;--err:#f08a8a;--maint:#8ab4f8;--mono:'IBM Plex Mono',ui-monospace,monospace}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--txt);font-family:'Inter',system-ui,sans-serif;margin:0;min-height:100vh}
.wrap{max-width:860px;margin:0 auto;padding:40px 24px 64px}
.top{display:flex;align-items:center;gap:10px;margin-bottom:34px}
.top b{font-family:'Space Grotesk',sans-serif;font-size:1.1rem}
.top span.lbl{color:var(--dim);font-size:.9rem}
.back{margin-left:auto;color:var(--acc);font-size:.82rem;text-decoration:none}
.banner{background:${b.color};color:${b.ink};border-radius:10px;padding:16px 20px;font-family:'Space Grotesk',sans-serif;font-weight:650;font-size:1.05rem;display:flex;align-items:center;justify-content:space-between;margin-bottom:30px}
.banner small{font-family:'Inter';font-weight:500;font-size:.75rem;opacity:.75}
.comps{border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:14px}
.comp{background:var(--panel);padding:15px 20px;border-bottom:1px solid var(--line)}
.comp:last-child{border-bottom:none}
.crow{display:flex;align-items:center;gap:8px}
.name{font-weight:600;font-size:.92rem}
.q{color:var(--dim);font-size:.72rem;border:1px solid var(--line);border-radius:50%;width:15px;height:15px;display:inline-flex;align-items:center;justify-content:center;cursor:help}
.lat{margin-left:auto;font-family:var(--mono);font-size:.74rem;color:var(--dim)}
.stat{font-size:.82rem;font-weight:600;margin-left:12px}
.meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin-top:8px;font-size:.78rem;color:var(--dim)}
.meta b{color:var(--txt);font-weight:500;font-family:var(--mono);font-size:.76rem}
.meta .sep{opacity:.5}.meta .dim{font-family:var(--mono);font-size:.76rem}
.meta .idle{flex-basis:100%;font-size:.72rem}
.net{margin-top:4px;font-size:.7rem;color:var(--dim);opacity:.8;line-height:1.5}
.strip{display:flex;gap:2px;margin-top:12px;height:30px}
.strip i{flex:1;border-radius:1.5px;background:var(--ok);min-width:2px}
.strip i:hover{filter:brightness(1.25)}
.strip i.deg{background:var(--warn)}.strip i.down{background:var(--err)}.strip i.nodata{background:rgba(230,237,245,.09)}
.striplbl{display:flex;align-items:center;gap:10px;color:var(--dim);font-size:.7rem;margin-top:8px;font-variant-numeric:tabular-nums}
.striplbl .l{white-space:nowrap}.striplbl hr{flex:1;border:none;border-top:1px solid var(--line);margin:0}
.legend{display:flex;flex-wrap:wrap;gap:16px;color:var(--dim);font-size:.72rem;margin:6px 2px 40px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
h2{font-family:'Space Grotesk',sans-serif;font-size:1.15rem;font-weight:650;border-bottom:1px solid var(--line);padding-bottom:10px;margin:0 0 4px}
.day{padding:18px 0;border-bottom:1px solid var(--line)}
.day .date{font-weight:600;font-size:.9rem;margin-bottom:6px;font-variant-numeric:tabular-nums}
.day .none{color:var(--dim);font-size:.82rem}
.inc .t{color:var(--warn);font-weight:600;font-size:.9rem;margin:8px 0 4px}
.inc p{margin:3px 0;font-size:.8rem;color:var(--dim);line-height:1.55}
.inc b{color:var(--txt);font-weight:600}
.inc .ts{font-family:var(--mono);font-size:.7rem;color:var(--dim)}
.footer{margin-top:40px;display:flex;gap:18px;align-items:center;color:var(--dim);font-size:.76rem;border-top:1px solid var(--line);padding-top:18px;flex-wrap:wrap}
.footer .out{margin-left:auto;text-align:right;max-width:340px;line-height:1.5}
</style></head><body>
<div class="wrap">
  <div class="top"><svg width="24" height="24" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 6 L56 18 L32 30 L8 18 Z" fill="#A4D8FF"/><path d="M8 18 L32 30 L32 58 L8 46 Z" fill="#fafafa"/><path d="M56 18 L32 30 L32 58 L56 46 Z" fill="#fafafa" opacity=".62"/></svg><b>pinfra</b><span class="lbl">status</span><a class="back" href="https://pinfra.app">pinfra.app →</a></div>
  <div class="banner">${b.text} <small>checked just now</small></div>
  <div class="comps">${comps}</div>
  <div class="legend">
    <span><i style="background:var(--ok)"></i>Operational</span>
    <span><i style="background:var(--warn)"></i>Degraded performance</span>
    <span><i style="background:var(--err)"></i>Outage</span>
    <span><i style="background:rgba(230,237,245,.09)"></i>No data</span>
  </div>
  <h2>Past incidents</h2>
  ${incidentsHTML()}
  <div class="footer"><span>Probed live on every visit (cached 60&nbsp;s), from Vercel's edge — outside pinfra's own infrastructure. Uptime is the share of checks that were not an outage; slow responses show as degraded in the bars. Published apps sleep after 15 minutes without traffic, so each check measures a possible wake-up and then the warm app; a normal wake-up is not degraded.</span><span class="out">If something is broken while this page reads green, tell us: soporte@pinfra.app</span></div>
</div></body></html>`;

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, s-maxage=60, stale-while-revalidate=120',
    },
  });
}
