import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-lidarr-'));
const { replace } = await import('./app.mjs');

const calls = [];
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s)); });
const json = (res, v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };

// shaped like the responses of a real Plex music library and Lidarr 3.1 (API v1)
const track = (file, artist = 'Bad Omens') => ({ MediaContainer: { Metadata: [{ ratingKey: '5', type: 'track', title: 'Glass Houses', grandparentTitle: artist, parentTitle: 'Bad Omens', Media: [{ Part: [{ file }] }] }] } });
let plexTrack = track('/nfs/Media/Music/Bad Omens/Bad Omens (2016)/01 - Glass Houses.flac');
const plex = await listen((req, res) => (req.url.startsWith('/library/metadata/5') ? json(res, plexTrack) : res.writeHead(404).end()));
const files = [{ id: 638, albumId: 76, artistId: 11, path: '/music/Bad Omens/Bad Omens (2016)/01 - Glass Houses.flac' }, { id: 639, albumId: 76, artistId: 11, path: '/music/Bad Omens/Bad Omens (2016)/02 - Dethrone.flac' }, { id: 700, albumId: 90, artistId: 11, path: '/music/Bad Omens/Other (2019)/01 - Other.flac' }];
const lidarr = await listen(async (req, res) => {
  const u = new URL(req.url, 'http://x'); for await (const _ of req);
  calls.push(`${req.method} ${u.pathname}${u.search}`);
  if (u.pathname === '/api/v1/artist') return json(res, [{ id: 3, artistName: 'Someone Else' }, { id: 11, artistName: 'Bad Omens' }]);
  if (u.pathname === '/api/v1/trackfile') return json(res, files.filter((f) => (u.searchParams.has('albumId') ? f.albumId === +u.searchParams.get('albumId') : f.artistId === +u.searchParams.get('artistId'))));
  if (u.pathname === '/api/v1/history') return json(res, { records: [{ id: 1249, eventType: 'grabbed' }] });
  if (u.pathname === '/api/v1/queue') return json(res, { records: [] });
  res.end();
});
const c = (over = {}) => ({ dryRun: false, clients: [], sources: [{ name: 'plex', kind: 'plex', url: `http://127.0.0.1:${plex.address().port}`, key: 't' }], arrs: [{ name: 'music', kind: 'lidarr', url: `http://127.0.0.1:${lidarr.address().port}`, key: 'k' }], ...over });
const report = { id: 'r1', url: 'server://x/com.plexapp.plugins.library/library/metadata/5' };
const changes = () => JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'changes.json'), 'utf8'));
const writes = () => calls.filter((x) => !x.startsWith('GET'));

test('a reported track replaces its whole album in Lidarr, using the v1 API', async () => {
  calls.length = 0;
  await replace(c(), report);
  assert.deepEqual(writes(), [
    'DELETE /api/v1/trackfile/638', 'DELETE /api/v1/trackfile/639', // the album's two files, not the other album's
    'POST /api/v1/history/failed/1249', 'POST /api/v1/command']);
  assert.ok(calls.every((x) => x.includes('/api/v1/')), 'Lidarr is API v1, not v3');
  assert.ok(calls.includes('GET /api/v1/history?albumId=76&eventType=1&pageSize=1&sortKey=date&sortDirection=descending'));
  assert.match(changes().at(-1).detail, /deleted 2 files, blocklisted: true, search started/);
});

test('dry run only reports what it would do', async () => {
  calls.length = 0;
  await replace(c({ dryRun: true }), report);
  assert.deepEqual(writes(), []);
  assert.match(changes().at(-1).detail, /would delete 2 files, blocklist, search/);
});

test('a track from another artist, or with a file Lidarr does not have, is skipped without deleting', async () => {
  plexTrack = track('/nfs/Media/Music/Bad Omens/Bad Omens (2016)/01 - Glass Houses.flac', 'Nobody');
  calls.length = 0; await replace(c(), report); assert.deepEqual(writes(), []);
  plexTrack = track('/nfs/Media/Music/Bad Omens/Bad Omens (2016)/99 - Not In Lidarr.flac');
  calls.length = 0; await replace(c(), report); assert.deepEqual(writes(), []);
  assert.match(changes().at(-1).detail, /no Sonarr\/Radarr instance owns/);
});

test('music in Plex is ignored when no Lidarr is configured', async () => {
  plexTrack = track('/nfs/Media/Music/Bad Omens/Bad Omens (2016)/01 - Glass Houses.flac');
  calls.length = 0; await replace(c({ arrs: [] }), report); assert.deepEqual(calls, []);
});

test.after(() => { plex.close(); lidarr.close(); });
