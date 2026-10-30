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

let failDelete = false;
const radarr = await listen((req, res) => {
  const u = new URL(req.url, 'http://x'); calls.push(`radarr ${req.method} ${u.pathname}${u.search}`);
  if (failDelete && req.method === 'DELETE') return res.writeHead(500).end();
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

const { poll, status, requestHistoric, requestRetry } = await import('../src/engine.mjs');
const { serve } = await import('../src/server.mjs');
const { saveConfig } = await import('../src/config.mjs');
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
  const get = async () => (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).limit;
  const stateFile = path.join(process.env.DATA_DIR, 'state.json');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const usage = async () => { const { resetsAt, ...u } = await get(); assert.ok(Date.parse(resetsAt) > Date.now() && Date.parse(resetsAt) - Date.now() <= 3600_000, 'it restarts within the hour'); return u; };
  assert.deepEqual(await usage(), { count: st.count, max: 10, overridden: false });
  assert.equal(st.count, 0, 'the dry runs above do not use up the hourly limit');
  fs.writeFileSync(stateFile, JSON.stringify({ ...st, hour: '2000-01-01T00', count: 99 }));
  assert.deepEqual(await usage(), { count: 0, max: 10, overridden: false });
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

test('live: the cap counts real replacements and delays (never drops) new reports; the baseline survives a lost log; a failed report can be retried', async () => {
  const stateFile = path.join(process.env.DATA_DIR, 'state.json'), st = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const lose = () => fs.writeFileSync(path.join(process.env.DATA_DIR, 'changes.json'), '[]'); // the log rolls over, or is lost
  const newDay = () => fs.writeFileSync(stateFile, JSON.stringify({ ...st(), hour: '2000-01-01T00' })); // the hour turns over
  const replaced = () => changes().filter((r) => r.status === 'replaced').map((r) => r.reportId);
  saveConfig({ dryRun: false, maxPerHour: 1, sources: [{ name: 'plex', kind: 'plex', url: url(plexA), key: T.acct }] });
  reports[T.acct].push(report('cap-1', 'machine-a', 10, '2026-10-30T01:00'), report('cap-2', 'machine-a', 10, '2026-10-30T02:00'));
  lose(); newDay(); await poll();
  assert.deepEqual(replaced(), ['cap-1']);
  assert.match(changes().at(-1).detail, /hourly limit 1 reached; 1 new report\(s\) wait until the next hour/);
  assert.ok(!st().seen.includes('cap-2'), 'the second report waits');
  assert.ok(changes().some((r) => r.reportId === 'cap-2' && /waiting: the hourly limit of 1 is reached/.test(r.detail)), 'and says so in its own timeline');
  lose(); newDay(); await poll();
  assert.deepEqual(replaced(), ['cap-2'], 'and is handled when the limit resets');

  // old-a was open on day one; losing the log must neither hide it nor bring back reports already handled
  lose(); await poll();
  assert.equal(status.historic, 1);
  saveConfig({ maxPerHour: 5 }); requestHistoric(); await poll();
  assert.deepEqual(replaced(), ['old-a']);
  lose(); await poll();
  assert.equal(status.historic, 0, 'a replaced report never counts as historic again');

  failDelete = true; reports[T.acct].push(report('flaky', 'machine-a', 10, '2026-10-30T03:00'));
  lose(); await poll();
  const failed = changes().find((r) => r.status === 'error');
  assert.deepEqual([failed.reportId, failed.retry], ['flaky', 'report']);
  failDelete = false; requestRetry(failed.id); await poll();
  assert.deepEqual(replaced(), ['flaky']);
  assert.equal(changes().find((r) => r.id === failed.id).retried, true, 'the button goes away');
  requestRetry(failed.id); await poll();
  assert.deepEqual(replaced(), ['flaky'], 'a row is only retried once');
  saveConfig({ dryRun: true });
});

test.after(() => { for (const s of [community, plexA, plexB, plexC, radarr, seerr1, seerr2]) s.close(); });
