import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import plex from '../src/integrations/plex.mjs';

const part = (f) => ({ Part: [{ file: `/media/${f}` }] });
const server = await new Promise((res) => { const s = http.createServer((req, r) => {
  const u = new URL(req.url, 'http://x'), json = (v) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ MediaContainer: v })); };
  if (u.pathname === '/library/sections') return json({ Directory: [{ key: '5', type: 'movie' }, { key: '7', type: 'show' }] });
  const title = u.searchParams.get('title');
  if (u.pathname === '/library/sections/5/all') return json({ Metadata: title === 'The Matrix' ? [{ title, Guid: [{ id: 'tmdb://603' }], Media: [part('Matrix new.mkv')] }] : [] });
  if (u.pathname === '/library/sections/7/all') return json({ Metadata: title === 'Show' ? [{ ratingKey: '9', title, Guid: [{ id: 'tvdb://81189' }] }] : [] });
  if (u.pathname === '/library/metadata/9/allLeaves') return json({ Metadata: [{ parentIndex: 2, index: 1, Media: [part('Show - S02E01 new.mkv')] }, { parentIndex: 2, index: 2, Media: [] }] });
  r.writeHead(404).end();
}).listen(0, '127.0.0.1', () => res(s)); });
const src = { url: `http://127.0.0.1:${server.address().port}`, key: 'k' };

test('a movie is available once Plex lists it with the new file', async () => {
  const d = { type: 'movie', title: 'The Matrix', tmdb: 603 };
  assert.equal(await plex.available(src, d, 'Matrix new.mkv'), true);
  assert.equal(await plex.available(src, d, 'Matrix old.mkv'), false, 'Plex still shows the old file');
  assert.equal(await plex.available(src, { ...d, tmdb: 1 }), false, 'same title, different id');
  assert.equal(await plex.available(src, { ...d, title: 'Other' }), false);
});

test('an episode is available once its season and episode have a file in Plex', async () => {
  const d = { type: 'episode', title: 'Show', tvdb: 81189, season: 2, episode: 1 };
  assert.equal(await plex.available(src, d, 'Show - S02E01 new.mkv'), true);
  assert.equal(await plex.available(src, d), true);
  assert.equal(await plex.available(src, { ...d, episode: 2 }), false, 'listed but without a file');
});

test.after(() => server.close());
