import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

// What an installation looks like after running an older version: old-style settings (single Plex, Overseerr, default
// qBittorrent) and a state file that has already seen reports. Upgrading must neither re-baseline nor re-action any of it.
const rnd = () => randomBytes(8).toString('hex');
const tok = rnd(), seerrKey = rnd();
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-upgrade-'));
process.env.DATA_DIR = data;
const listen = (h) => new Promise((res) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => res(s)); });
const json = (res, v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
const rep = (id) => ({ id, date: '2026-10-01', url: 'server://machine-x/com.plexapp.plugins.library/library/metadata/9' });
let nodes = [rep('seen-1'), rep('seen-2')];
const community = await listen(async (q, s) => { for await (const _ of q); json(s, { data: { reports: { nodes } } }); });
process.env.PLEX_COMMUNITY_URL = `http://127.0.0.1:${community.address().port}`;
const plex = await listen((q, s) => (q.url === '/identity' ? json(s, { MediaContainer: { machineIdentifier: 'machine-x' } })
  : q.url.startsWith('/library/metadata/') ? json(s, { MediaContainer: { Metadata: [{ type: 'movie', title: 'Old Film', Guid: [{ id: 'tmdb://5' }], Media: [{ Part: [{ file: '/m/Old.mkv' }] }] }] } }) : s.writeHead(404).end()));
const seerr = await listen((q, s) => (q.headers['x-api-key'] === seerrKey ? json(s, { results: [] }) : s.writeHead(403).end()));
const radarr = await listen((q, s) => { const u = new URL(q.url, 'http://x'); json(s, u.pathname === '/api/v3/movie' ? [{ id: 5, title: 'Old Film', hasFile: true, movieFile: { id: 7, path: '/movies/Old.mkv' } }] : u.pathname === '/api/v3/queue' ? { records: [] } : []); });

// the files an older version left behind
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
  plexUrl: `http://127.0.0.1:${plex.address().port}`, plexToken: tok, overseerrUrl: `http://127.0.0.1:${seerr.address().port}`, overseerrKey: seerrKey, overseerrTypes: 'video', overseerrResolve: true,
  qbitUrl: 'http://qb:8080', qbitUsername: 'admin', qbitPassword: rnd(), dryRun: true, maxPerDay: 48,
  arrs: [{ name: 'radarr', kind: 'radarr', url: `http://127.0.0.1:${radarr.address().port}`, key: 'k' }],
}));
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ seen: ['seen-1', 'seen-2'], day: new Date().toISOString().slice(0, 10), count: 4, sources: ['plex', 'overseerr'] }));
fs.writeFileSync(path.join(data, 'changes.json'), JSON.stringify([{ time: '2026-10-28T00:00:00Z', status: 'replaced', reportId: 'seen-1', title: 'Old Film', detail: 'x' }]));

const { poll } = await import('../src/engine.mjs');
const { getConfig, publicConfig } = await import('../src/config.mjs');
const changes = () => JSON.parse(fs.readFileSync(path.join(data, 'changes.json'), 'utf8'));

test('old-style settings are read as sources and a default client', () => {
  const c = getConfig();
  assert.deepEqual(c.sources.map((s) => [s.name, s.kind]), [['plex', 'plex'], ['overseerr', 'seerr']]); // the names the old state file already knows
  assert.deepEqual(c.clients.map((x) => [x.name, x.default]), [['qbittorrent', true]]);
  assert.ok(!JSON.stringify(publicConfig()).includes(tok));
});

test('upgrading does not re-baseline, and does not touch reports it had already seen', async () => {
  const before = changes().length;
  await poll();
  assert.equal(changes().length, before, 'no baseline entries, no actions: nothing new happened');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).sources, ['plex', 'overseerr']);
});

test('a report that arrives after the upgrade is handled normally', async () => {
  nodes = [...nodes, rep('after-upgrade')];
  await poll();
  const last = changes().at(-1);
  assert.deepEqual([last.status, last.reportId, last.source, last.instance], ['dry-run', 'after-upgrade', 'Plex report', 'radarr']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).count, 5);
});

test.after(() => { for (const s of [community, plex, seerr, radarr]) s.close(); });
