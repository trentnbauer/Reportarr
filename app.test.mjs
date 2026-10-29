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
const { ratingKeyOf, idsOf, clientFor, prioritize, serve } = await import('./app.mjs');
const { getConfig, publicConfig, saveConfig, lockedKeys } = await import('./config.mjs');

test('ratingKeyOf / idsOf parse Plex references', () => {
  assert.equal(ratingKeyOf('server://abc/com.plexapp.plugins.library/library/metadata/121709'), '121709');
  assert.equal(ratingKeyOf('nonsense'), undefined);
  assert.deepEqual(idsOf([{ id: 'tvdb://190252' }, { id: 'tmdb://178916' }]), { tvdb: '190252', tmdb: '178916' });
});

test('env wins over the UI and is reported as locked', () => {
  saveConfig({ pollSeconds: 5, maxPerDay: 3 });
  assert.equal(getConfig().pollSeconds, 30);
  assert.equal(getConfig().maxPerDay, 3);
  assert.deepEqual(lockedKeys(), ['pollSeconds']);
});

test('secrets are never exposed and blank keeps the stored one', () => {
  saveConfig({ plexToken: S.token, arrs: [{ name: 's', kind: 'sonarr', url: 'http://s:8989/', key: S.key }] });
  saveConfig({ plexToken: '', arrs: [{ name: 's', kind: 'sonarr', url: 'http://s:8989', key: '' }] });
  assert.equal(getConfig().plexToken, S.token);
  assert.equal(getConfig().arrs[0].key, S.key);
  assert.ok(!JSON.stringify(publicConfig()).includes(S.token) && !JSON.stringify(publicConfig()).includes(S.key));
  assert.equal(publicConfig().arrs[0].keySet, true);
});

test('invalid instances are rejected', () => {
  assert.throws(() => saveConfig({ arrs: [{ name: 'x', kind: 'lidarr', url: 'http://x' }] }), /invalid instance/);
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
const base = { clients: [], qbitUrl: '', qbitUsername: '', qbitPassword: '', sabUrl: '', sabApiKey: '' };
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
  await prioritize({ ...base, qbitPassword: S.pwA, clients: [] }, arrCfg, (r) => r.episodeId === 1, 't', 0);
  assert.deepEqual(hits, [['qbA', 'aaaa']]);
  await assert.rejects(prioritize(base, arrCfg, (r) => r.episodeId === 2, 't', 0), /hidden by the arr/);
  await assert.rejects(prioritize({ ...cfg, clients: [{ ...cfg.clients[1], password: S.wrong }] }, arrCfg, (r) => r.episodeId === 2, 't', 0), /login failed/);
});

test('clientFor ignores clients of another kind or host', () => {
  const f = { host: '127.0.0.1', port: pA };
  assert.equal(clientFor(cfg, 'Sabnzbd', f, 'x').name, 'default');
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
    assert.equal(ok.headers.get('x-frame-options'), 'DENY');
    assert.match(ok.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    // a cross-site form/fetch can send text/plain without a preflight: must be refused
    assert.equal((await post({ ...basic(S.ui), 'content-type': 'text/plain' }, '{"maxPerDay":1}')).status, 415);
    assert.equal((await post({ ...basic(S.ui), 'content-type': 'application/json', origin: 'https://evil.example' }, '{"maxPerDay":1}')).status, 403);
    assert.equal((await post({ ...basic(S.ui), 'content-type': 'application/json' }, '{"maxPerDay":7}')).status, 200);
    assert.equal(getConfig().maxPerDay, 7);
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

test('config file is private and the UI sends JSON', () => {
  assert.equal(fs.statSync(path.join(process.env.DATA_DIR, 'config.json')).mode & 0o077, 0);
  assert.match(fs.readFileSync(new URL('./ui.html', import.meta.url), 'utf8'), /'Content-Type': 'application\/json'/);
});

test.after(() => { for (const s of [...servers, fakeArr]) s.close(); });
