// Incident log — newest first. To publish an incident: add an entry,
// commit, push; Vercel redeploys automatically. date is UTC YYYY-MM-DD.
export default [
  {
    date: '2026-09-19',
    title: 'Degraded styles on pinfra.app',
    status: 'Resolved',
    body: 'A cached stylesheet served stale after a release; pages rendered unstyled for some visitors until a hard refresh. Fixed by content-hashed asset URLs.',
    window: 'Sep 19, 02:10 – 02:41 UTC',
  },
];
