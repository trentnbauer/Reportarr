// Overseerr / Seerr: a report source. Users report an issue on a title; Reportarr replaces its file(s), comments, and
// resolves the issue once the new file(s) are imported. Everything specific to it lives here.
import { trim, get, work, pass, fail, need, envNumbers, signed } from '../util.mjs';

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
  switches: [
    { name: 'resolve', label: 'Resolve issues', hint: 'Comment after replacing, resolve once the new file is imported' },
    { name: 'wholeSeries', label: 'Replace whole series', hint: 'When a report names no season, replace every episode (within the daily limit)' },
  ],
  defaults: { issueTypes: DEFAULT_TYPES, resolve: true, wholeSeries: true },

  // OVERSEERR_URL + OVERSEERR_KEY is one instance; OVERSEERR_2_URL / _KEY / _NAME / _ISSUE_TYPES / _RESOLVE are more
  fromEnv(e) {
    const out = [];
    if (e.OVERSEERR_URL) out.push({ name: e.OVERSEERR_NAME || 'overseerr', kind: 'seerr', url: trim(e.OVERSEERR_URL), key: e.OVERSEERR_KEY || e.OVERSEERR_API_KEY || '', issueTypes: normalizeTypes(e.OVERSEERR_ISSUE_TYPES), resolve: e.OVERSEERR_RESOLVE !== 'false', wholeSeries: e.OVERSEERR_WHOLE_SERIES !== 'false' });
    for (const n of envNumbers(e, 'OVERSEERR')) {
      const p = `OVERSEERR_${n}`;
      if (e[`${p}_URL`]) out.push({ name: e[`${p}_NAME`] || `seerr-${n}`, kind: 'seerr', url: trim(e[`${p}_URL`]), key: e[`${p}_KEY`] ?? '', issueTypes: normalizeTypes(e[`${p}_ISSUE_TYPES`]), resolve: e[`${p}_RESOLVE`] !== 'false', wholeSeries: e[`${p}_WHOLE_SERIES`] !== 'false' });
    }
    return out;
  },
  envLines: (s, n) => [[`OVERSEERR_${n}_NAME`, s.name], [`OVERSEERR_${n}_URL`, s.url], [`OVERSEERR_${n}_KEY`, s.key], [`OVERSEERR_${n}_ISSUE_TYPES`, s.issueTypes ?? DEFAULT_TYPES], [`OVERSEERR_${n}_RESOLVE`, s.resolve !== false], [`OVERSEERR_${n}_WHOLE_SERIES`, s.wholeSeries !== false]],
  // settings saved by older versions (a single Overseerr, as overseerrUrl, overseerrKey, ...)
  legacy: {
    keys: ['overseerrUrl', 'overseerrKey', 'overseerrTypes', 'overseerrResolve'],
    entries: (f) => (f.overseerrUrl ? [{ name: 'overseerr', kind: 'seerr', url: trim(f.overseerrUrl), key: f.overseerrKey ?? '', issueTypes: normalizeTypes(f.overseerrTypes), resolve: f.overseerrResolve !== false }] : []),
  },
  normalize: (s, old) => ({ name: s.name, kind: 'seerr', url: trim(s.url), key: s.key || old?.key || '', issueTypes: normalizeTypes(s.issueTypes), resolve: s.resolve !== false, wholeSeries: s.wholeSeries !== false }),
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
    if (issue.media.mediaType === 'tv' && !issue.problemSeason && src.wholeSeries === false) {
      // Not replacing a whole series: close the issue and ask for the particular episode. Left alone (with a Retry) in a dry run, or when
      // resolving issues is off, since both mean "do not touch Seerr".
      let closed = false;
      if (!c.dryRun && src.resolve !== false) {
        try {
          await api(src, 'POST', `/issue/${issue.id}/comment`, { message: signed("A report against the whole series can't be replaced automatically. Please report the particular episode that has the problem (open it and choose Report an issue there) and it will be replaced.") });
          await api(src, 'POST', `/issue/${issue.id}/resolved`);
          closed = true;
        } catch (e) { record({ status: 'error', ...base, detail: `${what}: could not close it: ${e.message}` }); }
      }
      return record({ status: closed ? 'denied' : 'skipped', ...base, ...(closed ? {} : { retry: 'report' }),
        detail: closed ? `${what}: reported against the whole series; closed it and asked for the particular episode` : `${what}: reported against the whole series ("Replace whole series" is off)` });
    }
    const hits = await ctx.locateIssue(issue);
    if (!hits.length) return record({ status: 'skipped', ...base, detail: `${what}: no Sonarr/Radarr instance has a file for this title` });
    // A report is replaced whole or not at all: half a series, left open for good, is worse than waiting for the daily limit.
    const room = ctx.allowance();
    if (!c.dryRun && hits.length > room) {
      if (hits.length > c.maxPerDay) return record({ status: 'skipped', ...base, retry: 'report', detail: `${what}: ${hits.length} files, more than the daily limit of ${c.maxPerDay}: raise MAX_PER_DAY to replace it` });
      return ctx.defer(report, `${what}: ${hits.length} files need more than the ${room} left today: waiting for the daily count to reset`);
    }
    let capped = false;
    const items = [];
    for (const hit of hits) { const done = await ctx.swap(report, hit.title, hit); if (done === false) capped = true; else if (done) items.push(done); }
    if (c.dryRun || src.resolve === false || capped) return; // capped: leave the issue open, not every file was replaced
    // The issue is resolved later, by finish(), once Sonarr/Radarr have the new file(s): Seerr tells the reporter when it is resolved.
    try {
      await api(src, 'POST', `/issue/${issue.id}/comment`, { message: signed(`Replaced ${hits.length} file(s) and started re-downloading ${hits.length === 1 ? 'it' : 'them'}. This issue will be resolved once the new ${hits.length === 1 ? 'file is' : 'files are'} imported.`) });
    } catch (e) { record({ status: 'error', ...base, detail: `${what}: could not comment: ${e.message}` }); }
    if (items.length) {
      ctx.watch(report, items);
      record({ status: 'replacing', ...base, detail: `${what}: waiting for ${items.length} replacement file(s) before resolving` });
    }
  },

  // Called by the engine when every replacement file is back.
  async finish({ record }, src, p) {
    const what = `${src.name === 'overseerr' ? 'Overseerr' : src.name} issue #${p.ref}`;
    await api(src, 'POST', `/issue/${p.ref}/resolved`);
    record({ status: 'resolved', reportId: p.reportId, source: p.source, detail: `${what}: replacement imported, resolved` });
  },
};
export default seerr;
