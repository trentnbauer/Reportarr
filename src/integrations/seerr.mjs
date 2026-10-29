// Overseerr / Seerr: a report source. Users report an issue on a title; Reportarr replaces its file(s) and then
// comments on and resolves the issue. Everything specific to it lives here.
import { trim, get, work, pass, fail, need, envNumbers } from '../util.mjs';

// Overseerr names issue types by number
const ISSUE_TYPE = { 1: 'video', 2: 'audio', 3: 'subtitles', 4: 'other' };
export const ISSUE_TYPES = Object.values(ISSUE_TYPE);
const DEFAULT_TYPES = 'video,audio,other';
export const normalizeTypes = (v) => {
  const t = String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s, i, a) => ISSUE_TYPES.includes(s) && a.indexOf(s) === i);
  return (t.length ? t : DEFAULT_TYPES.split(',')).join(',');
};

const api = async (src, method, p, body) => {
  const r = await work(`${trim(src.url)}/api/v1${p}`, {
    method,
    headers: { 'X-Api-Key': src.key, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`overseerr ${method} ${p} ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};

const seerr = {
  kind: 'seerr', label: 'Overseerr / Seerr', prefix: 'seerr', defaultUrl: 'http://overseerr:5055',
  fields: [
    { name: 'url', label: 'URL' },
    { name: 'key', label: 'API key', type: 'password', set: 'keySet', hint: 'Settings → General' },
    { name: 'issueTypes', label: 'Issue types to replace', hint: 'video, audio, subtitles, other' },
  ],
  switches: [{ name: 'resolve', label: 'Resolve issues', hint: 'Comment and resolve after replacing' }],
  defaults: { issueTypes: DEFAULT_TYPES, resolve: true },

  // OVERSEERR_URL + OVERSEERR_KEY is one instance; OVERSEERR_2_URL / _KEY / _NAME / _ISSUE_TYPES / _RESOLVE are more
  fromEnv(e) {
    const out = [];
    if (e.OVERSEERR_URL) out.push({ name: e.OVERSEERR_NAME || 'overseerr', kind: 'seerr', url: trim(e.OVERSEERR_URL), key: e.OVERSEERR_KEY || e.OVERSEERR_API_KEY || '', issueTypes: normalizeTypes(e.OVERSEERR_ISSUE_TYPES), resolve: e.OVERSEERR_RESOLVE !== 'false' });
    for (const n of envNumbers(e, 'OVERSEERR')) {
      const p = `OVERSEERR_${n}`;
      if (e[`${p}_URL`]) out.push({ name: e[`${p}_NAME`] || `seerr-${n}`, kind: 'seerr', url: trim(e[`${p}_URL`]), key: e[`${p}_KEY`] ?? '', issueTypes: normalizeTypes(e[`${p}_ISSUE_TYPES`]), resolve: e[`${p}_RESOLVE`] !== 'false' });
    }
    return out;
  },
  envLines: (s, n) => [[`OVERSEERR_${n}_NAME`, s.name], [`OVERSEERR_${n}_URL`, s.url], [`OVERSEERR_${n}_KEY`, s.key], [`OVERSEERR_${n}_ISSUE_TYPES`, s.issueTypes ?? DEFAULT_TYPES], [`OVERSEERR_${n}_RESOLVE`, s.resolve !== false]],
  // settings saved by older versions (a single Overseerr, as overseerrUrl, overseerrKey, ...)
  legacy: {
    keys: ['overseerrUrl', 'overseerrKey', 'overseerrTypes', 'overseerrResolve'],
    entries: (f) => (f.overseerrUrl ? [{ name: 'overseerr', kind: 'seerr', url: trim(f.overseerrUrl), key: f.overseerrKey ?? '', issueTypes: normalizeTypes(f.overseerrTypes), resolve: f.overseerrResolve !== false }] : []),
  },
  normalize: (s, old) => ({ name: s.name, kind: 'seerr', url: trim(s.url), key: s.key || old?.key || '', issueTypes: normalizeTypes(s.issueTypes), resolve: s.resolve !== false }),
  isConfigured: (s) => !!(s.key && s.url),

  checkArgs: (req, stored) => ({ url: trim(req.url), key: req.key || stored?.key }),
  async check({ url, key }) {
    const missing = need({ url, key }, 'url', 'key');
    if (missing.length) return fail(`Set ${missing.join(' and ')} first`);
    const s = await get(`${url}/api/v1/status`);
    if (!s.ok) return fail(`Overseerr/Seerr: HTTP ${s.status} (is the URL right, including any path?)`);
    const version = (await s.json().catch(() => ({}))).version;
    const i = await get(`${url}/api/v1/issue?take=1&filter=open`, { headers: { 'X-Api-Key': key } });
    if (!i.ok) return fail(`Overseerr/Seerr ${version ?? ''} is reachable, but the API key ${i.status === 401 || i.status === 403 ? 'was refused or cannot view issues' : `failed (HTTP ${i.status})`}`);
    return pass(`Overseerr/Seerr ${version ?? ''}: API key accepted, issues readable`);
  },

  // shortcut: only the 100 newest open issues are read, upgrade to paging if you ever have more open at once.
  // The first instance (a source named "overseerr") keeps the original id format, so existing state and logs stay valid.
  async fetch(src) {
    return (await api(src, 'GET', '/issue?take=100&filter=open&sort=added')).results
      .map((issue) => ({ id: src.name === 'overseerr' ? `overseerr:${issue.id}` : `overseerr:${src.name}:${issue.id}`, date: issue.createdAt, kind: 'seerr', source: src.name, src, issue }));
  },
  reportLabel: (r) => `${r.src?.name === 'overseerr' ? 'Overseerr' : r.src?.name} issue #${r.issue.id} · ${ISSUE_TYPE[r.issue.issueType] ?? 'other'}`,

  // An issue names a title (TMDB/TVDB id), not a file, so every instance holding it is replaced.
  async replace(ctx, report) {
    const { c, record } = ctx, { issue, src } = report;
    const type = ISSUE_TYPE[issue.issueType] ?? 'other';
    const what = `${src.name === 'overseerr' ? 'Overseerr' : src.name} issue #${issue.id}`;
    const base = { reportId: report.id, source: seerr.reportLabel(report) };
    if (!(src.issueTypes ?? DEFAULT_TYPES).split(',').map((t) => t.trim().toLowerCase()).includes(type)) {
      return record({ status: 'skipped', ...base, detail: `${what}: ${type} issues are not set to be replaced` });
    }
    if (issue.media.mediaType === 'tv' && !issue.problemSeason) {
      return record({ status: 'skipped', ...base, detail: `${what}: reported against the whole series, which is not replaced automatically` });
    }
    const hits = await ctx.locateIssue(issue);
    if (!hits.length) return record({ status: 'skipped', ...base, detail: `${what}: no Sonarr/Radarr instance has a file for this title` });
    let capped = false;
    for (const hit of hits) if ((await ctx.swap(report, hit.title, hit)) === false) capped = true;
    if (c.dryRun || src.resolve === false || capped) return; // capped: leave the issue open, not every file was replaced
    try {
      await api(src, 'POST', `/issue/${issue.id}/comment`, { message: `Reportarr replaced ${hits.length} file(s) and started re-downloading ${hits.length === 1 ? 'it' : 'them'}.` });
      await api(src, 'POST', `/issue/${issue.id}/resolved`);
      record({ status: 'info', ...base, detail: `${what}: commented and resolved` });
    } catch (e) { record({ status: 'error', ...base, detail: `${what}: could not comment/resolve: ${e.message}` }); }
  },
};
export default seerr;
