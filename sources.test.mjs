import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const rnd = () => randomBytes(8).toString('hex'); // generated per run so the repo holds no secret-looking literals
const T = { acct: rnd(), other: rnd(), os1: rnd(), os2: rnd(), bad: rnd() };
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-src-'));

const listen = (h) => new Promise((res) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => res(s)); });
const json = (res, v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
const url = (s) => `http://127.0.0.1:${s.address().port}`;
const calls = [];

// plex.tv: one account (T.acct) owns two servers, another account (T.other) owns a third
let reports = { [T.acct]: [], [T.other]: [] };
const community = await listen(async (req, res) => { for await (const _ of req); const t = req.headers['x-plex-token']; reports[t] ? json(res, { data: { reports: { nodes: reports[t] } } }) : json(res, { errors: [{ message: 'not authorized' }] }); });
process.env.PLEX_COMMUNITY_URL = url(community);

const plexServer = (machine, items) => listen((req, res) => {
  calls.push(`${machine} ${req.url}`);
  if (req.url === '/identity') return json(res, { MediaContainer: { machineIdentifier: machine } });
  const id = req.url.match(/\/library\/metadata\/(\d+)/)?.[1];
  return items[id] ? json(res, { MediaContainer: { Metadata: [items[id]] } }) : res.writeHead(404).end();
});
const movie = (title, tmdb, file) => ({ type: 'movie', title, Guid: [{ id: `tmdb://${tmdb}` }], Media: [{ Part: [{ file: `/nfs/Movies/${file}` }] }] });
const plexA = await plexServer('machine-a', { 10: movie('Alpha', 1, 'Alpha.mkv') });
const plexB = await plexServer('machine-b', { 20: movie('Beta', 2, 'Beta.mkv') });
const plexC = await plexServer('machine-c', { 30: movie('Gamma', 3, 'Gamma.mkv') });

const radarr = await listen((req, res) => {
  const u = new URL(req.url, 'http://x'); calls.push(`radarr ${req.method} ${u.pathname}${u.search}`);
  if (u.pathname === '/api/v3/movie') { const n = u.searchParams.get('tmdbId'); return json(res, ['1', '2', '3'].includes(n) ? [{ id: +n, title: `movie ${n}`, hasFile: true, movieFile: { id: 50 + +n, path: `/movies/${{ 1: 'Alpha', 2: 'Beta', 3: 'Gamma' }[n]}.mkv` } }] : []); }
  if (u.pathname === '/api/v3/queue') return json(res, { records: [] });
  json(res, []);
});
// two Overseerr instances that both have an issue #5
const seerr = (key, issues) => listen((req, res) => {
  const u = new URL(req.url, 'http://x'); calls.push(`seerr:${key.slice(0, 3)} ${req.method} ${u.pathname}`);
  if (req.headers['x-api-key'] !== key) return res.writeHead(403).end();
  return u.pathname === '/api/v1/issue' ? json(res, { results: issues }) : res.end();
});
const issue = (id) => ({ id, issueType: 1, status: 1, problemSeason: 0, problemEpisode: 0, media: { tmdbId: 1, tvdbId: null, mediaType: 'movie' }, createdAt: '2026-10-29T00:00:00Z' });
let issues1 = [], issues2 = [];
const seerr1 = await seerr(T.os1, issues1);
const seerr2 = await seerr(T.os2, issues2);

const { poll, serve } = await import('./app.mjs');
const { saveConfig } = await import('./config.mjs');
const changes = () => JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'changes.json'), 'utf8'));
const report = (id, machine, key, date) => ({ id, date, url: `server://${machine}/com.plexapp.plugins.library/library/metadata/${key}` });

test('two Plex servers on one account, and a third on another account, each take only their own reports', async () => {
  saveConfig({
    dryRun: true,
    sources: [{ name: 'plex', kind: 'plex', url: url(plexA), key: T.acct }, { name: 'family', kind: 'plex', url: url(plexB), key: T.acct }, { name: 'cousin', kind: 'plex', url: url(plexC), key: T.other }],
    arrs: [{ name: 'films', kind: 'radarr', url: url(radarr), key: 'k' }],
  });
  reports = { [T.acct]: [report('old-a', 'machine-a', 10, '2026-10-01'), report('old-b', 'machine-b', 20, '2026-10-02')], [T.other]: [] };
  await poll(); // first poll: whatever exists is baselined, never actioned
  assert.deepEqual(changes().map((r) => r.status), ['info', 'info', 'info']);
  assert.match(changes()[0].detail, /baselined 1 existing plex report/);
  assert.match(changes()[1].detail, /baselined 1 existing family report/);
  assert.match(changes()[2].detail, /baselined 0 existing cousin report/);

  calls.length = 0;
  reports = { [T.acct]: [...reports[T.acct], report('new-a', 'machine-a', 10, '2026-10-29T01:00'), report('new-b', 'machine-b', 20, '2026-10-29T02:00')], [T.other]: [report('new-c', 'machine-c', 30, '2026-10-29T03:00')] };
  await poll();
  const rows = changes().filter((r) => r.status === 'dry-run');
  assert.deepEqual(rows.map((r) => [r.reportId, r.title, r.source]), [['new-a', 'Alpha', 'Plex report'], ['new-b', 'Beta', 'family report'], ['new-c', 'Gamma', 'cousin report']]);
  // each report was looked up on its own server, never on another
  assert.deepEqual(calls.filter((x) => /\/library\/metadata/.test(x)), ['machine-a /library/metadata/10', 'machine-b /library/metadata/20', 'machine-c /library/metadata/30']);
});

test('one source failing is reported but does not stop the others; a source with no token is "not configured"', async () => {
  saveConfig({ sources: [
    { name: 'plex', kind: 'plex', url: url(plexA), key: T.acct }, { name: 'broken', kind: 'plex', url: url(plexB), key: T.bad },
    { name: 'empty', kind: 'plex', url: url(plexC), key: '' }] });
  const partial = await poll();
  assert.match(partial, /broken: reports query failed/);
  const { port } = await new Promise((r) => { process.env.UI_PORT = '0'; delete process.env.UI_PASSWORD; const s = serve(); s.once('listening', () => r({ port: s.address().port, s })); }).then((x) => { x.s.unref(); return x; });
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.deepEqual(Object.entries(state.health).map(([k, v]) => [k, v.ok]), [['source:plex', true], ['source:broken', false], ['source:empty', null], ['arr:films', true]]); // sources every poll, *arr instances every few minutes
  assert.match(state.health['source:broken'].message, /not authorized/);
  assert.deepEqual(state.config.sources.map((s) => [s.name, s.keySet, s.fromEnv]), [['plex', true, false], ['broken', true, false], ['empty', false, false]]);
  assert.ok(!JSON.stringify(state).includes(T.acct), 'no keys in the state');
});

test('today\'s count and the limit are reported, and the count resets on a new day', async () => {
  const { port, s } = await new Promise((r) => { process.env.UI_PORT = '0'; const s = serve(); s.once('listening', () => { s.unref(); r({ port: s.address().port, s }); }); });
  const get = async () => (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).today;
  const stateFile = path.join(process.env.DATA_DIR, 'state.json');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(await get(), { count: st.count, max: 20 });
  assert.ok(st.count >= 3, 'the three replacements above count');
  fs.writeFileSync(stateFile, JSON.stringify({ ...st, day: '2000-01-01', count: 99 }));
  assert.deepEqual(await get(), { count: 0, max: 20 });
  s.close();
});

test('two Overseerr instances can both have an issue #5; the first keeps the old id format', async () => {
  saveConfig({ dryRun: true,
    sources: [{ name: 'overseerr', kind: 'seerr', url: url(seerr1), key: T.os1, issueTypes: 'video', resolve: true }, { name: 'seerr-2', kind: 'seerr', url: url(seerr2), key: T.os2, issueTypes: 'video', resolve: false }] });
  await poll(); // baselines both new sources
  const before = changes().length;
  issues1.push(issue(5)); issues2.push(issue(5));
  await poll();
  const rows = changes().slice(before).filter((r) => r.status === 'dry-run');
  assert.deepEqual(rows.map((r) => [r.reportId, r.source]), [['overseerr:5', 'Overseerr issue #5 · video'], ['overseerr:seerr-2:5', 'seerr-2 issue #5 · video']]);
});

test.after(() => { for (const s of [community, plexA, plexB, plexC, radarr, seerr1, seerr2]) s.close(); });
