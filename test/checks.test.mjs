import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const rnd = () => randomBytes(8).toString('hex'); // generated per run so the repo holds no secret-looking literals
const S = { plex: rnd(), arr: rnd(), os: rnd(), qb: rnd(), sab: rnd(), wrong: rnd() };
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s)); });
const json = (res, v, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
const url = (s) => `http://127.0.0.1:${s.address().port}`;

const plex = await listen((req, res) => (req.headers['x-plex-token'] === S.plex ? json(res, { MediaContainer: { friendlyName: 'Home', version: '1.43.5' } }) : res.writeHead(401).end()));
const community = await listen(async (req, res) => {
  let body = ''; for await (const d of req) body += d;
  const first = +JSON.parse(body).query.match(/first:\s*(\d+)/)?.[1];
  if (!(first >= 2 && first <= 100)) return json(res, { errors: [{ message: "Invalid pagination argument for field 'reports'. The value for the 'first' argument must be an integer within 2-100." }] }); // as the real plex.tv does
  req.headers['x-plex-token'] === S.plex ? json(res, { data: { reports: { nodes: [] } } }) : json(res, { errors: [{ message: 'not authorized' }] }, 401);
});
process.env.PLEX_COMMUNITY_URL = url(community);
const { runCheck } = await import('../src/checks.mjs');

const arrServer = (appName) => listen((req, res) => (req.url === '/api/v3/system/status' && req.headers['x-api-key'] === S.arr ? json(res, { appName, version: '4.0.20' }) : res.writeHead(req.url.startsWith('/api/v3') ? 401 : 404).end()));
const sonarr = await arrServer('Sonarr');
const lidarr = await listen((req, res) => (req.url === '/api/v1/system/status' && req.headers['x-api-key'] === S.arr ? json(res, { appName: 'Lidarr', version: '3.1.0' }) : res.writeHead(404).end())); // Lidarr only has API v1
const radarr = await arrServer('Radarr');
const overseerr = await listen((req, res) => {
  if (req.url === '/api/v1/status') return json(res, { version: '1.34.0' });
  if (req.url.startsWith('/api/v1/issue')) return req.headers['x-api-key'] === S.os ? json(res, { results: [] }) : res.writeHead(403).end();
  res.writeHead(404).end();
});
const qbit = await listen(async (req, res) => {
  let body = ''; for await (const d of req) body += d;
  if (req.url === '/api/v2/auth/login') {
    if (new URLSearchParams(body).get('password') !== S.qb) return res.end('Fails.');
    res.setHeader('set-cookie', 'SID=x; path=/'); return res.end('Ok.');
  }
  if (req.url === '/api/v2/app/version' && req.headers.cookie === 'SID=x') return res.end('v5.0.2');
  res.writeHead(403).end();
});
const chatty = await listen(async (req, res) => { for await (const _ of req); res.setHeader('set-cookie', 'SID=x'); res.end('Fails.'); }); // sets a cookie even when it refuses
const sab = await listen((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.searchParams.get('mode') === 'version') return json(res, { version: '5.1.3' });
  return u.searchParams.get('apikey') === S.sab ? json(res, { queue: {} }) : res.writeHead(403).end();
});

const base = { sources: [], arrs: [], clients: [] };
const leaks = (r) => Object.values(S).some((v) => r.message.includes(v));

test('Plex: server and plex.tv token are both checked', async () => {
  const good = await runCheck(base, { target: 'source', kind: 'plex', name: '', url: url(plex) + '/', key: S.plex });
  assert.deepEqual([good.ok, good.message], [true, 'Plex "Home" 1.43.5: token accepted, reports readable']);
  const bad = await runCheck(base, { target: 'source', kind: 'plex', name: '', url: url(plex), key: S.wrong });
  assert.equal(bad.ok, false); assert.match(bad.message, /Plex server: the token was refused \(HTTP 401\)/);
  assert.match((await runCheck(base, { target: 'source', kind: 'plex', name: '', url: '', key: '' })).message, /Set a URL and a token first/);
});

test('Sonarr/Radarr: key checked, and a Radarr set up as Sonarr is caught', async () => {
  const ok = await runCheck(base, { target: 'arr', name: 's', kind: 'sonarr', url: url(sonarr), key: S.arr });
  assert.deepEqual([ok.ok, ok.message], [true, 'Sonarr 4.0.20: API key accepted']);
  assert.match((await runCheck(base, { target: 'arr', name: 's', kind: 'sonarr', url: url(sonarr), key: S.wrong })).message, /the API key was refused/);
  assert.match((await runCheck(base, { target: 'arr', name: 'r', kind: 'sonarr', url: url(radarr), key: S.arr })).message, /That address is Radarr, but it is set up as sonarr/);
  assert.match((await runCheck(base, { target: 'arr', name: 's', kind: 'sonarr', url: url(sonarr) + '/wrongbase', key: S.arr })).message, /base path/);
});

test('missing settings are named properly', async () => {
  assert.equal((await runCheck(base, { target: 'client', kind: 'sabnzbd', name: '', url: 'http://x', apiKey: '' })).message, 'Set an API key first');
  assert.equal((await runCheck(base, { target: 'source', kind: 'seerr' })).message, 'Set a URL and an API key first');
});

test('Lidarr is checked on its v1 API', async () => {
  const ok = await runCheck(base, { target: 'arr', name: 'm', kind: 'lidarr', url: url(lidarr), key: S.arr });
  assert.deepEqual([ok.ok, ok.message], [true, 'Lidarr 3.1.0: API key accepted']);
  assert.match((await runCheck(base, { target: 'arr', name: 'm', kind: 'sonarr', url: url(lidarr), key: S.arr })).message, /HTTP 404|base path/); // v3 does not exist there
});

test('Overseerr: key must be able to read issues', async () => {
  assert.match((await runCheck(base, { target: 'source', kind: 'seerr', name: '', url: url(overseerr), key: S.os })).message, /^Overseerr\/Seerr 1\.34\.0: API key accepted/);
  const bad = await runCheck(base, { target: 'source', kind: 'seerr', name: '', url: url(overseerr), key: S.wrong });
  assert.equal(bad.ok, false); assert.match(bad.message, /refused or cannot view issues/);
});

test('qBittorrent and SABnzbd', async () => {
  assert.match((await runCheck(base, { target: 'client', kind: 'qbittorrent', name: '', url: url(qbit), username: 'a', password: S.qb })).message, /qBittorrent v5\.0\.2: login accepted/);
  assert.match((await runCheck(base, { target: 'client', kind: 'qbittorrent', name: '', url: url(qbit), username: 'a', password: S.wrong })).message, /refused the username or password/);
  assert.match((await runCheck(base, { target: 'client', kind: 'sabnzbd', name: '', url: url(sab), apiKey: S.sab })).message, /SABnzbd 5\.1\.3: API key accepted/);
  assert.match((await runCheck(base, { target: 'client', kind: 'sabnzbd', name: '', url: url(sab), apiKey: S.wrong })).message, /full API key, not the NZB key/);
});

test('a refused qBittorrent login is caught even if a cookie comes back', async () => {
  const r = await runCheck(base, { target: 'client', kind: 'qbittorrent', name: '', url: url(chatty), username: 'a', password: S.wrong });
  assert.equal(r.ok, false); assert.match(r.message, /refused the username or password/);
});

test('blank secrets in the form fall back to the saved ones; the form wins when filled in', async () => {
  const saved = { sources: [{ name: 'tv-plex', kind: 'plex', url: url(plex), key: S.plex }, { name: 'requests', kind: 'seerr', url: url(overseerr), key: S.os }],
    arrs: [{ name: 's', kind: 'sonarr', url: url(sonarr), key: S.arr }],
    clients: [{ name: 'qb2', kind: 'qbittorrent', url: url(qbit), username: 'a', password: S.qb, apiKey: '' },
      { name: 'qbittorrent', kind: 'qbittorrent', url: url(qbit), username: 'a', password: S.qb, apiKey: '', default: true },
      { name: 'sabnzbd', kind: 'sabnzbd', url: url(sab), username: '', password: '', apiKey: S.sab, default: true }] };
  assert.equal((await runCheck(saved, { target: 'source', kind: 'plex', name: 'tv-plex', url: url(plex), key: '' })).ok, true);
  assert.equal((await runCheck(saved, { target: 'source', kind: 'seerr', name: 'requests', url: url(overseerr), key: '' })).ok, true);
  assert.equal((await runCheck(saved, { target: 'arr', name: 's', kind: 'sonarr', url: url(sonarr), key: '' })).ok, true);
  assert.equal((await runCheck(saved, { target: 'client', kind: 'qbittorrent', name: 'qb2', url: '', username: '', password: '' })).ok, true, 'saved client by name');
  assert.equal((await runCheck(saved, { target: 'client', kind: 'qbittorrent', name: 'qbittorrent', url: url(qbit), username: 'a', password: '' })).ok, true, 'default qBittorrent password');
  assert.equal((await runCheck(saved, { target: 'client', kind: 'sabnzbd', name: 'sabnzbd', url: url(sab), apiKey: '' })).ok, true, 'default SABnzbd key');
  assert.equal((await runCheck(saved, { target: 'arr', name: 's', kind: 'sonarr', url: url(sonarr), key: S.wrong })).ok, false, 'typed value wins');
});

test('unreachable hosts fail with a reason, and messages never contain secrets', async () => {
  const dead = await listen(() => {}); const closed = url(dead); dead.close();
  const rs = [
    await runCheck(base, { target: 'arr', name: 's', kind: 'sonarr', url: closed, key: S.arr }),
    await runCheck(base, { target: 'source', kind: 'seerr', name: '', url: closed, key: S.os }),
    await runCheck(base, { target: 'source', kind: 'plex', name: '', url: closed, key: S.plex }),
    await runCheck(base, { target: 'client', kind: 'sabnzbd', name: '', url: closed, apiKey: S.sab }),
    await runCheck(base, { target: 'client', kind: 'qbittorrent', name: '', url: closed, username: 'a', password: S.qb }),
    await runCheck(base, { target: 'arr', name: 's', kind: 'sonarr', url: url(sonarr), key: S.wrong }),
  ];
  for (const r of rs) { assert.equal(r.ok, false); assert.ok(!leaks(r), r.message); }
  assert.match(rs[0].message, /sonarr: ECONNREFUSED/);
  assert.equal((await runCheck(base, { target: 'nope' })).ok, false);
});

test.after(() => { for (const s of [lidarr, chatty, plex, community, sonarr, radarr, overseerr, qbit, sab]) s.close(); });
