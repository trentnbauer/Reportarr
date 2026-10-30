import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import whisparr from '../src/integrations/whisparr.mjs';
import { LISTS } from '../src/integrations/index.mjs';

// a Whisparr 2 (series and episodes) and a Whisparr 3 (movies), each answering only what its generation has
const server = (handler) => new Promise((res) => { const s = http.createServer((req, r) => {
  const u = new URL(req.url, 'http://x'); r.setHeader('content-type', 'application/json');
  const v = handler(u);
  if (v === undefined) return r.writeHead(404).end();
  r.end(JSON.stringify(v));
}).listen(0, '127.0.0.1', () => res(s)); });
const v2 = await server((u) => {
  if (u.pathname === '/api/v3/system/status') return { appName: 'Whisparr', version: '2.2.0.108' };
  if (u.pathname === '/api/v3/series') return [{ id: 4, title: 'Some Studio' }, { id: 5, title: 'Other' }];
  if (u.pathname === '/api/v3/episode') return u.searchParams.get('seriesId') === '4'
    ? [{ id: 41, hasFile: true, episodeFile: { id: 401, path: '/adult/Some Studio/Scene A.mp4' } }, { id: 42, hasFile: true, episodeFile: { id: 402, path: '/adult/Some Studio/Scene B.mp4' } }, { id: 43, hasFile: false }] : [];
});
const v3 = await server((u) => {
  if (u.pathname === '/api/v3/system/status') return { appName: 'Whisparr', version: '3.0.0.1' };
  if (u.pathname === '/api/v3/movie') return [{ id: 9, hasFile: true, movieFile: { id: 90, path: '/adult/Movies/Film One.mkv' } }, { id: 10, hasFile: false }];
});
const A2 = { name: 'whisparr-2', kind: 'whisparr', url: `http://127.0.0.1:${v2.address().port}`, key: 'k' };
const A3 = { name: 'whisparr-3', kind: 'whisparr', url: `http://127.0.0.1:${v3.address().port}`, key: 'k' };

test('Whisparr is an *arr kind, read from WHISPARR_N_* variables, and its Test checks it really is Whisparr', async () => {
  assert.ok(LISTS.arrs.whisparr === whisparr);
  assert.deepEqual(whisparr.fromEnv({ WHISPARR_1_URL: 'http://w:6969/', WHISPARR_1_KEY: 'k' }).map((x) => [x.name, x.kind, x.url]), [['whisparr-1', 'whisparr', 'http://w:6969']]);
  assert.match((await whisparr.check({ url: A2.url, key: 'k', kind: 'whisparr' })).message, /Whisparr 2\.2\.0\.108/);
  assert.match((await whisparr.check({ url: A3.url, key: 'k', kind: 'sonarr' })).message, /Whisparr 3/, 'both generations answer as Whisparr');
});

test('Whisparr 2: a reported episode is found by its series name and the name of its file', async () => {
  const hit = await whisparr.fromPlex({ a: A2, m: { type: 'episode', grandparentTitle: 'some-studio' }, files: new Set(['Scene B.mp4']) });
  assert.deepEqual([hit.ep.id, hit.fileId, hit.file], [42, 402, 'Scene B.mp4']);
  assert.equal(await whisparr.fromPlex({ a: A2, m: { type: 'episode', grandparentTitle: 'Some Studio' }, files: new Set(['not here.mp4']) }), undefined);
  assert.equal(await whisparr.fromPlex({ a: A2, m: { type: 'episode', grandparentTitle: 'Unknown' }, files: new Set(['Scene A.mp4']) }), undefined);
});

test('Whisparr 3: a reported movie is found by the name of its file', async () => {
  const hit = await whisparr.fromPlex({ a: A3, m: { type: 'movie' }, files: new Set(['Film One.mkv']) });
  assert.deepEqual([hit.movie.id, hit.fileId, hit.file], [9, 90, 'Film One.mkv']);
  assert.equal(await whisparr.fromPlex({ a: A3, m: { type: 'movie' }, files: new Set(['other.mkv']) }), undefined);
});

test('the other generation is not an error: it has no such endpoint, so it simply has nothing', async () => {
  assert.equal(await whisparr.fromPlex({ a: A2, m: { type: 'movie' }, files: new Set(['Film One.mkv']) }), undefined, 'Whisparr 2 has no /movie');
  assert.equal(await whisparr.fromPlex({ a: A3, m: { type: 'episode', grandparentTitle: 'Some Studio' }, files: new Set(['Scene A.mp4']) }), undefined, 'Whisparr 3 has no /series');
  assert.equal(await whisparr.fromPlex({ a: A2, m: { type: 'track' }, files: new Set() }), undefined);
});

test('the plan is the parent app\'s: episodes like Sonarr, movies like Radarr', () => {
  const e = whisparr.plan({ ep: { id: 42 } }), m = whisparr.plan({ movie: { id: 9 } });
  assert.deepEqual([e.del(402), e.cmd.name, e.check, e.match], ['/episodefile/402', 'EpisodeSearch', '/episode/42', { episodeId: 42 }]);
  assert.deepEqual([m.del(90), m.cmd.name, m.check, m.match], ['/moviefile/90', 'MoviesSearch', '/movie/9', { movieId: 9 }]);
});

test.after(() => { v2.close(); v3.close(); });
