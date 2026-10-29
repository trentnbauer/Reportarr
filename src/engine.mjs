// The core loop, with no app-specific code: poll every configured source for new reports, find the file each one is
// about in the *arr apps, replace it, and move the new grab to the top of the download queue. What each source, *arr
// app and download client does for itself lives in src/integrations/.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.mjs';
import { runCheck } from './checks.mjs';
import { SOURCES, ARRS, CLIENT_BY_IMPLEMENTATION } from './integrations/index.mjs';
import { request } from './integrations/arr.mjs';
import { sleep, log } from './util.mjs';

const dataFile = (n) => path.join(DATA_DIR, n);
export const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
export const stateFile = () => dataFile('state.json');
export const changesFile = () => dataFile('changes.json');

export const status = { lastPoll: null, lastError: null, historic: 0 };
// Last known state of each configured thing, keyed source:NAME, arr:NAME or client:NAME. Sources are updated by every poll,
// *arr instances every few minutes, download clients only when you press Test (logging in over and over can get you banned).
export const health = {};
const ARR_CHECK_MS = 5 * 60_000;
let lastArrCheck = 0;

// What the UI shows: one row per action the app took (or would take, in dry-run).
export function record(entry) {
  const rows = readJson(changesFile(), []);
  rows.push({ time: new Date().toISOString(), ...entry });
  writeJson(changesFile(), rows.slice(-500));
  log(entry.status, entry.title ?? '', entry.instance ?? '', entry.detail ?? '');
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
const labelOf = (r) => sourceOf(r).label(r);

// Delete the file(s), blocklist the release they came from, search again and push the new grab to the top of the queue.
async function swap(c, report, title, hit) {
  const { a } = hit, ids = hit.fileIds ?? [hit.fileId], plan = ARRS[a.kind].plan(hit);
  const base = { reportId: report.id, source: labelOf(report), title, instance: a.name };
  const files = ids.length === 1 ? `file ${ids[0]}` : `${ids.length} files`;
  if (c.dryRun) return record({ status: 'dry-run', ...base, detail: `would delete ${files}, blocklist, search` });
  const hist = await arr(a, 'GET', plan.hist);
  const grabbed = (hist.records ?? hist)[0];
  for (const id of ids) await arr(a, 'DELETE', plan.del(id));
  if (grabbed) await arr(a, 'POST', `/history/failed/${grabbed.id}`).catch((e) => record({ status: 'error', ...base, detail: 'blocklist failed: ' + e.message }));
  await arr(a, 'POST', '/command', plan.cmd);
  record({ status: 'replaced', ...base, detail: `deleted ${files}, blocklisted: ${!!grabbed}, search started` });
  prioritize(c, a, plan.ours, title).catch((e) => record({ status: 'error', ...base, detail: 'priority failed: ' + e.message }));
}

// What a source's replace() is handed: the settings, the log, and the ways to find and replace files.
const context = (c) => ({
  c, record,
  locateFromPlex: (m, files, plexGet) => locateFromPlex(c, m, files, plexGet),
  locateIssue: (issue) => locateIssue(c, issue),
  swap: (report, title, hit) => swap(c, report, title, hit),
});

// Handle one report with the source it came from.
export const handleReport = (c, report) => sourceOf(report).replace(context(c), report);

// ---- the loop
// Reports that existed before the app first ran: seen, but never acted on (no entry in the changes log).
export const pendingHistoric = (nodes, seen, changes) => {
  const handled = new Set(changes.map((r) => r.reportId).filter(Boolean));
  return nodes.filter((n) => seen.includes(n.id) && !handled.has(n.id));
};

let historicRequested = false;
let wake;
export const requestHistoric = () => { historicRequested = true; wake?.(); };

// Runs one report through the daily cap and then handles it. Returns false when the cap is hit.
async function act(c, s, r, { retryable = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (s.day !== today) Object.assign(s, { day: today, count: 0 });
  if (s.count >= c.maxPerDay) {
    // a new report is marked handled so it is not retried forever; a historic one stays pending for the next click
    if (!retryable) record({ status: 'skipped', reportId: r.id, source: labelOf(r), detail: `daily cap ${c.maxPerDay} reached` });
    return false;
  }
  s.count++;
  writeJson(stateFile(), s);
  await handleReport(c, r).catch((e) => record({ status: 'error', reportId: r.id, source: labelOf(r), detail: e.message }));
  return true;
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
  const s = readJson(stateFile(), null) ?? { seen: [], day: '', count: 0, sources: [] };
  s.sources ??= ['plex']; // state files from before Overseerr support only ever saw Plex
  // a source seen for the first time (first run, or newly configured) is baselined: what it already holds is never acted on automatically
  for (const src of ok.values()) {
    if (s.sources.includes(src)) continue;
    const ids = nodes.filter((n) => n.source === src).map((n) => n.id);
    s.seen.push(...ids); s.sources.push(src);
    record({ status: 'info', detail: `baselined ${ids.length} existing ${src} report(s); only new ones will be acted on (use the button in the UI to action them)` });
  }
  writeJson(stateFile(), s);
  for (const r of nodes.filter((n) => !s.seen.includes(n.id))) {
    s.seen.push(r.id); // mark first: a crash must not retry a delete
    await act(c, s, r);
    writeJson(stateFile(), s);
  }
  if (historicRequested) {
    historicRequested = false;
    const todo = pendingHistoric(nodes, s.seen, readJson(changesFile(), []));
    record({ status: 'info', detail: `actioning ${todo.length} historic report(s)${c.dryRun ? ' (dry run)' : ''}` });
    for (const r of todo) {
      if (!(await act(c, s, r, { retryable: true }))) { record({ status: 'info', detail: 'daily cap reached; the remaining historic reports stay pending' }); break; }
    }
  }
  status.historic = pendingHistoric(nodes, s.seen, readJson(changesFile(), [])).length;
  return errors.join('; ');
}

// Poll forever; the UI's "action existing reports" button wakes it early.
export async function run() {
  for (;;) {
    await poll().then((partial) => { status.lastError = partial || null; if (partial) log('poll error', partial); }, (e) => { status.lastError = e.message; log('poll error', e.message); });
    status.lastPoll = new Date().toISOString();
    await new Promise((r) => { wake = r; setTimeout(r, getConfig().pollSeconds * 1000); });
  }
}
