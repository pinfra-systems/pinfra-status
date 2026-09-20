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
  { key: 'apps',     name: 'Published apps', desc: '*.pinfra.app — the apps our users ship',     url: 'https://gestion-de-comercio.pinfra.app/', degradedMs: 3000 },
];
const DEGRADED_MS = 1500;
const TIMEOUT_MS = 6000;
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

async function probe(c) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r = await fetch(c.url, { signal: ctrl.signal, redirect: 'follow', cache: 'no-store' });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (!r.ok && r.status >= 500) return { state: 'down', ms };
    if (ms >= (c.degradedMs || DEGRADED_MS)) return { state: 'deg', ms };
    return { state: 'ok', ms };
  } catch { return { state: 'down', ms: Date.now() - t0 }; }
}

const WORSE = { ok: 0, deg: 1, down: 2 };
function todayUTC() { return new Date().toISOString().slice(0, 10); }

async function recordHistory(results) {
  // at most one write batch per 55s, guarded by a NX key
  const gate = await kv(['SET', 'probe:gate', '1', 'NX', 'EX', '55']);
  if (gate !== 'OK') return;
  const day = todayUTC();
  for (const { c, r } of results) {
    const raw = await kv(['GET', `hist:${c.key}`]);
    let hist = {};
    try { hist = raw ? JSON.parse(raw) : {}; } catch { hist = {}; }
    const prev = hist[day];
    if (!prev || WORSE[r.state] > WORSE[prev]) hist[day] = r.state;
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
  const day = todayUTC();
  const cells = [];
  let okDays = 0, knownDays = 0;
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    let s = hist[d];
    if (d === day) s = !s || WORSE[live] > WORSE[s] ? live : s;
    if (s) { knownDays++; if (s === 'ok') okDays++; }
    const cls = s === 'deg' ? ' class="deg"' : s === 'down' ? ' class="down"' : s ? '' : ' class="nodata"';
    cells.push(`<i${cls} title="${d}${s ? ' · ' + s : ''}"></i>`);
  }
  const uptime = knownDays ? ((okDays / knownDays) * 100).toFixed(2).replace(/\.?0+$/, '') : null;
  return { cells: cells.join(''), uptime };
}

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

  const comps = results.map(({ c, r }) => {
    const { cells, uptime } = stripHTML(hist[c.key] || {}, r.state);
    return `<div class="comp">
      <div class="crow"><span class="name">${c.name}</span><span class="q" title="${esc(c.desc)}">?</span><span class="lat">${r.ms} ms</span><span class="stat" style="color:${STATE_COLOR[r.state]}">${STATE_LABEL[r.state]}</span></div>
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
  <div class="footer"><span>Probed live on every visit (cached 60&nbsp;s), from Vercel's edge — outside pinfra's own infrastructure.</span><span class="out">If something is broken while this page reads green, tell us: soporte@pinfra.app</span></div>
</div></body></html>`;

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, s-maxage=60, stale-while-revalidate=120',
    },
  });
}
