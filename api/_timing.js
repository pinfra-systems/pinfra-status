// Server-Timing parsing. The platform appends its own metrics AFTER the ones
// the tenant app sends, so when a metric appears more than once the LAST entry
// wins: a tenant cannot spoof `wake`/`app` by sending its own.
// Real format, one metric per header line: "wake;dur=1234.5", "app;dur=56.7".
export function parseServerTiming(h) {
  const out = {};
  if (!h) return out;
  for (const part of h.split(',')) {
    const [name, ...params] = part.trim().split(';');
    const m = /dur=([\d.]+)/.exec(params.join(';'));
    if (name && m) out[name.trim().toLowerCase()] = parseFloat(m[1]); // later overwrites earlier
  }
  return out;
}

// Per-redirect-hop timings -> one object. `wake` happens on one hop only (later
// hops may report wake;dur=0), so take the max across hops; `app` is the final hop's.
export function mergeHops(hops) {
  const out = {};
  for (const t of hops) {
    if ('wake' in t) out.wake = Math.max(out.wake ?? 0, t.wake);
    if ('app' in t) out.app = t.app;
  }
  return out;
}
