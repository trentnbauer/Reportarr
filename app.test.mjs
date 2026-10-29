import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-'));
process.env.POLL_SECONDS = '30'; // env-locked key
const { ratingKeyOf, idsOf, clientFor, prioritize } = await import('./app.mjs');
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
  saveConfig({ plexToken: 'T0KEN', arrs: [{ name: 's', kind: 'sonarr', url: 'http://s:8989/', key: 'KEY' }] });
  saveConfig({ plexToken: '', arrs: [{ name: 's', kind: 'sonarr', url: 'http://s:8989', key: '' }] });
  assert.equal(getConfig().plexToken, 'T0KEN');
  assert.equal(getConfig().arrs[0].key, 'KEY');
  assert.ok(!JSON.stringify(publicConfig()).includes('T0KEN') && !JSON.stringify(publicConfig()).includes('KEY'));
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
const servers = await Promise.all([fakeQbit('qbA', 'pwA'), fakeQbit('qbB', 'pwB'), fakeSab('sabA', 'keyA'), fakeSab('sabB', 'keyB')]);
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
  { name: 'qb-a', kind: 'qbittorrent', url: `http://127.0.0.1:${pA}`, username: 'admin', password: 'pwA', apiKey: '' },
  { name: 'qb-b', kind: 'qbittorrent', url: `http://127.0.0.1:${pB}/`, username: 'admin', password: 'pwB', apiKey: '' },
  { name: 'sabA', kind: 'sabnzbd', url: `http://127.0.0.1:${sA}`, username: '', password: '', apiKey: 'keyA' },
  { name: 'sab-b', kind: 'sabnzbd', url: `http://127.0.0.1:${sB}`, username: '', password: '', apiKey: 'keyB' },
] };

test('each download goes to its own qBittorrent / SABnzbd, matched by host:port or name', async () => {
  for (const id of [1, 2, 3, 4]) await prioritize(cfg, arrCfg, (r) => r.episodeId === id, 't', 0);
  assert.deepEqual(hits, [['qbA', 'aaaa'], ['qbB', 'bbbb'], ['sabA', 'nzo_a'], ['sabB', 'nzo_b']]);
});

test('falls back to the default client, and reports hidden secrets clearly', async () => {
  hits.length = 0;
  await prioritize({ ...base, qbitPassword: 'pwA', clients: [] }, arrCfg, (r) => r.episodeId === 1, 't', 0);
  assert.deepEqual(hits, [['qbA', 'aaaa']]);
  await assert.rejects(prioritize(base, arrCfg, (r) => r.episodeId === 2, 't', 0), /hidden by the arr/);
  await assert.rejects(prioritize({ ...cfg, clients: [{ ...cfg.clients[1], password: 'wrong' }] }, arrCfg, (r) => r.episodeId === 2, 't', 0), /login failed/);
});

test('clientFor ignores clients of another kind or host', () => {
  const f = { host: '127.0.0.1', port: pA };
  assert.equal(clientFor(cfg, 'Sabnzbd', f, 'x').name, 'default');
  assert.equal(clientFor(cfg, 'QBittorrent', f, 'x').name, 'qb-a');
  assert.equal(clientFor(cfg, 'Deluge', f, 'x'), undefined);
});

test('download client secrets are masked and kept when blank', () => {
  saveConfig({ clients: [{ name: 'q', kind: 'qbittorrent', url: 'http://q:8080', username: 'u', password: 'PW123', apiKey: '' }] });
  saveConfig({ clients: [{ name: 'q', kind: 'qbittorrent', url: 'http://q:8080/', username: 'u', password: '', apiKey: '' }] });
  assert.equal(getConfig().clients[0].password, 'PW123');
  assert.ok(!JSON.stringify(publicConfig()).includes('PW123'));
  assert.equal(publicConfig().clients[0].passwordSet, true);
  assert.throws(() => saveConfig({ clients: [{ name: 'x', kind: 'deluge', url: 'http://x' }] }), /invalid download client/);
});

test.after(() => { for (const s of [...servers, fakeArr]) s.close(); });
