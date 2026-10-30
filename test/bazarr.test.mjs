import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import bazarr from '../src/integrations/bazarr.mjs';
import { runCheck } from '../src/checks.mjs';

const KEY = randomBytes(8).toString('hex'); // generated per run so the repo holds no secret-looking literals
const calls = [];
const server = await new Promise((res) => { const s = http.createServer((req, r) => {
  const u = new URL(req.url, 'http://x');
  calls.push(`${req.method} ${u.pathname}${u.search}`);
  if (req.headers['x-api-key'] !== KEY) return r.writeHead(401).end();
  if (u.pathname === '/bazarr/api/system/status') return r.end(JSON.stringify({ data: { bazarr_version: '1.6.0' } }));
  if (u.pathname === '/bazarr/api/movies' && u.searchParams.get('radarrid[]') === '7') {
    return r.end(JSON.stringify({ data: [{ radarrId: 7, subtitles: [{ code2: 'fr', forced: true, hi: false, path: '/m/Film.fr.forced.srt' }], missing_subtitles: [] }] }));
  }
  if (u.pathname.startsWith('/bazarr/api/movies')) return r.end(JSON.stringify({ data: [] }));
  r.writeHead(204).end();
}).listen(0, '127.0.0.1', () => res(s)); });
const url = `http://127.0.0.1:${server.address().port}/bazarr`;
const B = { name: 'bazarr', kind: 'bazarr', url, key: KEY };

test('the Test button accepts the key, and says what is wrong when it is not', async () => {
  assert.deepEqual(await bazarr.check({ url, key: KEY }), { ok: true, message: 'Bazarr 1.6.0: API key accepted' });
  assert.match((await bazarr.check({ url, key: 'wrong' })).message, /was refused \(HTTP 401\)/);
  assert.match((await bazarr.check({ url: url.replace('/bazarr', ''), key: KEY })).message, /base path/, 'a missing base path is hinted at');
  assert.equal((await bazarr.check({ url: '', key: '' })).ok, false);
  const c = { subtitles: [B] };
  assert.equal((await runCheck(c, { target: 'subtitle', kind: 'bazarr', name: 'bazarr', url, key: '' })).ok, true, 'a blank key uses the saved one by name');
});

test('a movie: the external subtitle (with its language, forced and hi flags) is deleted, nothing searched when none is missing', async () => {
  calls.length = 0;
  const said = await bazarr.refresh(B, { movie: { id: 7 } });
  assert.equal(said, 'deleted 1 subtitle file(s), asked Bazarr to search for 0 language(s)');
  assert.ok(calls.includes('DELETE /bazarr/api/movies/subtitles?radarrid=7&language=fr&forced=True&hi=False&path=%2Fm%2FFilm.fr.forced.srt'));
});

test('an item Bazarr does not know, or a hit with no id, is left alone', async () => {
  calls.length = 0;
  assert.equal(await bazarr.refresh(B, { movie: { id: 8 } }), undefined);
  assert.equal(await bazarr.refresh(B, {}), undefined);
  assert.ok(!calls.some((c) => /^(DELETE|PATCH)/.test(c)));
});

test('Bazarr comes from the environment, numbered for more, and is exported to .env', () => {
  assert.deepEqual(bazarr.fromEnv({}), []);
  assert.deepEqual(bazarr.fromEnv({ BAZARR_1_URL: 'http://b1:6767/bazarr/', BAZARR_1_KEY: 'k1', BAZARR_2_URL: 'http://b2', BAZARR_2_NAME: 'kids' }).map((x) => [x.name, x.url, x.key]),
    [['bazarr-1', 'http://b1:6767/bazarr', 'k1'], ['kids', 'http://b2', '']]);
  assert.deepEqual(bazarr.envLines({ name: 'bazarr-1', url: 'http://b', key: 'k' }, 1), [['BAZARR_1_NAME', 'bazarr-1'], ['BAZARR_1_URL', 'http://b'], ['BAZARR_1_KEY', 'k']]);
});

test.after(() => server.close());
