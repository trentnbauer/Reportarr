import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const rnd = () => randomBytes(8).toString('hex'); // generated per run so the repo holds no secret-looking literals
const S = { pwA: rnd(), pwB: rnd(), keyA: rnd(), keyB: rnd(), token: rnd(), key: rnd(), kept: rnd(), wrong: rnd(), ui: rnd() };
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-'));
process.env.POLL_SECONDS = '30'; // env-locked key
const { VERSION, ratingKeyOf, idsOf, clientFor, prioritize, serve, pendingHistoric, parseBase } = await import('./app.mjs');
const { getConfig, publicConfig, saveConfig, lockedKeys } = await import('./config.mjs');

test('ratingKeyOf / idsOf parse Plex references', () => {
  assert.equal(ratingKeyOf('server://abc/com.plexapp.plugins.library/library/metadata/121709'), '121709');
  assert.equal(ratingKeyOf('nonsense'), undefined);
  assert.deepEqual(idsOf([{ id: 'tvdb://190252' }, { id: 'tmdb://178916' }]), { tvdb: '190252', tmdb: '178916' });
});

test('env wins over the UI and is reported as locked', () => {
  saveConfig({ pollSeconds: 15, maxPerDay: 3 });
  assert.equal(getConfig().pollSeconds, 30);
  assert.equal(getConfig().maxPerDay, 3);
  assert.deepEqual(lockedKeys(), ['pollSeconds']);
});

test('secrets are never exposed and blank keeps the stored one', () => {
  saveConfig({ sources: [{ name: 'plex', kind: 'plex', url: 'http://plex:32400', key: S.token }], arrs: [{ name: 's', kind: 'sonarr', url: 'http://s:8989/', key: S.key }] });
  saveConfig({ sources: [{ name: 'plex', kind: 'plex', url: 'http://plex:32400', key: '' }], arrs: [{ name: 's', kind: 'sonarr', url: 'http://s:8989', key: '' }] });
  assert.equal(getConfig().sources[0].key, S.token);
  assert.equal(publicConfig().sources[0].keySet, true);
  assert.equal(getConfig().arrs[0].key, S.key);
  assert.ok(!JSON.stringify(publicConfig()).includes(S.token) && !JSON.stringify(publicConfig()).includes(S.key));
  assert.equal(publicConfig().arrs[0].keySet, true);
});

test('invalid instances are rejected', () => {
  assert.throws(() => saveConfig({ arrs: [{ name: 'x', kind: 'bazarr', url: 'http://x' }] }), /invalid instance/);
});

// --- multiple qBittorrent / SABnzbd instances, against fake servers ---
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s)); });
const hits = [];
const fakeQbit = (id, password) => listen(async (req, res) => {
  let body = ''; for await (const d of req) body += d;
  if (req.url === '/api/v2/auth/login') {
    if (new URLSearchParams(body).get('password') !== password) return res.end('Fails.');
    res.setHeader('set-cookie', 'SID=x; path=/'); return res.end('Ok.');
  }
  if (req.url === '/api/v2/torrents/topPrio' && req.headers.cookie === 'SID=x') { hits.push([id, new URLSearchParams(body).get('hashes')]); return res.end(); }
  res.writeHead(403).end();
});
const fakeSab = (id, key) => listen((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.searchParams.get('apikey') !== key) return res.writeHead(403).end();
  hits.push([id, u.searchParams.get('value')]); res.end('{"status":true}');
});
const servers = await Promise.all([fakeQbit('qbA', S.pwA), fakeQbit('qbB', S.pwB), fakeSab('sabA', S.keyA), fakeSab('sabB', S.keyB)]);
const [pA, pB, sA, sB] = servers.map((s) => s.address().port);
const mkClient = (name, impl, port) => ({ name, implementation: impl, fields: [
  { name: 'host', value: '127.0.0.1' }, { name: 'port', value: port }, { name: 'useSsl', value: false },
  { name: 'username', value: 'admin' }, { name: 'password', value: '********' }, { name: 'apiKey', value: '********' }] });
const queue = [
  { episodeId: 1, downloadClient: 'qbA', downloadId: 'AAAA', title: 'one' }, { episodeId: 2, downloadClient: 'qbB', downloadId: 'BBBB', title: 'two' },
  { episodeId: 3, downloadClient: 'sabA', downloadId: 'nzo_a', title: 'three' }, { episodeId: 4, downloadClient: 'sabB', downloadId: 'nzo_b', title: 'four' },
];
const fakeArr = await listen((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/api/v3/queue')) return res.end(JSON.stringify({ records: queue }));
  if (req.url === '/api/v3/downloadclient') return res.end(JSON.stringify([
    mkClient('qbA', 'QBittorrent', pA), mkClient('qbB', 'QBittorrent', pB), mkClient('sabA', 'Sabnzbd', sA), mkClient('sabB', 'Sabnzbd', sB)]));
  res.writeHead(404).end();
});
const arrCfg = { name: 'fake', url: `http://127.0.0.1:${fakeArr.address().port}`, key: 'k' };
const base = { clients: [] };
const cfg = { ...base, clients: [
  { name: 'qb-a', kind: 'qbittorrent', url: `http://127.0.0.1:${pA}`, username: 'admin', password: S.pwA, apiKey: '' },
  { name: 'qb-b', kind: 'qbittorrent', url: `http://127.0.0.1:${pB}/`, username: 'admin', password: S.pwB, apiKey: '' },
  { name: 'sabA', kind: 'sabnzbd', url: `http://127.0.0.1:${sA}`, username: '', password: '', apiKey: S.keyA },
  { name: 'sab-b', kind: 'sabnzbd', url: `http://127.0.0.1:${sB}`, username: '', password: '', apiKey: S.keyB },
] };

test('each download goes to its own qBittorrent / SABnzbd, matched by host:port or name', async () => {
  for (const id of [1, 2, 3, 4]) await prioritize(cfg, arrCfg, (r) => r.episodeId === id, 't', 0);
  assert.deepEqual(hits, [['qbA', 'aaaa'], ['qbB', 'bbbb'], ['sabA', 'nzo_a'], ['sabB', 'nzo_b']]);
});

test('falls back to the default client, and reports hidden secrets clearly', async () => {
  hits.length = 0;
  await prioritize({ clients: [{ name: 'qbittorrent', kind: 'qbittorrent', url: '', username: 'admin', password: S.pwA, apiKey: '', default: true }] }, arrCfg, (r) => r.episodeId === 1, 't', 0);
  assert.deepEqual(hits, [['qbA', 'aaaa']]);
  await assert.rejects(prioritize(base, arrCfg, (r) => r.episodeId === 2, 't', 0), /hidden by the arr/);
  await assert.rejects(prioritize({ ...cfg, clients: [{ ...cfg.clients[1], password: S.wrong }] }, arrCfg, (r) => r.episodeId === 2, 't', 0), /login failed/);
});

test('clientFor ignores clients of another kind or host', () => {
  const f = { host: '127.0.0.1', port: pA };
  assert.equal(clientFor(cfg, 'Sabnzbd', f, 'x').name, 'none');
  assert.equal(clientFor(cfg, 'QBittorrent', f, 'x').name, 'qb-a');
  assert.equal(clientFor(cfg, 'Deluge', f, 'x'), undefined);
});

test('download client secrets are masked and kept when blank', () => {
  saveConfig({ clients: [{ name: 'q', kind: 'qbittorrent', url: 'http://q:8080', username: 'u', password: S.kept, apiKey: '' }] });
  saveConfig({ clients: [{ name: 'q', kind: 'qbittorrent', url: 'http://q:8080/', username: 'u', password: '', apiKey: '' }] });
  assert.equal(getConfig().clients[0].password, S.kept);
  assert.ok(!JSON.stringify(publicConfig()).includes(S.kept));
  assert.equal(publicConfig().clients[0].passwordSet, true);
  assert.throws(() => saveConfig({ clients: [{ name: 'x', kind: 'deluge', url: 'http://x' }] }), /invalid download client/);
});

test('web server: auth, CSRF and size limits', async () => {
  process.env.UI_PASSWORD = S.ui; process.env.UI_PORT = '0';
  const srv = serve(); await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const basic = (p, u = 'admin') => ({ authorization: 'Basic ' + Buffer.from(u + ':' + p).toString('base64') });
  const post = (headers, body) => fetch(url + '/api/config', { method: 'POST', headers, body });
  try {
    assert.equal((await fetch(url + '/api/state')).status, 401);
    assert.equal((await fetch(url + '/api/state', { headers: basic(S.wrong) })).status, 401);
    const ok = await fetch(url + '/api/state', { headers: basic(S.ui) });
    assert.equal(ok.status, 200);
    const okState = await ok.json();
    assert.equal(okState.version, VERSION);
    assert.equal(okState.authEnabled, true);
    assert.equal(ok.headers.get('x-frame-options'), 'DENY');
    assert.match(ok.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    // a cross-site form/fetch can send text/plain without a preflight: must be refused
    assert.equal((await post({ ...basic(S.ui), 'content-type': 'text/plain' }, '{"maxPerDay":1}')).status, 415);
    assert.equal((await post({ ...basic(S.ui), 'content-type': 'application/json', origin: 'https://evil.example' }, '{"maxPerDay":1}')).status, 403);
    assert.equal((await post({ ...basic(S.ui), 'content-type': 'application/json' }, '{"maxPerDay":7}')).status, 200);
    assert.equal(getConfig().maxPerDay, 7);
    const hist = (h) => fetch(url + '/api/historic', { method: 'POST', headers: { ...basic(S.ui), ...h }, body: '{}' });
    assert.equal((await hist({ 'content-type': 'text/plain' })).status, 415);
    assert.equal((await hist({ 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(url + '/api/historic', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await hist({ 'content-type': 'application/json' })).status, 202);
    assert.equal((await post({ ...basic(S.ui), 'content-type': 'application/json' }, 'x'.repeat(1_100_000))).status, 400);
  } finally { srv.close(); }

  // with UI_USERNAME set, both the username and the password must match
  process.env.UI_USERNAME = 'reporter-' + S.token.slice(0, 4);
  const srv2 = serve(); await new Promise((r) => srv2.once('listening', r));
  const url2 = `http://127.0.0.1:${srv2.address().port}/api/state`;
  try {
    assert.equal((await fetch(url2, { headers: basic(S.ui, process.env.UI_USERNAME) })).status, 200);
    assert.equal((await fetch(url2, { headers: basic(S.ui, 'admin') })).status, 401);
    assert.equal((await fetch(url2, { headers: basic(S.wrong, process.env.UI_USERNAME) })).status, 401);
    assert.equal((await fetch(url2)).status, 401);
  } finally { srv2.close(); delete process.env.UI_PASSWORD; delete process.env.UI_USERNAME; }
});

test('historic reports are those seen but never acted on', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'new' }];
  const changes = [{ reportId: 'b', status: 'replaced' }, { status: 'info' }];
  assert.deepEqual(pendingHistoric(nodes, ['a', 'b', 'c'], changes).map((n) => n.id), ['a', 'c']);
  assert.deepEqual(pendingHistoric(nodes, ['a', 'b', 'c'], [{ reportId: 'a' }, { reportId: 'b' }, { reportId: 'c' }]), []);
});

test('version is shortened for commit hashes and defaults to dev', async () => {
  assert.equal(VERSION, 'dev'); // APP_VERSION is not set when running the tests
  const run = (v) => new Promise((res) => import('node:child_process').then(({ execFile }) =>
    execFile(process.execPath, ['-e', "import('./app.mjs').then((m) => console.log(m.VERSION))"], { env: { ...process.env, APP_VERSION: v }, cwd: path.dirname(new URL(import.meta.url).pathname) }, (e, out) => res(out.trim()))));
  assert.equal(await run('0123456789abcdef0123456789abcdef01234567'), '0123456');
  assert.equal(await run('v1.2.3'), 'v1.2.3');
});

test('without UI_PASSWORD there is no login: the page just loads', async () => {
  for (const env of [{}, { UI_USERNAME: '', UI_PASSWORD: '' }, { UI_USERNAME: 'admin' }]) { // a username alone does not switch auth on
    delete process.env.UI_PASSWORD; delete process.env.UI_USERNAME; Object.assign(process.env, env); process.env.UI_PORT = '0';
    const srv = serve(); await new Promise((r) => srv.once('listening', r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    try {
      const page = await fetch(url + '/');
      assert.equal(page.status, 200, JSON.stringify(env));
      assert.equal(page.headers.get('www-authenticate'), null);
      const state = await (await fetch(url + '/api/state')).json();
      assert.equal(state.authEnabled, false);
    } finally { srv.close(); delete process.env.UI_USERNAME; }
  }
  process.env.UI_PASSWORD = S.ui; process.env.UI_PORT = '0';
  const srv = serve(); await new Promise((r) => srv.once('listening', r));
  try { assert.equal((await fetch(`http://127.0.0.1:${srv.address().port}/`)).status, 401); } finally { srv.close(); delete process.env.UI_PASSWORD; }
});

test('works under any reverse proxy path prefix, and accepts the browser origin a proxy forwards', async () => {
  process.env.UI_PASSWORD = S.ui; process.env.UI_PORT = '0';
  const srv = serve(); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const auth = { authorization: 'Basic ' + Buffer.from('admin:' + S.ui).toString('base64') };
  const post = (p, h) => fetch(base + p, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...h }, body: '{"maxPerDay":9}' });
  try {
    // the prefix may or may not be stripped by the proxy: both reach the same handlers
    for (const p of ['/api/state', '/reportarr/api/state', '/media/reportarr/api/state']) assert.equal((await fetch(base + p, { headers: auth })).status, 200, p);
    assert.match((await fetch(base + '/reportarr', { headers: auth })).headers.get('content-type'), /text\/html/);
    assert.match((await fetch(base + '/reportarr/', { headers: auth })).headers.get('content-type'), /text\/html/);
    assert.match((await fetch(base + '/reportarr/api/stateX', { headers: auth })).headers.get('content-type'), /text\/html/); // only exact API routes
    assert.equal((await fetch(base + '/reportarr/api/env')).status, 401); // auth still applies under a prefix
    assert.equal((await post('/reportarr/api/config', {})).status, 200);
    // the proxy talks to us as 127.0.0.1 but the browser's Origin is the public host
    const pub = { origin: 'https://media.example.com' };
    assert.equal((await post('/reportarr/api/config', pub)).status, 403, 'unknown origin refused');
    assert.equal((await post('/reportarr/api/config', { ...pub, 'x-forwarded-host': 'media.example.com' })).status, 200);
    assert.equal((await post('/reportarr/api/config', { ...pub, 'x-forwarded-host': 'evil.example' })).status, 403);
  } finally { srv.close(); delete process.env.UI_PASSWORD; }
});

test('BASE_URL: parsing, redirect to the trailing slash, injected into the page, and its host may save', async () => {
  assert.deepEqual(parseBase('/reportarr'), { prefix: '/reportarr', host: '' });
  assert.deepEqual(parseBase('reportarr/'), { prefix: '/reportarr', host: '' });
  assert.deepEqual(parseBase('https://media.example.com/apps/reportarr/'), { prefix: '/apps/reportarr', host: 'media.example.com' });
  assert.deepEqual(parseBase('https://media.example.com'), { prefix: '', host: 'media.example.com' });
  assert.deepEqual(parseBase('/'), { prefix: '', host: '' });
  assert.deepEqual(parseBase(''), { prefix: '', host: '' });
  assert.deepEqual(parseBase('/a";alert(1)//'), { prefix: '', host: '' }); // never let it into the page's script

  process.env.BASE_URL = 'https://media.example.com/reportarr'; process.env.UI_PORT = '0'; delete process.env.UI_PASSWORD;
  const srv = serve(); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, h) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: '{"maxPerDay":9}' });
  try {
    const r = await fetch(base + '/reportarr?x=1', { redirect: 'manual' });
    assert.equal(r.status, 308); assert.equal(r.headers.get('location'), '/reportarr/?x=1');
    assert.match(await (await fetch(base + '/reportarr/')).text(), /const BASE = "\/reportarr\/" \|\|/);
    assert.equal((await fetch(base + '/reportarr/api/state')).status, 200);
    assert.equal((await fetch(base + '/api/state')).status, 200); // a proxy that strips the prefix still works
    assert.equal((await post('/reportarr/api/config', { origin: 'https://media.example.com' })).status, 200);
    assert.equal((await post('/reportarr/api/config', { origin: 'https://evil.example' })).status, 403);
  } finally { srv.close(); delete process.env.BASE_URL; }
  const srv2 = serve(); await new Promise((r) => srv2.once('listening', r)); // unset: placeholder is replaced by an empty string, so the page auto-detects
  try { assert.match(await (await fetch(`http://127.0.0.1:${srv2.address().port}/`)).text(), /const BASE = "" \|\|/); } finally { srv2.close(); }
});

test('the page builds its API URLs from where it is served', () => {
  const html = fs.readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
  assert.ok(!/['"`]\/api\//.test(html), 'no absolute /api/ paths');
  assert.match(html, /location\.pathname\.endsWith\('\/'\)/);
});

test('config file is private and the UI sends JSON', () => {
  assert.equal(fs.statSync(path.join(process.env.DATA_DIR, 'config.json')).mode & 0o077, 0);
  assert.match(fs.readFileSync(new URL('./ui.html', import.meta.url), 'utf8'), /'Content-Type': 'application\/json'/);
});

test.after(() => { for (const s of [...servers, fakeArr]) s.close(); });
