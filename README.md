# pinfra-status

Independent status page for [pinfra.app](https://pinfra.app), designed to run
**outside** pinfra's own infrastructure (Vercel edge). If the platform goes
down, this page stays up.

- One dependency-free edge function (`api/index.js`) probes the public
  surfaces on every visit (cached 60 s) and renders the page.
- Per-day history for the 90-day uptime strips is stored in Upstash Redis
  (Vercel Marketplace KV) — **optional**: without it the page still works,
  it just shows live status only ("collecting data…").
- Incidents are written by hand in `api/incidents.js` — add an entry,
  commit, push; Vercel redeploys.

## Deploy (one time)

1. Push this repo to GitHub and **Import** it in Vercel (defaults are fine —
   no framework, no build step).
2. (Recommended) In the Vercel project: Storage → Marketplace → add
   **Upstash Redis** (free tier). Its env vars (`KV_REST_API_URL`/`TOKEN` or
   `UPSTASH_REDIS_REST_URL`/`TOKEN`) are picked up automatically.
3. Domain: add `status.pinfra.app` in the Vercel project, then create the
   CNAME `status → cname.vercel-dns.com` in Porkbun.

## Probes

| Component | URL | Rule |
|---|---|---|
| Platform | platform.pinfra.app/healthz | 5xx/timeout = outage; ≥1.5 s = degraded |
| Website | pinfra.app/es | idem |
| Published apps | gestion-de-comercio.pinfra.app | two requests: #1 measures the wake-up, #2 (immediate) the warm app. Outage = error/timeout/5xx on either. Degraded = warm ≥ 3 s, or the whole first visit ≥ 5 s. A normal wake-up is not degraded. |

Wake detection: if the app sends `Server-Timing` (`wake;dur=<ms>`, `app;dur=<ms>`)
it is authoritative (`wake` > 0 = it was asleep). Without it, a wake-up is
inferred when request #1 is ≥ 1.2 s and ≥ 1.8× slower than request #2.
Per-day wake counts and durations (median/max) are kept in the KV.
