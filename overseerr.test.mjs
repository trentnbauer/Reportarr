import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const rnd = () => randomBytes(8).toString('hex'); // generated per run so the repo holds no secret-looking literals
const KEY = rnd();
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-os-'));
const { replaceIssue, poll } = await import('./app.mjs');
const { saveConfig } = await import('./config.mjs');

const calls = [];
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s)); });
const json = (res, v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
const route = (name) => (req) => { const u = new URL(req.url, 'http://x'); calls.push(`${req.method} ${name} ${u.pathname}${u.search}`); return u; };

const radarr = await listen((req, res) => {
  const u = route('radarr')(req);
  if (u.pathname === '/api/v3/movie') return json(res, u.searchParams.get('tmdbId') === '603' ? [{ id: 1, title: 'The Matrix', hasFile: true, movieFile: { id: 5 } }] : []);
  if (u.pathname === '/api/v3/history/movie') return json(res, [{ id: 77 }]);
  if (u.pathname === '/api/v3/queue') return json(res, { records: [] });
  res.end();
});
const eps = [
  { id: 11, seasonNumber: 1, episodeNumber: 1, hasFile: true, episodeFile: { id: 101 } },
  { id: 12, seasonNumber: 1, episodeNumber: 2, hasFile: true, episodeFile: { id: 102 } },
  { id: 13, seasonNumber: 2, episodeNumber: 1, hasFile: true, episodeFile: { id: 103 } },
  { id: 14, seasonNumber: 1, episodeNumber: 3, hasFile: false },
];
const sonarr = await listen((req, res) => {
  const u = route('sonarr')(req);
  if (u.pathname === '/api/v3/series') return json(res, u.searchParams.get('tvdbId') === '81189' || !u.search ? [{ id: 3, title: 'Show', tmdbId: 1399 }] : []);
  if (u.pathname === '/api/v3/episode') return json(res, eps);
  if (u.pathname === '/api/v3/history') return json(res, { records: [{ id: 88 }] });
  if (u.pathname === '/api/v3/queue') return json(res, { records: [] });
  res.end();
});
let issues = [];
const overseerr = await listen((req, res) => {
  const u = route('overseerr')(req);
  if (req.headers['x-api-key'] !== KEY) return res.writeHead(403).end();
  if (u.pathname === '/api/v1/issue') return json(res, { results: issues });
  res.end();
});

const SRC = { name: 'overseerr', kind: 'seerr', url: `http://127.0.0.1:${overseerr.address().port}/`, key: KEY, issueTypes: 'video,audio,other', resolve: true };
const base = { dryRun: false, clients: [], sources: [SRC],
  arrs: [{ name: 'radarr', kind: 'radarr', url: `http://127.0.0.1:${radarr.address().port}`, key: 'k' }, { name: 'sonarr', kind: 'sonarr', url: `http://127.0.0.1:${sonarr.address().port}`, key: 'k' }] };
const movie = { tmdbId: 603, tvdbId: null, mediaType: 'movie' };
const tv = { tmdbId: 1399, tvdbId: 81189, mediaType: 'tv' };
const issue = (id, media, extra = {}) => ({ id, issueType: 1, status: 1, problemSeason: 0, problemEpisode: 0, media, createdAt: '2026-10-29T00:00:00Z', ...extra });
const run = async (i, cfg = base) => { calls.length = 0; await replaceIssue(cfg, { id: `overseerr:${i.id}`, kind: 'seerr', source: 'overseerr', src: cfg.sources[0], issue: i }); return calls.filter((c) => !c.includes('GET')); };
const changes = () => JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'changes.json'), 'utf8'));

test('a movie issue deletes the file, blocklists, searches, then comments and resolves', async () => {
  const w = await run(issue(1, movie));
  assert.deepEqual(w, [
    'DELETE radarr /api/v3/moviefile/5', 'POST radarr /api/v3/history/failed/77', 'POST radarr /api/v3/command',
    'POST overseerr /api/v1/issue/1/comment', 'POST overseerr /api/v1/issue/1/resolved']);
});

test('an episode issue replaces only that episode; a season issue replaces every episode with a file in it', async () => {
  assert.deepEqual((await run(issue(2, tv, { problemSeason: 1, problemEpisode: 2 }))).filter((c) => c.includes('sonarr')).filter((c) => c.startsWith('DELETE')), ['DELETE sonarr /api/v3/episodefile/102']);
  const season = (await run(issue(3, tv, { problemSeason: 1 }))).filter((c) => c.startsWith('DELETE'));
  assert.deepEqual(season, ['DELETE sonarr /api/v3/episodefile/101', 'DELETE sonarr /api/v3/episodefile/102']); // not season 2, not the episode without a file
});

test('a series without a TVDB id is found by TMDB id', async () => {
  const w = await run(issue(4, { ...tv, tvdbId: null }, { problemSeason: 1, problemEpisode: 1 }));
  assert.ok(w.includes('DELETE sonarr /api/v3/episodefile/101'));
});

test('subtitle issues, whole-series issues and unknown titles are skipped without touching anything', async () => {
  assert.deepEqual(await run(issue(5, movie, { issueType: 3 })), []);
  assert.deepEqual(await run(issue(6, tv)), []);
  assert.deepEqual(await run(issue(7, { tmdbId: 1, tvdbId: null, mediaType: 'movie' })), []);
  const last = changes().slice(-3).map((r) => r.status + ': ' + r.detail);
  assert.match(last[0], /subtitles issues are not set/);
  assert.match(last[1], /whole series/);
  assert.match(last[2], /no Sonarr\/Radarr instance/);
});

test('dry run and "resolve off" leave Overseerr alone', async () => {
  assert.deepEqual(await run(issue(8, movie), { ...base, dryRun: true }), []);
  const w = await run(issue(9, movie), { ...base, sources: [{ ...SRC, resolve: false }] });
  assert.ok(w.includes('DELETE radarr /api/v3/moviefile/5') && !w.some((c) => c.includes('overseerr')));
});

test('a source configured for the first time is baselined, then only new issues are acted on', async () => {
  saveConfig({ sources: [SRC], dryRun: false, arrs: base.arrs });
  issues = [issue(10, movie)];
  calls.length = 0; await poll();
  assert.ok(!calls.some((c) => c.startsWith('DELETE')), 'existing issue must not be actioned');
  assert.match(changes().at(-1).detail, /baselined 1 existing overseerr/);
  issues = [issue(10, movie), issue(11, tv, { problemSeason: 2, problemEpisode: 1 })];
  calls.length = 0; await poll();
  assert.deepEqual(calls.filter((c) => c.startsWith('DELETE')), ['DELETE sonarr /api/v3/episodefile/103']);
  assert.ok(calls.includes('POST overseerr /api/v1/issue/11/resolved') && !calls.some((c) => c.includes('/issue/10/')));
});

test('a bad API key surfaces as an error, not a crash', async () => {
  saveConfig({ sources: [{ ...SRC, key: 'wrong-' + rnd() }] });
  await assert.rejects(poll(), /overseerr: overseerr GET \/issue.* 403/);
});

test.after(() => { for (const s of [radarr, sonarr, overseerr]) s.close(); });
