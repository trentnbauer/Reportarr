// The core loop, with no app-specific code: poll every configured source for new reports, find the file each one is
// about in the *arr apps, replace it, and move the new grab to the top of the download queue. What each source, *arr
// app and download client does for itself lives in src/integrations/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from './config.mjs';
import { runCheck } from './checks.mjs';
import { SOURCES, ARRS, CLIENT_BY_IMPLEMENTATION } from './integrations/index.mjs';
import { request, fileName } from './integrations/arr.mjs';
import { sleep, log, writeFileAtomic } from './util.mjs';
import { notifyRow } from './notify.mjs';

const dataFile = (n) => path.join(DATA_DIR, n);
export const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomic(f, JSON.stringify(v)); };
export const stateFile = () => dataFile('state.json');
export const changesFile = () => dataFile('changes.json');

export const status = { lastPoll: null, lastError: null, historic: 0, replacing: 0, downloads: [] };
// Last known state of each configured thing, keyed source:NAME, arr:NAME or client:NAME. Sources are updated by every poll,
// *arr instances every few minutes, download clients only when you press Test (logging in over and over can get you banned).
export const health = {};
const ARR_CHECK_MS = 5 * 60_000;
let lastArrCheck = 0;

// What the UI shows: one row per action the app took (or would take, in dry-run).
export function record(entry) {
  const rows = readJson(changesFile(), []);
  rows.push({ id: crypto.randomUUID(), time: new Date().toISOString(), ...entry });
  writeJson(changesFile(), rows.slice(-2000));
  log(entry.status, entry.title ?? '', entry.instance ?? '', entry.detail ?? '');
  notifyRow(entry);
}

// How many replacements today out of the daily limit.
export const todayCount = (c) => {
  const s = readJson(stateFile(), {}), today = new Date().toISOString().slice(0, 10);
  return { count: s.day === today ? s.count ?? 0 : 0, max: c.maxPerDay };
};

// Health entries for what is configured now (a removed source or instance must not linger).
export const currentHealth = (c) => Object.fromEntries([
  ...c.sources.map((x) => [`source:${x.name}`, health[`source:${x.name}`]]),
  ...c.arrs.map((x) => [`arr:${x.name}`, health[`arr:${x.name}`]]),
  ...c.clients.map((x) => [`client:${x.name}`, health[`client:${x.name}`]]),
  ...c.notifications.map((x) => [`notification:${x.name}`, health[`notification:${x.name}`]]),
].filter(([, v]) => v));

// a call to a Sonarr/Radarr/Lidarr instance, on the API version its kind uses
const arr = (a, method, p, body) => request(ARRS[a.kind]?.api ?? 'v3', a, method, p, body);

// ---- finding the file: ask each *arr instance in turn
const locateFromPlex = async (c, m, files, plexGet) => {
  for (const a of c.arrs) { const hit = await ARRS[a.kind].fromPlex?.({ a, m, files, plexGet }); if (hit) return hit; }
};
const locateIssue = async (c, issue) => {
  const hits = [];
  for (const a of c.arrs) hits.push(...((await ARRS[a.kind].fromIssue?.({ a, issue })) ?? []));
  return hits;
};

// ---- picking the download client
const real = (v) => (v && !/^\*+$/.test(v) ? v : ''); // Sonarr/Radarr mask stored secrets as ********
const sameHost = (url, f) => { try { const u = new URL(url); return u.hostname === f.host && +(u.port || (u.protocol === 'https:' ? 443 : 80)) === +f.port; } catch { return false; } };

// Pick the configured download client for one of the arr's clients: an entry in `clients` that has the
// same host:port (or name), else the one marked default for that kind (the old single QBIT_*/SAB_* settings), else the arr's own host.
export function clientFor(c, implementation, f, armName) {
  const kind = CLIENT_BY_IMPLEMENTATION[implementation]?.kind;
  if (!kind) return;
  const own = `http${f.useSsl ? 's' : ''}://${f.host}:${f.port}${f.urlBase ? '/' + f.urlBase.replace(/^\//, '') : ''}`;
  const listed = c.clients.find((x) => x.kind === kind && ((x.url && sameHost(x.url, f)) || x.name === armName)) ?? c.clients.find((x) => x.kind === kind && x.default);
  const x = listed ?? {};
  return { kind, name: listed?.name ?? 'none', url: (x.url || own).replace(/\/$/, ''), username: x.username || f.username, password: x.password || real(f.password), apiKey: x.apiKey || real(f.apiKey) };
}

// Arr apps have no per-item queue priority, so push the new grab to the top in its download client.
export async function prioritize(c, a, isOurs, title, waitMs = 10_000) {
  for (let i = 0; i < 12; i++) { // the search grabs asynchronously; wait up to ~2 min
    await sleep(waitMs);
    const q = (await arr(a, 'GET', '/queue?pageSize=200')).records.find(isOurs);
    if (!q) continue;
    const cl = (await arr(a, 'GET', '/downloadclient')).find((x) => x.name === q.downloadClient);
    if (!cl) return record({ status: 'info', title, instance: a.name, detail: `download client "${q.downloadClient}" not found in ${a.name}; priority not set` });
    const mod = CLIENT_BY_IMPLEMENTATION[cl.implementation];
    if (!mod) return record({ status: 'info', title, instance: a.name, detail: `queue priority not supported for ${cl.implementation}` });
    const f = Object.fromEntries(cl.fields.map((x) => [x.name, x.value]));
    const dc = clientFor(c, cl.implementation, f, q.downloadClient);
    await mod.prioritize(dc, q);
    return record({ status: 'prioritized', title, instance: a.name, detail: `moved "${q.title}" to top of ${q.downloadClient} (${dc.url})` });
  }
  record({ status: 'info', title, instance: a.name, detail: 'replacement not in queue after 2 min; priority not set' });
}

// ---- replacing it
const sourceOf = (r) => SOURCES[r.kind ?? 'plex'];
const labelOf = (r) => sourceOf(r).reportLabel(r);

// A queue item belongs to a replacement when it has the same episode, movie or album id (plan.match).
const matches = (m) => (r) => Object.entries(m).every(([k, v]) => r[k] === v);
// Push a replacement to the top of its download client in the background; a failure can be retried from the UI.
const prioritizeLater = (c, a, match, title, base) => prioritize(c, a, matches(match), title)
  .catch((e) => record({ status: 'error', ...base, title, instance: a.name, detail: 'priority failed: ' + e.message, retry: 'priority', match }));

// The daily cap: s.count is how many items (an episode, a movie, an album) were really replaced today.
const capFull = (c, s) => {
  const today = new Date().toISOString().slice(0, 10);
  if (s.day !== today) Object.assign(s, { day: today, count: 0 });
  return s.count >= c.maxPerDay;
};

// Delete the file(s), blocklist the release they came from, search again and push the new grab to the top of the queue.
// Returns false when the daily cap stopped it, else (outside dry-run) what to follow while the replacement arrives.
async function swap(c, s, report, title, hit) {
  const { a } = hit, ids = hit.fileIds ?? [hit.fileId], plan = ARRS[a.kind].plan(hit);
  const base = { reportId: report.id, source: labelOf(report), title, instance: a.name, file: hit.file };
  const files = ids.length === 1 ? `file ${ids[0]}` : `${ids.length} files`;
  if (c.dryRun) return record({ status: 'dry-run', ...base, detail: `would delete ${files}, blocklist, search` });
  if (capFull(c, s)) { record({ status: 'skipped', ...base, detail: `daily cap ${c.maxPerDay} reached: not replaced` }); return false; }
  s.count++;
  writeJson(stateFile(), s); // counted before deleting: a crash must not let the cap be exceeded
  const hist = await arr(a, 'GET', plan.hist);
  const grabbed = (hist.records ?? hist)[0];
  for (const id of ids) await arr(a, 'DELETE', plan.del(id));
  if (grabbed) await arr(a, 'POST', `/history/failed/${grabbed.id}`).catch((e) => record({ status: 'error', ...base, detail: 'blocklist failed: ' + e.message }));
  await arr(a, 'POST', '/command', plan.cmd);
  record({ status: 'replaced', ...base, detail: `deleted ${files}, blocklisted: ${!!grabbed}, search started` });
  prioritizeLater(c, a, plan.match, title, base);
  return plan.check && { arr: a.name, check: plan.check, match: plan.match, title, file: hit.file, plex: hit.plex }; // what checkPending follows
}

// What a source's replace() is handed: the settings, the log, and the ways to find and replace files.
const context = (c, s) => ({
  c, record,
  locateFromPlex: (m, files, plexGet) => locateFromPlex(c, m, files, plexGet),
  locateIssue: (issue) => locateIssue(c, issue),
  swap: (report, title, hit) => swap(c, s, report, title, hit),
  // How many more replacements today's daily limit allows (unlimited when none is set).
  allowance: () => { if (!Number.isFinite(c.maxPerDay)) return Infinity; capFull(c, s); return Math.max(0, c.maxPerDay - (s.count ?? 0)); },
  // Not now: forget that the report was seen, so a later poll handles it again once there is room (the row is logged once a day).
  defer: (report, detail) => {
    s.seen = s.seen.filter((id) => id !== report.id);
    const day = new Date().toISOString().slice(0, 10);
    if ((s.deferred ??= {})[report.id] !== day) { s.deferred[report.id] = day; record({ status: 'info', reportId: report.id, source: labelOf(report), detail }); }
    writeJson(stateFile(), s);
  },
  // Ask for this report to be finished (source.finish) once every item has its new file back; see checkPending.
  watch: (report, items) => {
    (s.pending ??= []).push({ reportId: report.id, kind: report.kind, source: report.source, ref: report.issue?.id, items, since: new Date().toISOString() });
    writeJson(stateFile(), s);
  },
});

// Handle one report with the source it came from.
export const handleReport = (c, report, s = readJson(stateFile(), null) ?? { seen: [], day: '', count: 0, sources: [] }) => sourceOf(report).replace(context(c, s), report);

// ---- waiting for the new file
// shortcut: fixed waits, make them settings if a slow indexer or a slow Plex scan ever needs longer.
const PENDING_MAX_MS = 72 * 3600_000; // then the issue is left open for a person
const PLEX_WAIT_MS = 60 * 60_000; // then it is resolved anyway: the file is imported, Plex may just not list it by this title

// Every replaced item goes replaced -> downloading -> downloaded -> imported -> available (in Plex), one row per step.
// A step can be missed between two polls; it is skipped, except "downloaded" is logged when the import is first seen.
const STAGES = ['replaced', 'downloading', 'downloaded', 'imported', 'available'];
const reached = (it, st) => STAGES.indexOf(it.stage ?? 'replaced') >= STAGES.indexOf(st);
const downloadDone = (q) => q.status === 'completed' || /^import/i.test(q.trackedDownloadState ?? '') || (q.size > 0 && q.sizeleft === 0);

// How far a queue item has got, as the UI shows it. The arr gives timeleft as [d.]hh:mm:ss and, when it knows, an estimated finish.
const parseLeft = (s) => { const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(s ?? ''); return m ? (((+(m[1] ?? 0)) * 24 + +m[2]) * 3600 + +m[3] * 60 + +m[4]) * 1000 : undefined; };
const progressOf = (q) => {
  const left = parseLeft(q.timeleft);
  return { pct: q.size > 0 ? Math.round((100 * (q.size - q.sizeleft)) / q.size) : 0, state: q.status, release: q.title, client: q.downloadClient,
    eta: q.estimatedCompletionTime ?? (left === undefined ? undefined : new Date(Date.now() + left).toISOString()) };
};

// Moves the items on as far as they have got; true when every one is available.
async function advance(c, p, base, queues) {
  const plex = c.sources.find((x) => x.kind === 'plex' && SOURCES.plex.isConfigured(x));
  let all = true;
  for (const it of p.items) {
    const a = c.arrs.find((x) => x.name === it.arr);
    const row = (status, detail) => record({ status, ...base, title: it.title, instance: a.name, file: it.newFile ?? it.file, detail });
    if (!reached(it, 'imported')) {
      const x = await arr(a, 'GET', it.check);
      if (x?.hasFile) {
        delete it.progress; // it arrived
        if (!reached(it, 'downloaded')) row('downloaded', 'download finished (seen when it was imported)');
        it.newFile = fileName(x.movieFile?.path ?? x.episodeFile?.path);
        it.importedAt = Date.now();
        it.stage = 'imported';
        row('imported', `${a.kind === 'radarr' ? 'Radarr' : 'Sonarr'} imported the new file`);
      } else {
        const q = (queues[a.name] ??= (await arr(a, 'GET', '/queue?pageSize=200')).records).find((r) => Object.entries(it.match).every(([k, v]) => r[k] === v));
        if (q) it.progress = progressOf(q);
        if (q && !reached(it, 'downloading')) { it.stage = 'downloading'; row('downloading', `${q.title}${q.downloadClient ? ` via ${q.downloadClient}` : ''}`); }
        if (q && !reached(it, 'downloaded') && downloadDone(q)) { it.stage = 'downloaded'; row('downloaded', 'download finished, waiting for import'); }
      }
    }
    if (it.stage === 'imported') {
      if (!plex || !it.plex) it.stage = 'available';
      else if (await SOURCES.plex.available(plex, it.plex, it.newFile).catch(() => false)) { it.stage = 'available'; row('available', 'available in Plex'); }
      else if (Date.now() - it.importedAt > PLEX_WAIT_MS) { it.stage = 'available'; row('info', `not listed in Plex after ${PLEX_WAIT_MS / 60_000} min: resolving anyway`); }
    }
    if (it.stage !== 'available') all = false;
  }
  return all;
}

// Replacements wait here until every item is available, then the source finishes the report (Seerr resolves the issue).
// Slow or failed downloads leave the issue open; after PENDING_MAX_MS it is left for a person.
export async function checkPending(c, s) {
  const keep = [], queues = {};
  for (const p of s.pending ?? []) {
    const src = c.sources.find((x) => x.name === p.source), base = { reportId: p.reportId, source: p.source };
    if (!src) { record({ status: 'error', ...base, detail: `${p.source} is no longer configured: not waiting for its replacement` }); continue; }
    if (Date.now() - Date.parse(p.since) > PENDING_MAX_MS) { record({ status: 'skipped', ...base, detail: `no replacement imported within ${PENDING_MAX_MS / 3600_000}h: left open` }); continue; }
    if (p.items.some((i) => !c.arrs.some((a) => a.name === i.arr))) { record({ status: 'error', ...base, detail: 'an *arr instance is no longer configured: not waiting for its replacement' }); continue; }
    try {
      if (!(await advance(c, p, base, queues))) { keep.push(p); continue; }
      await SOURCES[p.kind].finish(context(c, s), src, p);
    } catch (e) {
      if (!p.failed) record({ status: 'error', ...base, detail: `checking the replacement failed (will retry): ${e.message}` });
      keep.push({ ...p, failed: true });
    }
  }
  s.pending = keep;
}

// ---- failures that no longer need attention
// A failed row is not left behind for ever. It is dismissed (kept in the log, no longer counted as a failure) when
//   fixed: the same report later got through (the file was replaced; for a queue priority, the item was moved or arrived),
//   retried: you pressed Retry (the retry writes its own rows, and a new failure if it fails again),
//   expired: it is older than FAILED_MAX_AGE_MS,
//   manual: you dismissed it.
// shortcut: a fixed 7 days, make it a setting if failures should be kept longer.
const FAILED_MAX_AGE_MS = 7 * 86400_000;
const priorityFailure = (r) => /^priority failed/.test(r.detail ?? '');
export function clearFailures(rows, now = Date.now()) {
  let changed = false;
  rows.forEach((r, i) => {
    if (r.status !== 'error' || r.dismissed) return;
    const later = rows.slice(i + 1);
    const fixed = priorityFailure(r)
      ? later.some((x) => (x.status === 'prioritized' && x.title === r.title && x.instance === r.instance)
        || (x.reportId === r.reportId && x.title === r.title && ['downloaded', 'imported', 'available'].includes(x.status)))
      : !!r.reportId && later.some((x) => x.reportId === r.reportId && ['replaced', 'imported', 'available', 'resolved'].includes(x.status));
    const reason = r.retried ? 'retried' : fixed ? 'fixed' : now - Date.parse(r.time) > FAILED_MAX_AGE_MS ? 'expired' : '';
    if (reason) { r.dismissed = reason; changed = true; }
  });
  return changed;
}
// The Dismiss buttons: one failed row by its id, or every one that is still counted ("all").
export function dismissFailures(id) {
  const rows = readJson(changesFile(), []);
  let n = 0;
  for (const r of rows) if (r.status === 'error' && !r.dismissed && (id === 'all' || r.id === id)) { r.dismissed = 'manual'; n++; }
  if (n) writeJson(changesFile(), rows);
  return n;
}

// ---- the loop
// Reports that existed before the app first ran (s.baseline) and are still open: never acted on automatically.
export const pendingHistoric = (nodes, baseline) => nodes.filter((n) => baseline.includes(n.id));
// State files from before s.baseline: seen but with no row in the changes log. Only used once, to fill s.baseline.
export const legacyBaseline = (nodes, seen, changes) => {
  const handled = new Set(changes.map((r) => r.reportId).filter(Boolean));
  return nodes.filter((n) => seen.includes(n.id) && !handled.has(n.id)).map((n) => n.id);
};

let historicRequested = false;
const retries = [];
let wake;
export const requestHistoric = () => { historicRequested = true; wake?.(); };
export const requestRetry = (id) => { retries.push(id); wake?.(); };

// First row of a report's life; the UI's "By report" view groups rows by reportId.
const received = (r) => !readJson(changesFile(), []).some((x) => x.reportId === r.id && x.status === 'reported') && record({ status: 'reported', reportId: r.id, source: labelOf(r), detail: 'report received' });

// Handles one report unless the daily cap is already full. Returns false when it is.
async function act(c, s, r) {
  if (capFull(c, s)) return false;
  await handleReport(c, r, s).catch((e) => record({ status: 'error', reportId: r.id, source: labelOf(r), detail: e.message, retry: 'report' }));
  return true;
}

// The Retry button on a failed row: a failed priority step retries only that (the file was already replaced, so
// redoing the report could delete the new download); any other failure runs the report again, through the daily cap.
// Older versions saved a failed priority row without a retry field; its message gives it away.
const retryKind = (r) => r.retry ?? (r.status === 'error' && r.instance && /^priority failed/.test(r.detail ?? '') ? 'priority' : r.status === 'skipped' && /reported against the whole series(?!; closed)/.test(r.detail ?? '') ? 'report' : undefined);

async function retry(c, s, nodes, id) {
  const rows = readJson(changesFile(), []), row = rows.find((x) => x.id === id), kind = row && retryKind(row);
  if (!kind || row.retried) return;
  row.retried = true;
  writeJson(changesFile(), rows);
  const base = { reportId: row.reportId, source: row.source, title: row.title };
  if (kind === 'priority') {
    const a = c.arrs.find((x) => x.name === row.instance);
    if (!a) return record({ status: 'error', ...base, detail: `retry: instance ${row.instance} is no longer configured` });
    let match = row.match;
    if (!match) { // saved before retries kept the match: find the download in the queue again by its title
      const app = ARRS[a.kind], found = app.queueItem && (await arr(a, 'GET', `/queue?pageSize=200${app.queueQuery}`)).records.map((x) => app.queueItem(x)).find((x) => x?.title === row.title);
      if (!found) return record({ status: 'skipped', ...base, instance: a.name, detail: 'retry: that download is no longer in the queue' });
      match = found.match;
    }
    record({ status: 'info', ...base, instance: a.name, detail: 'retrying queue priority' });
    prioritizeLater(c, a, match, row.title, base); // in the background, like the first attempt: it waits for the queue
    return;
  }
  const r = nodes.find((n) => n.id === row.reportId);
  if (!r) return record({ status: 'skipped', ...base, detail: 'retry: the report is no longer open' });
  record({ status: 'info', ...base, detail: 'retrying the report' });
  if (!(await act(c, s, r))) record({ status: 'skipped', ...base, detail: `retry: daily cap ${c.maxPerDay} reached`, retry: 'report' });
}

// Fetch every configured source; one being down must not stop the others.
async function fetchSources(c) {
  const nodes = [], ok = new Set(), errors = [], seen = new Set();
  for (const k of Object.keys(health)) if (k.startsWith('source:')) delete health[k];
  for (const src of c.sources) {
    const hk = `source:${src.name}`, at = new Date().toISOString(), m = SOURCES[src.kind];
    if (!m.isConfigured(src)) { health[hk] = { ok: null, message: 'not configured', at }; continue; }
    try {
      const list = await m.fetch(src);
      for (const n of list) if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); }
      ok.add(src.name); health[hk] = { ok: true, message: `${list.length} open`, at };
    } catch (e) { errors.push(`${src.name}: ${e.message}`); health[hk] = { ok: false, message: e.message, at }; }
  }
  return { nodes: nodes.sort((x, y) => x.date.localeCompare(y.date)), ok, errors };
}

// *arr instances are not needed until a report arrives, so check them every few minutes to keep the status page honest.
async function checkArrs(c) {
  if (Date.now() - lastArrCheck < ARR_CHECK_MS) return;
  lastArrCheck = Date.now();
  const results = await Promise.all(c.arrs.map((a) => runCheck(c, { target: 'arr', name: a.name, kind: a.kind, url: a.url, key: '' })));
  for (const k of Object.keys(health)) if (k.startsWith('arr:')) delete health[k];
  c.arrs.forEach((a, i) => { health[`arr:${a.name}`] = { ok: results[i].ok, message: results[i].message, at: new Date().toISOString() }; });
}

export async function poll() {
  const c = getConfig();
  if (!c.sources.some((s) => SOURCES[s.kind].isConfigured(s)) || !c.arrs.length) {
    throw new Error('not configured: add a Plex or Overseerr/Seerr source (with its token or key) and at least one Sonarr, Radarr or Lidarr instance');
  }
  const { nodes, ok, errors } = await fetchSources(c);
  await checkArrs(c);
  if (!ok.size) throw new Error(errors.join('; '));
  const s = readJson(stateFile(), null) ?? { seen: [], day: '', count: 0, sources: [], baseline: [] };
  s.sources ??= ['plex']; // state files from before Overseerr support only ever saw Plex
  s.baseline ??= legacyBaseline(nodes, s.seen, readJson(changesFile(), []));
  // a source seen for the first time (first run, or newly configured) is baselined: what it already holds is never acted on automatically
  for (const src of ok.values()) {
    if (s.sources.includes(src)) continue;
    const ids = nodes.filter((n) => n.source === src).map((n) => n.id);
    s.seen.push(...ids); s.baseline.push(...ids); s.sources.push(src);
    record({ status: 'info', detail: `baselined ${ids.length} existing ${src} report(s); only new ones will be acted on (use the button in the UI to action them)` });
  }
  writeJson(stateFile(), s);
  const fresh = nodes.filter((n) => !s.seen.includes(n.id));
  for (const [i, r] of fresh.entries()) {
    // once the cap is full, new reports wait unseen and are handled when it resets, instead of being dropped
    if (capFull(c, s)) {
      if (s.capNoted !== s.day) { s.capNoted = s.day; record({ status: 'info', detail: `daily cap ${c.maxPerDay} reached; ${fresh.length - i} new report(s) wait until tomorrow` }); }
      break;
    }
    s.seen.push(r.id);
    writeJson(stateFile(), s); // mark first: a crash must not retry a delete
    received(r);
    await act(c, s, r);
    writeJson(stateFile(), s);
  }
  if (historicRequested) {
    historicRequested = false;
    const todo = pendingHistoric(nodes, s.baseline);
    record({ status: 'info', detail: `actioning ${todo.length} historic report(s)${c.dryRun ? ' (dry run)' : ''}` });
    for (const r of todo) {
      if (capFull(c, s)) { record({ status: 'info', detail: 'daily cap reached; the remaining historic reports stay pending' }); break; }
      received(r);
      if (!(await act(c, s, r))) { record({ status: 'info', detail: 'daily cap reached; the remaining historic reports stay pending' }); break; }
      if (!c.dryRun) s.baseline = s.baseline.filter((id) => id !== r.id); // a dry run leaves it pending for the real run
      writeJson(stateFile(), s);
    }
  }
  for (const id of retries.splice(0)) await retry(c, s, nodes, id);
  await checkPending(c, s);
  status.replacing = s.pending.length;
  // what the By report view shows for downloads in flight: one entry per item being waited for
  status.downloads = s.pending.flatMap((p) => p.items.map((it) => ({ reportId: p.reportId, title: it.title, instance: it.arr, stage: it.stage ?? 'replaced', ...it.progress, pct: reached(it, 'downloaded') ? 100 : it.progress?.pct ?? 0 })));
  const rows = readJson(changesFile(), []);
  if (clearFailures(rows)) writeJson(changesFile(), rows);
  writeJson(stateFile(), s);
  status.historic = pendingHistoric(nodes, s.baseline).length;
  return errors.join('; ');
}

let lastNotified = null;

// Poll forever; the UI's "action existing reports" button wakes it early.
export async function run() {
  for (;;) {
    await poll().then((partial) => { status.lastError = partial || null; if (partial) log('poll error', partial); }, (e) => { status.lastError = e.message; log('poll error', e.message); });
    if (status.lastError && status.lastError !== lastNotified) notifyRow({ status: 'error', source: 'Reportarr', detail: `Polling hit a problem: ${status.lastError}` }); // once per distinct problem, not every minute
    lastNotified = status.lastError;
    status.lastPoll = new Date().toISOString();
    await new Promise((r) => { wake = r; setTimeout(r, getConfig().pollSeconds * 1000); });
  }
}
