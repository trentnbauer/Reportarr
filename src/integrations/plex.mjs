// Plex: a report source. Users press "Report an issue" in Plex; Reportarr reads those reports from plex.tv and
// replaces the reported file. Everything Plex-specific lives here.
import path from 'node:path';
import { trim, get, why, refused, pass, fail, need, envNumbers, TIMEOUT_MS } from '../util.mjs';

// plex.tv's community API is where "Reported Issues" live (the same data the Plex web app shows)
export const COMMUNITY_URL = () => process.env.PLEX_COMMUNITY_URL || 'https://community.plex.tv/api';

export const ratingKeyOf = (url) => url?.match(/\/library\/metadata\/(\d+)$/)?.[1];
export const idsOf = (guids = []) => Object.fromEntries(guids.map((g) => g.id.split('://')));

// a call to the Plex server itself
export const plexApi = async (src, p) => {
  const r = await fetch(src.url + p, { headers: { 'X-Plex-Token': src.key, Accept: 'application/json' } });
  if (r.status === 404) return {}; // item already deleted or replaced
  if (!r.ok) throw new Error(`plex ${p} ${r.status}`);
  return (await r.json()).MediaContainer;
};

const communityReports = async (src) => {
  const r = await fetch(COMMUNITY_URL(), {
    method: 'POST',
    headers: { 'X-Plex-Token': src.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ reports(first: 50) { nodes { id date url } } }' }),
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error('reports query failed: ' + JSON.stringify(j.errors ?? r.status));
  return j.data.reports.nodes;
};

// A Plex server is told apart by its machine identifier: every report names the server it is about, and one Plex account
// can own several servers, so each source only takes the reports for its own server.
const machineIds = new Map();
async function machineId(src) {
  if (!machineIds.has(src.url)) {
    const r = await fetch(`${src.url}/identity`, { headers: { 'X-Plex-Token': src.key, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`could not identify the Plex server (HTTP ${r.status})`);
    machineIds.set(src.url, (await r.json()).MediaContainer.machineIdentifier);
  }
  return machineIds.get(src.url);
}

const plex = {
  kind: 'plex', label: 'Plex', prefix: 'plex', defaultUrl: 'http://plex:32400',
  // what the settings page shows for one card of this kind
  fields: [{ name: 'url', label: 'URL' }, { name: 'key', label: 'Token', type: 'password', set: 'keySet' }],
  defaults: {},

  // PLEX_URL + PLEX_KEY (or PLEX_TOKEN) is one server; PLEX_2_URL / PLEX_2_KEY / PLEX_2_NAME are more
  fromEnv(e) {
    const out = [], key = e.PLEX_KEY || e.PLEX_TOKEN;
    if (key) out.push({ name: e.PLEX_NAME || 'plex', kind: 'plex', url: trim(e.PLEX_URL || plex.defaultUrl), key });
    for (const n of envNumbers(e, 'PLEX')) {
      const p = `PLEX_${n}`;
      if (e[`${p}_URL`]) out.push({ name: e[`${p}_NAME`] || `plex-${n}`, kind: 'plex', url: trim(e[`${p}_URL`]), key: e[`${p}_KEY`] ?? e[`${p}_TOKEN`] ?? '' });
    }
    return out;
  },
  envLines: (s, n) => [[`PLEX_${n}_NAME`, s.name], [`PLEX_${n}_URL`, s.url], [`PLEX_${n}_KEY`, s.key]],
  // settings saved by older versions (a single Plex, as plexUrl and plexToken)
  legacy: { keys: ['plexUrl', 'plexToken'], entries: (f) => (f.plexToken ? [{ name: 'plex', kind: 'plex', url: trim(f.plexUrl || plex.defaultUrl), key: f.plexToken }] : []) },
  normalize: (s, old) => ({ name: s.name, kind: 'plex', url: trim(s.url), key: s.key || old?.key || '' }),
  isConfigured: (s) => !!(s.key && s.url),

  checkArgs: (req, stored) => ({ url: trim(req.url), token: req.key || stored?.key }),
  async check({ url, token }) {
    const missing = need({ url, token }, 'url', 'token');
    if (missing.length) return fail(`Set ${missing.join(' and ')} first`);
    const r = await get(`${url}/`, { headers: { 'X-Plex-Token': token, Accept: 'application/json' } });
    if (!r.ok) return fail(`Plex server: ${refused(r.status, 'the token')}`);
    const mc = (await r.json()).MediaContainer ?? {};
    const q = await get(COMMUNITY_URL(), {
      method: 'POST', headers: { 'X-Plex-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ reports(first: 2) { nodes { id } } }' }), // plex.tv only accepts first between 2 and 100
    });
    const j = await q.json().catch(() => ({}));
    if (!q.ok || j.errors) return fail(`Plex server "${mc.friendlyName}" is reachable, but plex.tv would not list reports: ${q.ok ? j.errors[0]?.message : refused(q.status, 'the token')}`);
    return pass(`Plex "${mc.friendlyName}" ${mc.version}: token accepted, reports readable`);
  },

  // the open reports for this server, as the nodes the engine tracks
  async fetch(src) {
    const mid = await machineId(src);
    return (await communityReports(src)).filter((n) => n.url?.startsWith(`server://${mid}/`)).map((n) => ({ ...n, kind: 'plex', source: src.name, src }));
  },
  label: (r) => `${!r.src || r.src.name === 'plex' ? 'Plex' : r.src.name} report`,

  // Replace the file a report is about: find the item on the Plex server, then the *arr that owns that exact file.
  async replace(ctx, report) {
    const { c, record } = ctx;
    const src = report.src ?? c.sources.find((x) => x.kind === 'plex'); // the Plex server this report came from
    const base = { reportId: report.id, source: plex.label(report) };
    const key = ratingKeyOf(report.url);
    const m = key && (await plexApi(src, `/library/metadata/${key}`)).Metadata?.[0];
    if (!m) return record({ status: 'skipped', ...base, detail: 'item no longer in Plex (already deleted or replaced): ' + report.url });
    const title = `${m.grandparentTitle ? m.grandparentTitle + ' ' : ''}${m.title}`;
    const files = new Set((m.Media ?? []).flatMap((x) => x.Part.map((p) => path.basename(p.file))));
    const hit = await ctx.locateFromPlex(m, files, (p) => plexApi(src, p));
    if (!hit) return record({ status: 'skipped', ...base, title, detail: 'no Sonarr/Radarr instance owns ' + [...files] });
    await ctx.swap(report, title, hit);
  },
};
export default plex;
