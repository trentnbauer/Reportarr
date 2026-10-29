// Polls Plex "Reported Issues" and Overseerr/Seerr issues; for each new report deletes the reported file in
// Sonarr/Radarr, blocklists the release it came from, searches again and moves the
// new grab to the top of the download queue. A small web UI shows changes and settings.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runCheck, PLEX_COMMUNITY_URL } from './checks.mjs';
import { DATA_DIR, getConfig, publicConfig, lockedKeys, saveConfig, envFile, hasFileConfig } from './config.mjs';

export const ratingKeyOf = (url) => url?.match(/\/library\/metadata\/(\d+)$/)?.[1];
export const idsOf = (guids = []) => Object.fromEntries(guids.map((g) => g.id.split('://')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref()); // unref: a pending wait must not keep the process alive
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dataFile = (n) => path.join(DATA_DIR, n);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };

// set at image build time (git tag, or commit hash for untagged builds)
export const VERSION = (process.env.APP_VERSION ?? 'dev').replace(/^([0-9a-f]{7})[0-9a-f]{33}$/, '$1');

const status = { lastPoll: null, lastError: null, historic: 0 };

// What the UI shows: one row per action the app took (or would take, in dry-run).
function record(entry) {
  const rows = readJson(dataFile('changes.json'), []);
  rows.push({ time: new Date().toISOString(), ...entry });
  writeJson(dataFile('changes.json'), rows.slice(-500));
  log(entry.status, entry.title ?? '', entry.instance ?? '', entry.detail ?? '');
}

const plex = async (c, p) => {
  const r = await fetch(c.plexUrl + p, { headers: { 'X-Plex-Token': c.plexToken, Accept: 'application/json' } });
  if (r.status === 404) return {}; // item already deleted or replaced
  if (!r.ok) throw new Error(`plex ${p} ${r.status}`);
  return (await r.json()).MediaContainer;
};
const arr = async (a, method, p, body) => {
  const r = await fetch(`${a.url}/api/v3${p}`, {
    method,
    headers: { 'X-Api-Key': a.key, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${a.name} ${method} ${p} ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};
const reports = async (c) => {
  const r = await fetch(PLEX_COMMUNITY_URL(), {
    method: 'POST',
    headers: { 'X-Plex-Token': c.plexToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ reports(first: 50) { nodes { id date url } } }' }),
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error('reports query failed: ' + JSON.stringify(j.errors ?? r.status));
  return j.data.reports.nodes;
};

const overseerr = async (c, method, p, body) => {
  const r = await fetch(`${c.overseerrUrl.replace(/\/$/, '')}/api/v1${p}`, {
    method,
    headers: { 'X-Api-Key': c.overseerrKey, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`overseerr ${method} ${p} ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};
// shortcut: only the 100 newest open issues are read, upgrade to paging if you ever have more open at once
const overseerrIssues = async (c) => (await overseerr(c, 'GET', '/issue?take=100&filter=open&sort=added')).results
  .map((issue) => ({ id: `overseerr:${issue.id}`, date: issue.createdAt, source: 'overseerr', issue }));

// Find the arr instance + item that owns one of the reported file names.
async function locate(c, m, files) {
  if (m.type === 'episode') {
    const tvdb = idsOf((await plex(c, `/library/metadata/${m.grandparentRatingKey}`)).Metadata[0].Guid).tvdb;
    for (const a of c.arrs.filter((x) => x.kind === 'sonarr')) {
      const [series] = await arr(a, 'GET', `/series?tvdbId=${tvdb}`);
      if (!series) continue;
      const eps = await arr(a, 'GET', `/episode?seriesId=${series.id}&includeEpisodeFile=true`);
      const ep = eps.find((e) => e.seasonNumber === m.parentIndex && e.episodeNumber === m.index && e.hasFile
        && files.has(path.basename(e.episodeFile.path)));
      if (ep) return { a, ep, fileId: ep.episodeFile.id };
    }
  } else if (m.type === 'movie') {
    const tmdb = idsOf(m.Guid).tmdb;
    for (const a of c.arrs.filter((x) => x.kind === 'radarr')) {
      const [movie] = await arr(a, 'GET', `/movie?tmdbId=${tmdb}`);
      if (movie?.hasFile && files.has(path.basename(movie.movieFile.path))) return { a, movie, fileId: movie.movieFile.id };
    }
  }
}

const CLIENT_KIND = { QBittorrent: 'qbittorrent', Sabnzbd: 'sabnzbd' };
const real = (v) => (v && !/^\*+$/.test(v) ? v : ''); // Sonarr/Radarr mask stored secrets as ********
const sameHost = (url, f) => { try { const u = new URL(url); return u.hostname === f.host && +(u.port || (u.protocol === 'https:' ? 443 : 80)) === +f.port; } catch { return false; } };

// Pick the configured download client for one of the arr's clients: an entry in `clients` that has the
// same host:port (or name), else the default qBittorrent/SABnzbd settings, else the arr's own host.
export function clientFor(c, implementation, f, armName) {
  const kind = CLIENT_KIND[implementation];
  if (!kind) return;
  const own = `http${f.useSsl ? 's' : ''}://${f.host}:${f.port}${f.urlBase ? '/' + f.urlBase.replace(/^\//, '') : ''}`;
  const listed = c.clients.find((x) => x.kind === kind && (sameHost(x.url, f) || x.name === armName));
  const dflt = kind === 'qbittorrent' ? { url: c.qbitUrl, username: c.qbitUsername, password: c.qbitPassword } : { url: c.sabUrl, apiKey: c.sabApiKey };
  const x = listed ?? dflt;
  return { kind, name: listed?.name ?? 'default', url: (x.url || own).replace(/\/$/, ''), username: x.username || f.username, password: x.password || real(f.password), apiKey: x.apiKey || real(f.apiKey) };
}

// Arr apps have no per-item queue priority, so push the new grab to the top in its download client.
export async function prioritize(c, a, isOurs, title, waitMs = 10_000) {
  for (let i = 0; i < 12; i++) { // the search grabs asynchronously; wait up to ~2 min
    await sleep(waitMs);
    const q = (await arr(a, 'GET', '/queue?pageSize=200')).records.find(isOurs);
    if (!q) continue;
    const cl = (await arr(a, 'GET', '/downloadclient')).find((x) => x.name === q.downloadClient);
    const f = Object.fromEntries(cl.fields.map((x) => [x.name, x.value]));
    const dc = clientFor(c, cl.implementation, f, q.downloadClient);
    if (!dc) return record({ status: 'info', title, instance: a.name, detail: `queue priority not supported for ${cl.implementation}` });
    if (dc.kind === 'qbittorrent') {
      if (!dc.password) throw new Error(`qBittorrent password for ${q.downloadClient} (${dc.url}) is hidden by the arr: add it to CLIENTS or set QBIT_PASSWORD`);
      const body = new URLSearchParams({ username: dc.username, password: dc.password });
      const cookie = (await fetch(`${dc.url}/api/v2/auth/login`, { method: 'POST', body })).headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw new Error(`qBittorrent login failed at ${dc.url}`);
      const r = await fetch(`${dc.url}/api/v2/torrents/topPrio`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ hashes: q.downloadId.toLowerCase() }) });
      if (!r.ok) throw new Error(`qBittorrent topPrio ${r.status}`); // 409 = torrent queueing disabled
    } else {
      if (!dc.apiKey) throw new Error(`SABnzbd API key for ${q.downloadClient} (${dc.url}) is hidden by the arr: add it to CLIENTS or set SAB_API_KEY`);
      const r = await fetch(`${dc.url}/api?mode=switch&value=${q.downloadId}&value2=0&output=json&apikey=${encodeURIComponent(dc.apiKey)}`);
      if (!r.ok) throw new Error(`sabnzbd switch ${r.status}`);
    }
    return record({ status: 'prioritized', title, instance: a.name, detail: `moved "${q.title}" to top of ${q.downloadClient} (${dc.url})` });
  }
  record({ status: 'info', title, instance: a.name, detail: 'replacement not in queue after 2 min; priority not set' });
}

// Delete one file, blocklist the release it came from, search again and push the new grab to the top of the queue.
async function swap(c, report, title, { a, ep, movie, fileId }) {
  if (c.dryRun) return record({ status: 'dry-run', reportId: report.id, title, instance: a.name, detail: `would delete file ${fileId}, blocklist, search` });
  const hist = await arr(a, 'GET', ep ? `/history?episodeId=${ep.id}&eventType=1&pageSize=1&sortKey=date&sortDirection=descending`
    : `/history/movie?movieId=${movie.id}&eventType=1`);
  const grabbed = (hist.records ?? hist)[0];
  await arr(a, 'DELETE', ep ? `/episodefile/${fileId}` : `/moviefile/${fileId}`);
  if (grabbed) await arr(a, 'POST', `/history/failed/${grabbed.id}`).catch((e) => record({ status: 'error', reportId: report.id, title, instance: a.name, detail: 'blocklist failed: ' + e.message }));
  await arr(a, 'POST', '/command', ep ? { name: 'EpisodeSearch', episodeIds: [ep.id] } : { name: 'MoviesSearch', movieIds: [movie.id] });
  record({ status: 'replaced', reportId: report.id, title, instance: a.name, detail: `deleted file ${fileId}, blocklisted: ${!!grabbed}, search started` });
  prioritize(c, a, (r) => (ep ? r.episodeId === ep.id : r.movieId === movie.id), title)
    .catch((e) => record({ status: 'error', reportId: report.id, title, instance: a.name, detail: 'priority failed: ' + e.message }));
}

async function replace(c, report) {
  const key = ratingKeyOf(report.url);
  const m = key && (await plex(c, `/library/metadata/${key}`)).Metadata?.[0];
  if (!m) return record({ status: 'skipped', reportId: report.id, detail: 'item no longer in Plex (already deleted or replaced): ' + report.url });
  const title = `${m.grandparentTitle ? m.grandparentTitle + ' ' : ''}${m.title}`;
  const files = new Set(m.Media.flatMap((x) => x.Part.map((p) => path.basename(p.file))));
  const hit = await locate(c, m, files);
  if (!hit) return record({ status: 'skipped', reportId: report.id, title, detail: 'no Sonarr/Radarr instance owns ' + [...files] });
  await swap(c, report, title, hit);
}

// Overseerr issues name a title (TMDB/TVDB id), not a file, so every instance holding it is replaced.
const ISSUE_TYPE = { 1: 'video', 2: 'audio', 3: 'subtitles', 4: 'other' };

async function locateIssue(c, issue) {
  const { tmdbId, tvdbId, mediaType } = issue.media;
  const hits = [];
  if (mediaType === 'movie') {
    for (const a of c.arrs.filter((x) => x.kind === 'radarr')) {
      const [movie] = await arr(a, 'GET', `/movie?tmdbId=${tmdbId}`);
      if (movie?.hasFile) hits.push({ a, movie, fileId: movie.movieFile.id, title: movie.title });
    }
  } else {
    for (const a of c.arrs.filter((x) => x.kind === 'sonarr')) {
      const series = tvdbId ? (await arr(a, 'GET', `/series?tvdbId=${tvdbId}`))[0]
        : (await arr(a, 'GET', '/series')).find((x) => x.tmdbId === tmdbId);
      if (!series) continue;
      const eps = await arr(a, 'GET', `/episode?seriesId=${series.id}&includeEpisodeFile=true`);
      for (const ep of eps.filter((e) => e.hasFile && e.seasonNumber === issue.problemSeason && (!issue.problemEpisode || e.episodeNumber === issue.problemEpisode))) {
        hits.push({ a, ep, fileId: ep.episodeFile.id, title: `${series.title} S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}` });
      }
    }
  }
  return hits;
}

export async function replaceIssue(c, report) {
  const { issue } = report;
  const type = ISSUE_TYPE[issue.issueType] ?? 'other';
  const label = `Overseerr issue #${issue.id}`;
  if (!c.overseerrTypes.split(',').map((t) => t.trim().toLowerCase()).includes(type)) {
    return record({ status: 'skipped', reportId: report.id, detail: `${label}: ${type} issues are not set to be replaced` });
  }
  if (issue.media.mediaType === 'tv' && !issue.problemSeason) {
    return record({ status: 'skipped', reportId: report.id, detail: `${label}: reported against the whole series, which is not replaced automatically` });
  }
  const hits = await locateIssue(c, issue);
  if (!hits.length) return record({ status: 'skipped', reportId: report.id, detail: `${label}: no Sonarr/Radarr instance has a file for this title` });
  for (const hit of hits) await swap(c, report, hit.title, hit);
  if (c.dryRun || !c.overseerrResolve) return;
  try {
    await overseerr(c, 'POST', `/issue/${issue.id}/comment`, { message: `Reportarr replaced ${hits.length} file(s) and started re-downloading ${hits.length === 1 ? 'it' : 'them'}.` });
    await overseerr(c, 'POST', `/issue/${issue.id}/resolved`);
    record({ status: 'info', reportId: report.id, detail: `${label}: commented and resolved` });
  } catch (e) { record({ status: 'error', reportId: report.id, detail: `${label}: could not comment/resolve: ${e.message}` }); }
}

// Reports that existed before the app first ran: seen, but never acted on (no entry in the changes log).
export const pendingHistoric = (nodes, seen, changes) => {
  const handled = new Set(changes.map((r) => r.reportId).filter(Boolean));
  return nodes.filter((n) => seen.includes(n.id) && !handled.has(n.id));
};

let historicRequested = false;
let wake;

// Runs one report through the daily cap and then replace(). Returns false when the cap is hit.
async function act(c, s, r, { retryable = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (s.day !== today) Object.assign(s, { day: today, count: 0 });
  if (s.count >= c.maxPerDay) {
    // a new report is marked handled so it is not retried forever; a historic one stays pending for the next click
    if (!retryable) record({ status: 'skipped', reportId: r.id, detail: `daily cap ${c.maxPerDay} reached` });
    return false;
  }
  s.count++;
  writeJson(dataFile('state.json'), s);
  await (r.source === 'overseerr' ? replaceIssue : replace)(c, r).catch((e) => record({ status: 'error', reportId: r.id, detail: e.message }));
  return true;
}

// Fetch every configured source; one being down must not stop the others.
async function fetchSources(c) {
  const nodes = [], ok = new Set(), errors = [];
  const sources = [
    ['plex', c.plexToken && (() => reports(c))],
    ['overseerr', c.overseerrUrl && c.overseerrKey && (() => overseerrIssues(c))],
  ];
  for (const [name, get] of sources) {
    if (!get) continue;
    try { nodes.push(...(await get()).map((n) => ({ source: 'plex', ...n }))); ok.add(name); } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  return { nodes: nodes.sort((x, y) => x.date.localeCompare(y.date)), ok, errors };
}

export async function poll() {
  const c = getConfig();
  if (!(c.plexToken || (c.overseerrUrl && c.overseerrKey)) || !c.arrs.length) {
    throw new Error('not configured: set a Plex token or Overseerr URL and key, and at least one Sonarr/Radarr instance');
  }
  const { nodes, ok, errors } = await fetchSources(c);
  if (!ok.size) throw new Error(errors.join('; '));
  const s = readJson(dataFile('state.json'), null) ?? { seen: [], day: '', count: 0, sources: [] };
  s.sources ??= ['plex']; // state files from before Overseerr support only ever saw Plex
  // a source seen for the first time (first run, or newly configured) is baselined: what it already holds is never acted on automatically
  for (const src of ok.values()) {
    if (s.sources.includes(src)) continue;
    const ids = nodes.filter((n) => n.source === src).map((n) => n.id);
    s.seen.push(...ids); s.sources.push(src);
    record({ status: 'info', detail: `baselined ${ids.length} existing ${src} report(s); only new ones will be acted on (use the button in the UI to action them)` });
  }
  writeJson(dataFile('state.json'), s);
  for (const r of nodes.filter((n) => !s.seen.includes(n.id))) {
    s.seen.push(r.id); // mark first: a crash must not retry a delete
    await act(c, s, r);
    writeJson(dataFile('state.json'), s);
  }
  if (historicRequested) {
    historicRequested = false;
    const todo = pendingHistoric(nodes, s.seen, readJson(dataFile('changes.json'), []));
    record({ status: 'info', detail: `actioning ${todo.length} historic report(s)${c.dryRun ? ' (dry run)' : ''}` });
    for (const r of todo) {
      if (!(await act(c, s, r, { retryable: true }))) { record({ status: 'info', detail: 'daily cap reached; the remaining historic reports stay pending' }); break; }
    }
  }
  status.historic = pendingHistoric(nodes, s.seen, readJson(dataFile('changes.json'), [])).length;
  return errors.join('; ');
}

// BASE_URL is the path the app is served under behind a reverse proxy: "/reportarr", or the full public URL
// "https://media.example.com/reportarr", which also lets that host save settings (Origin check below).
export function parseBase(value = process.env.BASE_URL) {
  if (!value) return { prefix: '', host: '' };
  let host = '', p = value.trim();
  if (/^https?:\/\//i.test(p)) { try { const u = new URL(p); host = u.host; p = u.pathname; } catch { log('BASE_URL ignored: not a valid URL'); return { prefix: '', host: '' }; } }
  p = '/' + p.replace(/^\/+|\/+$/g, '');
  if (p === '/') return { prefix: '', host };
  if (!/^\/[\w.~\-/]+$/.test(p)) { log('BASE_URL ignored: the path may only contain letters, digits and . _ ~ - /'); return { prefix: '', host }; }
  return { prefix: p, host };
}

// Behind a reverse proxy the Host header is often the internal one, so the browser's Origin is also accepted when it
// matches X-Forwarded-Host or the host in BASE_URL.
const sameOrigin = (req, baseHost) => {
  let host; try { host = new URL(req.headers.origin).host; } catch { return false; }
  const fwd = (req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  return [req.headers.host, fwd, baseHost].filter(Boolean).includes(host);
};

const sha = (v) => crypto.createHash('sha256').update(v).digest();
const MAX_BODY = 1_000_000;

export function serve() {
  const { prefix, host: baseHost } = parseBase();
  const html = fs.readFileSync(new URL('./ui.html', import.meta.url), 'utf8').replace('"__BASE_URL__"', JSON.stringify(prefix ? prefix + '/' : ''));
  const pass = process.env.UI_PASSWORD;
  // no UI_PASSWORD means no login at all: the page just loads (a username on its own is not enough to turn auth on)
  if (!pass) log('UI_PASSWORD not set: the web UI is open to anyone who can reach it' + (process.env.UI_USERNAME ? ' (UI_USERNAME is ignored without a password)' : ''));
  const body = (req) => new Promise((res, rej) => {
    let d = '', big = false;
    req.on('data', (x) => { if (big) return; d += x; if (d.length > MAX_BODY) { big = true; d = ''; rej(new Error('request too large')); } });
    req.on('end', () => res(d));
  });
  const user = process.env.UI_USERNAME; // optional: unset accepts any username
  const authed = (req) => {
    if (!pass) return true;
    const [u, ...p] = Buffer.from((req.headers.authorization ?? '').slice(6), 'base64').toString().split(':');
    const passOk = crypto.timingSafeEqual(sha(p.join(':')), sha(pass));
    const userOk = !user || crypto.timingSafeEqual(sha(u), sha(user)); // evaluate both so timing doesn't reveal which was wrong
    return passOk && userOk;
  };
  return http.createServer(async (req, res) => {
    const send = (code, type, data) => { res.writeHead(code, { 'Content-Type': type }); res.end(data); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    if (!authed(req)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Reportarr"');
      return send(401, 'text/plain', 'auth required');
    }
    try {
      const url = new URL(req.url, 'http://x');
      // /reportarr -> /reportarr/ so the page's relative URLs resolve; a proxy that strips the prefix never sends this
      if (prefix && url.pathname === prefix) { res.writeHead(308, { Location: prefix + '/' + url.search }); return res.end(); }
      // Route on the /api/... suffix, so it works under any prefix whether or not the proxy strips it.
      const route = url.pathname.match(/\/api\/(state|env|config|historic|test)$/)?.[0].slice(5) ?? '';
      if (route === 'state') {
        return send(200, 'application/json', JSON.stringify({
          config: publicConfig(), locked: lockedKeys(), status, version: VERSION, uiConfigured: hasFileConfig(), authEnabled: !!pass,
          changes: readJson(dataFile('changes.json'), []).reverse(),
        }));
      }
      if (route === 'env') {
        res.setHeader('Content-Disposition', 'attachment; filename="reportarr.env"');
        res.setHeader('Cache-Control', 'no-store');
        return send(200, 'text/plain; charset=utf-8', envFile());
      }
      if (req.method === 'POST' && (route === 'config' || route === 'historic' || route === 'test')) {
        // A cross-site page can send text/plain without a preflight, so insist on JSON and a same-origin request.
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(415, 'application/json', '{"error":"content-type must be application/json"}');
        if (req.headers.origin && !sameOrigin(req, baseHost)) return send(403, 'application/json', '{"error":"cross-origin request refused"}');
        if (route === 'test') return send(200, 'application/json', JSON.stringify(await runCheck(getConfig(), JSON.parse(await body(req)))));
        if (route === 'historic') { historicRequested = true; wake?.(); return send(202, 'application/json', '{}'); }
        saveConfig(JSON.parse(await body(req)));
        return send(200, 'application/json', '{}');
      }
      send(200, 'text/html', html);
    } catch (err) { send(400, 'application/json', JSON.stringify({ error: err.message })); }
  }).listen(+(process.env.UI_PORT ?? 8080), function () { log('web UI on :' + this.address().port); });
}

async function main() {
  serve();
  for (;;) {
    await poll().then((partial) => { status.lastError = partial || null; if (partial) log('poll error', partial); }, (e) => { status.lastError = e.message; log('poll error', e.message); });
    status.lastPoll = new Date().toISOString();
    await new Promise((r) => { wake = r; setTimeout(r, getConfig().pollSeconds * 1000); }); // the UI button wakes it early
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
