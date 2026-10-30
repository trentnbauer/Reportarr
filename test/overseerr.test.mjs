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
const { handleReport: replaceIssue, poll, requestRetry, status } = await import('../src/engine.mjs');
const { saveConfig } = await import('../src/config.mjs');

const calls = [];
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s)); });
const json = (res, v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
const route = (name) => (req) => { const u = new URL(req.url, 'http://x'); calls.push(`${req.method} ${name} ${u.pathname}${u.search}`); return u; };

let queueRecords = [], lastComment = ''; // what Sonarr's queue holds, and the last comment posted to Seerr
let imported = false; // flips when the replacement files "arrive" in Sonarr/Radarr
const radarr = await listen((req, res) => {
  const u = route('radarr')(req);
  if (u.pathname === '/api/v3/movie/1') return json(res, { id: 1, hasFile: imported });
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
  if (/^\/api\/v3\/episode\/\d+$/.test(u.pathname)) return json(res, { hasFile: imported, episodeFile: imported ? { path: '/tv/Show/Season 2/Show - S02E01 new.mkv' } : undefined });
  if (u.pathname === '/api/v3/series') return json(res, u.searchParams.get('tvdbId') === '81189' || !u.search ? [{ id: 3, title: 'Show', tmdbId: 1399 }] : []);
  if (u.pathname === '/api/v3/episode') return json(res, eps);
  if (u.pathname === '/api/v3/history') return json(res, { records: [{ id: 88 }] });
  if (u.pathname === '/api/v3/queue') return json(res, { records: queueRecords });
  res.end();
});
let issues = [];
const overseerr = await listen((req, res) => {
  const u = route('overseerr')(req);
  if (req.headers['x-api-key'] !== KEY) return res.writeHead(403).end();
  if (u.pathname === '/api/v1/issue') return json(res, { results: issues });
  if (req.method === 'POST' && u.pathname.endsWith('/comment')) { let b = ''; req.on('data', (d) => (b += d)).on('end', () => { lastComment = JSON.parse(b).message; res.end(); }); return; }
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

test('a movie issue deletes the file, blocklists, searches, then comments but does not resolve yet', async () => {
  const w = await run(issue(1, movie));
  assert.deepEqual(w, [
    'DELETE radarr /api/v3/moviefile/5', 'POST radarr /api/v3/history/failed/77', 'POST radarr /api/v3/command',
    'POST overseerr /api/v1/issue/1/comment']);
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

test('subtitle issues, whole-series issues with that switched off, and unknown titles are skipped without touching anything', async () => {
  assert.deepEqual(await run(issue(5, movie, { issueType: 3 })), []);
  assert.deepEqual(await run(issue(6, tv), { ...base, sources: [{ ...SRC, wholeSeries: false, resolve: false }] }), []);
  assert.deepEqual(await run(issue(7, { tmdbId: 1, tvdbId: null, mediaType: 'movie' })), []);
  const last = changes().slice(-3).map((r) => r.status + ': ' + r.detail);
  assert.match(last[0], /subtitles issues are not set/);
  assert.match(last[1], /Replace whole series/);
  assert.equal(changes().find((r) => r.reportId === 'overseerr:6' && r.status === 'skipped').retry, 'report', 'left open, it can be retried once the switch is on');
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
  assert.ok(calls.includes('POST overseerr /api/v1/issue/11/comment') && !calls.some((c) => c.includes('/issue/10/')));
  assert.ok(!calls.includes('POST overseerr /api/v1/issue/11/resolved'), 'not resolved while the file is missing');
});

test('the issue is resolved only once the replacement file is back, and only once', async () => {
  issues = [];
  calls.length = 0; await poll();
  assert.ok(!calls.some((c) => c.includes('/resolved')), 'still waiting');
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'state.json'), 'utf8')).pending.some((p) => p.ref === 11), true, 'wait survives in the state file');
  imported = true;
  calls.length = 0; await poll();
  assert.ok(calls.includes('POST overseerr /api/v1/issue/11/resolved'));
  assert.match(changes().at(-1).detail, /replacement imported, resolved/);
  assert.equal(changes().at(-1).status, 'resolved');
  assert.ok(changes().some((r) => r.status === 'replacing' && r.reportId === 'overseerr:11'));
  assert.equal((await import('../src/engine.mjs')).status.replacing, 0 + JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'state.json'), 'utf8')).pending.length);
  calls.length = 0; await poll();
  assert.ok(!calls.some((c) => c.includes('/resolved')), 'not resolved a second time');
  imported = false;
});

test('a replacement that never arrives is left open after the wait runs out', async () => {
  const sf = path.join(process.env.DATA_DIR, 'state.json'), s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  s.pending = [{ reportId: 'overseerr:99', kind: 'seerr', source: 'overseerr', ref: 99, items: [{ arr: 'sonarr', check: '/episode/13', title: 'x' }], since: new Date(Date.now() - 73 * 3600_000).toISOString() }];
  fs.writeFileSync(sf, JSON.stringify(s));
  calls.length = 0; await poll();
  assert.ok(!calls.some((c) => c.includes('/issue/99/')));
  assert.match(changes().at(-1).detail, /left open/);
  assert.deepEqual(JSON.parse(fs.readFileSync(sf, 'utf8')).pending, []);
});

test('a bad API key surfaces as an error, not a crash', async () => {
  saveConfig({ sources: [{ ...SRC, key: 'wrong-' + rnd() }] });
  await assert.rejects(poll(), /overseerr: overseerr GET \/issue.* 403/);
});

test('with whole series off, the issue is closed with a note asking for the particular episode', async () => {
  const off = { ...base, sources: [{ ...SRC, wholeSeries: false }] };
  assert.deepEqual(await run(issue(40, tv), off), ['POST overseerr /api/v1/issue/40/comment', 'POST overseerr /api/v1/issue/40/resolved'], 'nothing is deleted');
  assert.match(lastComment, /particular episode/);
  assert.match(lastComment, /— Reportarr \(automated system\)$/);
  const row = changes().at(-1);
  assert.match(row.detail, /closed it and asked for the particular episode/);
  assert.equal(row.retry, undefined, 'the issue is closed, so there is nothing to retry');
  assert.deepEqual(await run(issue(41, tv), { ...off, dryRun: true }), [], 'a dry run does not touch Seerr');
  assert.equal(changes().at(-1).retry, 'report');
});

test('a report naming no season replaces every episode with a file, in every season', async () => {
  const w = (await run(issue(30, tv))).filter((c) => c.startsWith('DELETE'));
  assert.deepEqual(w, ['DELETE sonarr /api/v3/episodefile/101', 'DELETE sonarr /api/v3/episodefile/102', 'DELETE sonarr /api/v3/episodefile/103']);
});

test('a report is replaced whole or not at all: it waits for room, or is skipped when it can never fit', async () => {
  const sf = path.join(process.env.DATA_DIR, 'state.json'), before = fs.readFileSync(sf, 'utf8'), today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(sf, JSON.stringify({ seen: ['overseerr:31'], day: today, count: 4, sources: ['overseerr'], baseline: [], pending: [] }));
  try {
    assert.deepEqual(await run(issue(31, tv), { ...base, maxPerDay: 5 }), [], 'three files do not fit in the one left today: nothing is deleted');
    assert.match(changes().at(-1).detail, /3 files need more than the 1 left today/);
    assert.deepEqual(JSON.parse(fs.readFileSync(sf, 'utf8')).seen, [], 'it will be looked at again on a later poll');
    await run(issue(31, tv), { ...base, maxPerDay: 5 });
    assert.equal(changes().filter((r) => r.reportId === 'overseerr:31').length, 1, 'the waiting row is logged once a day, not every poll');
    assert.deepEqual(await run(issue(32, tv), { ...base, maxPerDay: 2 }), []);
    assert.match(changes().at(-1).detail, /3 files, more than the daily limit of 2/);
    assert.equal(changes().at(-1).retry, 'report');
    fs.writeFileSync(sf, JSON.stringify({ seen: [], day: today, count: 0, sources: ['overseerr'], baseline: [], pending: [] }));
    assert.equal((await run(issue(33, tv), { ...base, maxPerDay: 5 })).filter((c) => c.startsWith('DELETE')).length, 3, 'with room, it all goes');
  } finally { fs.writeFileSync(sf, before); }
});

test('every step of a replacement is logged against the report and the file, and the comment is signed', async () => {
  saveConfig({ sources: [SRC], dryRun: false, arrs: base.arrs }); // the test before left a wrong key saved
  issues = [issue(12, tv, { problemSeason: 2, problemEpisode: 1 })];
  calls.length = 0; await poll();
  assert.match(lastComment, /\n\n— Reportarr \(automated system\)$/);
  const rows = () => changes().filter((r) => r.reportId === 'overseerr:12').map((r) => r.status);
  assert.deepEqual(rows(), ['reported', 'replaced', 'replacing']);
  queueRecords = [{ episodeId: 13, status: 'downloading', size: 10, sizeleft: 4, timeleft: '00:05:00', title: 'Show.S02E01.1080p' }];
  await poll();
  assert.equal(rows().at(-1), 'downloading');
  const dl = status.downloads.find((d) => d.reportId === 'overseerr:12');
  assert.deepEqual([dl.pct, dl.stage, dl.release], [60, 'downloading', 'Show.S02E01.1080p']);
  assert.ok(Math.abs(Date.parse(dl.eta) - Date.now() - 300_000) < 5000, 'the ETA is five minutes from now');
  queueRecords = [{ episodeId: 13, status: 'completed', size: 10, sizeleft: 0, title: 'Show.S02E01.1080p' }];
  await poll();
  assert.equal(rows().at(-1), 'downloaded');
  assert.equal(status.downloads.find((d) => d.reportId === 'overseerr:12').pct, 100);
  imported = true; queueRecords = [];
  await poll();
  assert.deepEqual(rows().slice(-2), ['imported', 'resolved']);
  assert.ok(!status.downloads.some((d) => d.reportId === 'overseerr:12'), 'nothing left to show once it is resolved');
  const done = changes().find((r) => r.reportId === 'overseerr:12' && r.status === 'imported');
  assert.equal(done.file, 'Show - S02E01 new.mkv');
  assert.equal(changes().find((r) => r.reportId === 'overseerr:12' && r.status === 'replaced').file, undefined, 'mock episode file has no path');
  imported = false;
});

test('a failed queue priority saved by an older version can still be retried', async () => {
  saveConfig({ sources: [SRC], dryRun: false, arrs: base.arrs });
  const file = path.join(process.env.DATA_DIR, 'changes.json'), rows = changes();
  rows.push({ id: 'legacy-1', time: new Date().toISOString(), status: 'error', reportId: 'overseerr:6', title: 'Show S02E01', instance: 'sonarr', detail: 'priority failed: qBittorrent password for x is hidden by the arr' });
  fs.writeFileSync(file, JSON.stringify(rows));
  queueRecords = [{ episodeId: 13, series: { title: 'Show' }, episode: { seasonNumber: 2, episodeNumber: 1 }, title: 'rel' }];
  requestRetry('legacy-1');
  await poll();
  assert.match(changes().at(-1).detail, /retrying queue priority/);
  assert.equal(changes().find((r) => r.id === 'legacy-1').retried, true);
  queueRecords = [];
  const tries = () => changes().filter((r) => r.detail === 'retrying queue priority').length;
  const before = tries();
  requestRetry('legacy-1'); await poll(); // only once
  assert.equal(tries(), before);
  rows.push({ id: 'legacy-2', time: new Date().toISOString(), status: 'error', reportId: 'overseerr:6', title: 'Show S09E09', instance: 'sonarr', detail: 'priority failed: x' });
  fs.writeFileSync(file, JSON.stringify(rows.map((r) => (r.id === 'legacy-1' ? changes().find((x) => x.id === 'legacy-1') : r))));
  requestRetry('legacy-2'); await poll();
  assert.match(changes().at(-1).detail, /no longer in the queue/);
});

test.after(() => { for (const s of [radarr, sonarr, overseerr]) s.close(); });
