// Polls Plex "Reported Issues"; for each new report deletes the reported file in
// Sonarr/Radarr, blocklists the release it came from, searches again and moves the
// new grab to the top of the download queue. A small web UI shows changes and settings.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getConfig, publicConfig, lockedKeys, saveConfig } from './config.mjs';

export const ratingKeyOf = (url) => url?.match(/\/library\/metadata\/(\d+)$/)?.[1];
export const idsOf = (guids = []) => Object.fromEntries(guids.map((g) => g.id.split('://')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dataFile = (n) => path.join(DATA_DIR, n);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };

const status = { lastPoll: null, lastError: null };

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
  const r = await fetch('https://community.plex.tv/api', {
    method: 'POST',
    headers: { 'X-Plex-Token': c.plexToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ reports(first: 50) { nodes { id date url } } }' }),
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error('reports query failed: ' + JSON.stringify(j.errors ?? r.status));
  return j.data.reports.nodes;
};

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

// Arr apps have no per-item queue priority, so push the new grab to the top in its download client.
async function prioritize(c, a, isOurs, title) {
  for (let i = 0; i < 12; i++) { // the search grabs asynchronously; wait up to ~2 min
    await sleep(10_000);
    const q = (await arr(a, 'GET', '/queue?pageSize=200')).records.find(isOurs);
    if (!q) continue;
    const cl = (await arr(a, 'GET', '/downloadclient')).find((x) => x.name === q.downloadClient);
    const f = Object.fromEntries(cl.fields.map((x) => [x.name, x.value]));
    const own = `http${f.useSsl ? 's' : ''}://${f.host}:${f.port}${f.urlBase ? '/' + f.urlBase.replace(/^\//, '') : ''}`;
    const real = (v) => (v && !/^\*+$/.test(v) ? v : ''); // Sonarr/Radarr mask stored secrets as ********
    if (cl.implementation === 'QBittorrent') {
      const base = c.qbitUrl || own;
      const password = c.qbitPassword || real(f.password);
      if (!password) throw new Error('qBittorrent password is hidden by the arr: set QBIT_PASSWORD (or in the UI)');
      const body = new URLSearchParams({ username: c.qbitUsername || f.username, password });
      const cookie = (await fetch(`${base}/api/v2/auth/login`, { method: 'POST', body })).headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw new Error('qBittorrent login failed');
      const r = await fetch(`${base}/api/v2/torrents/topPrio`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ hashes: q.downloadId.toLowerCase() }) });
      if (!r.ok) throw new Error(`qBittorrent topPrio ${r.status}`); // 409 = torrent queueing disabled
    } else if (cl.implementation === 'Sabnzbd') {
      const apiKey = c.sabApiKey || real(f.apiKey);
      if (!apiKey) throw new Error('SABnzbd API key is hidden by the arr: set SAB_API_KEY (or in the UI)');
      const r = await fetch(`${c.sabUrl || own}/api?mode=switch&value=${q.downloadId}&value2=0&output=json&apikey=${encodeURIComponent(apiKey)}`);
      if (!r.ok) throw new Error(`sabnzbd switch ${r.status}`);
    } else return record({ status: 'info', title, instance: a.name, detail: `queue priority not supported for ${cl.implementation}` });
    return record({ status: 'prioritized', title, instance: a.name, detail: `moved "${q.title}" to top of ${q.downloadClient}` });
  }
  record({ status: 'info', title, instance: a.name, detail: 'replacement not in queue after 2 min; priority not set' });
}

async function replace(c, report) {
  const key = ratingKeyOf(report.url);
  const m = key && (await plex(c, `/library/metadata/${key}`)).Metadata?.[0];
  if (!m) return record({ status: 'skipped', reportId: report.id, detail: 'item no longer in Plex (already deleted or replaced): ' + report.url });
  const title = `${m.grandparentTitle ? m.grandparentTitle + ' ' : ''}${m.title}`;
  const files = new Set(m.Media.flatMap((x) => x.Part.map((p) => path.basename(p.file))));
  const hit = await locate(c, m, files);
  if (!hit) return record({ status: 'skipped', reportId: report.id, title, detail: 'no Sonarr/Radarr instance owns ' + [...files] });
  const { a, ep, movie, fileId } = hit;
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

async function poll() {
  const c = getConfig();
  if (!c.plexToken || !c.arrs.length) throw new Error('not configured: set a Plex token and at least one Sonarr/Radarr instance');
  const nodes = (await reports(c)).sort((x, y) => x.date.localeCompare(y.date));
  let s = readJson(dataFile('state.json'), null);
  if (!s) { // first run: existing reports predate this app, never act on them
    writeJson(dataFile('state.json'), { seen: nodes.map((n) => n.id), day: '', count: 0 });
    return record({ status: 'info', detail: `baselined ${nodes.length} existing reports; only new ones will be acted on` });
  }
  for (const r of nodes.filter((n) => !s.seen.includes(n.id))) {
    const today = new Date().toISOString().slice(0, 10);
    if (s.day !== today) Object.assign(s, { day: today, count: 0 });
    s.seen.push(r.id); // mark first: a crash must not retry a delete
    if (s.count >= c.maxPerDay) { record({ status: 'skipped', reportId: r.id, detail: `daily cap ${c.maxPerDay} reached` }); writeJson(dataFile('state.json'), s); continue; }
    s.count++;
    writeJson(dataFile('state.json'), s);
    await replace(c, r).catch((e) => record({ status: 'error', reportId: r.id, detail: e.message }));
  }
}

function serve() {
  const html = fs.readFileSync(new URL('./ui.html', import.meta.url));
  const pass = process.env.UI_PASSWORD;
  if (!pass) log('UI_PASSWORD not set: the web UI is open to anyone who can reach it');
  const body = (req) => new Promise((res) => { let d = ''; req.on('data', (x) => (d += x)); req.on('end', () => res(d)); });
  http.createServer(async (req, res) => {
    const send = (code, type, data) => { res.writeHead(code, { 'Content-Type': type }); res.end(data); };
    if (pass && Buffer.from((req.headers.authorization ?? '').slice(6), 'base64').toString().split(':').slice(1).join(':') !== pass) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Reportarr"');
      return send(401, 'text/plain', 'auth required');
    }
    try {
      if (req.url === '/api/state') {
        return send(200, 'application/json', JSON.stringify({
          config: publicConfig(), locked: lockedKeys(), status,
          changes: readJson(dataFile('changes.json'), []).reverse(),
        }));
      }
      if (req.url === '/api/config' && req.method === 'POST') { saveConfig(JSON.parse(await body(req))); return send(200, 'application/json', '{}'); }
      send(200, 'text/html', html);
    } catch (err) { send(400, 'application/json', JSON.stringify({ error: err.message })); }
  }).listen(+(process.env.UI_PORT ?? 8080), () => log('web UI on :' + (process.env.UI_PORT ?? 8080)));
}

async function main() {
  serve();
  for (;;) {
    await poll().then(() => { status.lastError = null; }, (e) => { status.lastError = e.message; log('poll error', e.message); });
    status.lastPoll = new Date().toISOString();
    await sleep(getConfig().pollSeconds * 1000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
