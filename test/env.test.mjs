import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const rnd = () => randomBytes(8).toString('hex'); // generated per run so the repo holds no secret-looking literals
const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'); // the repository root

// Load config.mjs in a clean process with exactly these variables, like the container sees them.
const loadConfig = (env) => JSON.parse(execFileSync(process.execPath, ['-e',
  "import('./src/config.mjs').then((m) => console.log(JSON.stringify({ c: m.getConfig(), locked: m.lockedKeys() })))"],
{ cwd: dir, env: { PATH: process.env.PATH, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-env-')), ...env } }).toString());

// A small dotenv parser, as docker compose reads .env files: raw, 'literal' and "escaped" values.
const parseDotenv = (text) => Object.fromEntries(text.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => {
  const i = l.indexOf('='); let v = l.slice(i + 1);
  if (v.startsWith("'")) v = v.slice(1, v.lastIndexOf("'"));
  else if (v.startsWith('"')) v = v.slice(1, v.lastIndexOf('"')).replace(/\\(.)/g, '$1');
  return [l.slice(0, i), v];
}));

test('numbered SONARR_N / RADARR_N variables go up as far as you like, in numeric order', () => {
  const k = { a: rnd(), b: rnd(), c: rnd(), d: rnd() };
  const { c, locked } = loadConfig({
    SONARR_1_URL: 'http://s1:8989/', SONARR_1_KEY: k.a,
    SONARR_10_URL: 'http://s10:8989', SONARR_10_KEY: k.b, SONARR_10_NAME: 'sonarr-4k',
    SONARR_2_URL: 'http://s2:8989', SONARR_2_KEY: k.c,
    RADARR_1_URL: 'http://r1:7878', RADARR_1_KEY: k.d, RADARR_3_URL: '', RADARR_3_KEY: 'ignored-without-url',
    LIDARR_1_URL: 'http://l1:8686/lidarr/', LIDARR_1_KEY: k.a, LIDARR_2_URL: 'http://l2:8686', LIDARR_2_KEY: k.b, LIDARR_2_NAME: 'flac-music',
  });
  assert.deepEqual(c.arrs.map((a) => [a.name, a.kind, a.url]), [
    ['sonarr-1', 'sonarr', 'http://s1:8989'], ['sonarr-2', 'sonarr', 'http://s2:8989'], ['sonarr-4k', 'sonarr', 'http://s10:8989'], ['radarr-1', 'radarr', 'http://r1:7878'],
    ['lidarr-1', 'lidarr', 'http://l1:8686/lidarr'], ['flac-music', 'lidarr', 'http://l2:8686']]);
  assert.equal(c.arrs[2].key, k.b);
  assert.ok(!locked.includes('arrs'), 'the list is merged, not locked');
});

test('unnumbered SONARR_URL and the older ARRS JSON keep working next to numbered ones', () => {
  const { c } = loadConfig({
    ARRS: JSON.stringify([{ name: 'old', kind: 'radarr', url: 'http://old:7878', key: 'k' }]),
    SONARR_URL: 'http://plain:8989', SONARR_KEY: 'k', RADARR_1_URL: 'http://r1:7878', RADARR_1_KEY: 'k' });
  assert.deepEqual(c.arrs.map((a) => a.name), ['old', 'sonarr', 'radarr-1']);
});

const srcs = (c) => c.sources.map((s) => [s.name, s.kind, s.url]);

test('any number of Plex servers and Overseerr/Seerr instances, from numbered variables', () => {
  const k = { a: rnd(), b: rnd(), c: rnd(), d: rnd() };
  const { c, locked } = loadConfig({
    PLEX_URL: 'http://plex:32400/', PLEX_KEY: k.a,                                  // the original single-server form
    PLEX_2_URL: 'http://10.0.0.20:32400', PLEX_2_KEY: k.b, PLEX_2_NAME: 'family',
    PLEX_10_URL: 'http://plex10:32400', PLEX_10_KEY: k.c,                           // 10 sorts after 2
    OVERSEERR_URL: 'http://seerr:5055', OVERSEERR_KEY: k.d, OVERSEERR_ISSUE_TYPES: 'video, AUDIO,bogus', OVERSEERR_RESOLVE: 'false',
    OVERSEERR_2_URL: 'http://seerr2:5055', OVERSEERR_2_KEY: k.a, OVERSEERR_2_NAME: 'seerr-4k',
  });
  assert.deepEqual(srcs(c), [['plex', 'plex', 'http://plex:32400'], ['family', 'plex', 'http://10.0.0.20:32400'], ['plex-10', 'plex', 'http://plex10:32400'],
    ['overseerr', 'seerr', 'http://seerr:5055'], ['seerr-4k', 'seerr', 'http://seerr2:5055']]);
  assert.deepEqual([c.sources[3].issueTypes, c.sources[3].resolve, c.sources[4].issueTypes, c.sources[4].resolve], ['video,audio', false, 'video,audio,other', true]);
  assert.equal(c.sources[1].key, k.b);
  assert.ok(!locked.includes('sources'));
});

test('PLEX_TOKEN still works, a Plex URL without a token is not a source, and blank variables lock nothing', () => {
  const t = rnd();
  assert.deepEqual(srcs(loadConfig({ PLEX_TOKEN: t }).c), [['plex', 'plex', 'http://plex:32400']]);
  assert.equal(loadConfig({ PLEX_TOKEN: t }).c.sources[0].key, t);
  assert.deepEqual(loadConfig({ PLEX_URL: 'http://plex:32400' }).c.sources, []); // the compose default alone is not a configured server
  const none = loadConfig({ PLEX_KEY: '', PLEX_2_URL: '', SONARR_1_URL: '', OVERSEERR_KEY: '', OVERSEERR_URL: '' });
  assert.deepEqual([none.locked, none.c.sources], [[], []]);
  assert.equal(loadConfig({ OVERSEERR_URL: 'http://s:5055', OVERSEERR_API_KEY: t }).c.sources[0].key, t);
});

test('the old single QBIT_* and SAB_* settings become read-only default download clients', () => {
  const k = { q: rnd(), s: rnd() };
  const r = loadConfig({ QBIT_URL: 'http://qb:8080/', QBIT_USERNAME: 'admin', QBIT_PASSWORD: k.q, SAB_URL: '', SAB_API_KEY: k.s,
    CLIENTS: JSON.stringify([{ name: 'qb2', kind: 'qbittorrent', url: 'http://qb2:8080', username: 'u', password: 'p', apiKey: '' }]) });
  assert.deepEqual(r.c.clients.map((x) => [x.name, x.kind, x.url, !!x.default]), [['qb2', 'qbittorrent', 'http://qb2:8080', false], ['qbittorrent', 'qbittorrent', 'http://qb:8080', true], ['sabnzbd', 'sabnzbd', '', true]]);
  assert.deepEqual(loadConfig({}).c.clients, []);
});

test('settings saved by an older version are read as sources and clients, and rewritten without the old keys', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-legacy-'));
  const k = { p: rnd(), o: rnd(), q: rnd() };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ plexUrl: 'http://plex:32400', plexToken: k.p, overseerrUrl: 'http://seerr:5055', overseerrKey: k.o, overseerrTypes: 'video', overseerrResolve: false,
    qbitUrl: 'http://qb:8080', qbitUsername: 'admin', qbitPassword: k.q, maxPerDay: 9, arrs: [{ name: 's', kind: 'sonarr', url: 'http://s:8989', key: 'k' }] }));
  const r = inProcess({ DATA_DIR: data }, `
    const c = m.getConfig(); const before = { sources: c.sources.map((s) => [s.name, s.kind, s.key === ${JSON.stringify(k.p)} || s.key === ${JSON.stringify(k.o)}, s.issueTypes, s.resolve]), clients: c.clients.map((x) => [x.name, !!x.default, x.password === ${JSON.stringify(k.q)}]), max: c.maxPerDay };
    m.saveConfig({ maxPerDay: 12 });
    return { before, file: JSON.parse(await (await import('node:fs/promises')).readFile(${JSON.stringify(path.join(data, 'config.json'))}, 'utf8')) };`);
  assert.deepEqual(r.before.sources, [['plex', 'plex', true, null, null], ['overseerr', 'seerr', true, 'video', false]]);
  assert.deepEqual(r.before.clients, [['qbittorrent', true, true]]);
  assert.equal(r.before.max, 9);
  assert.deepEqual(Object.keys(r.file).filter((x) => /^(plex|overseerr|qbit|sab)/.test(x)), [], 'old keys are gone after a save');
  assert.equal(r.file.maxPerDay, 12);
  assert.deepEqual(r.file.sources.map((s) => s.name), ['plex', 'overseerr']);
});

test('the exported .env reproduces the same settings, including awkward characters', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-export-'));
  const { saveConfig, getConfig, envFile } = await import('../src/config.mjs');
  const awkward = `p a#ss$word'"x\\${rnd()}`;
  saveConfig({
    dryRun: false, maxPerDay: 7, pollSeconds: 90,
    sources: [
      { name: 'plex', kind: 'plex', url: 'http://plex:32400', key: awkward }, { name: 'family room', kind: 'plex', url: 'http://10.0.0.20:32400', key: rnd() },
      { name: 'overseerr', kind: 'seerr', url: 'http://seerr:5055', key: rnd(), issueTypes: 'video,audio', resolve: false }, { name: 'seerr-2', kind: 'seerr', url: 'http://seerr2:5055', key: rnd(), issueTypes: 'other', resolve: true },
    ],
    arrs: [{ name: 'tv one', kind: 'sonarr', url: 'http://s1:8989/sonarr', key: rnd() }, { name: 'tv two', kind: 'sonarr', url: 'http://s2:8989', key: rnd() }, { name: 'films', kind: 'radarr', url: 'http://r:7878', key: rnd() }, { name: 'my music', kind: 'lidarr', url: 'http://l:8686/lidarr', key: rnd() }],
    clients: [{ name: 'q1', kind: 'qbittorrent', url: 'http://q1:8080', username: 'u', password: awkward, apiKey: '' }, { name: 'sabnzbd', kind: 'sabnzbd', url: '', username: '', password: '', apiKey: rnd(), default: true }],
  });
  const original = getConfig();
  const text = envFile(original);
  assert.match(text, /PLEX_1_NAME=plex\nPLEX_1_URL=.*\nPLEX_1_KEY=/);
  assert.match(text, /PLEX_2_NAME='family room'/);
  assert.match(text, /OVERSEERR_2_NAME=seerr-2/);
  const { c } = loadConfig(parseDotenv(text));
  for (const k of ['dryRun', 'maxPerDay', 'pollSeconds', 'sources', 'arrs', 'clients']) assert.deepEqual(c[k], original[k], k);
});

test('the .env download needs the web UI password and carries the saved settings', async () => {
  const pass = rnd(), token = rnd();
  process.env.UI_PASSWORD = pass; process.env.UI_PORT = '0';
  const { saveConfig } = await import('../src/config.mjs');
  const { serve } = await import('../src/server.mjs');
  saveConfig({ sources: [{ name: 'plex', kind: 'plex', url: 'http://plex:32400', key: token }] });
  const srv = serve(); await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/env`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const ok = await fetch(url, { headers: { authorization: 'Basic ' + Buffer.from('x:' + pass).toString('base64') } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-disposition'), /attachment; filename="reportarr\.env"/);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.match(await ok.text(), new RegExp(`PLEX_1_KEY=${token}`));
  } finally { srv.close(); }
});

// Run code in a clean process that has these environment variables, sharing one data directory across calls.
const inProcess = (env, code) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `import * as m from './src/config.mjs'; const out = await (async () => { ${code} })(); console.log(JSON.stringify(out));`],
{ cwd: dir, env: { PATH: process.env.PATH, ...env } }).toString());

test('instances from the environment and instances added in the UI work together', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-mix-'));
  const k = { env: rnd(), ui: rnd(), ui2: rnd() };
  const env = { DATA_DIR: data, SONARR_1_URL: 'http://s1:8989', SONARR_1_KEY: k.env, SONARR_1_NAME: 'tv' };
  const add = (extra) => inProcess(env, `m.saveConfig({ arrs: ${JSON.stringify(extra)} }); const c = m.getConfig(); return { arrs: c.arrs.map((a) => [a.name, a.kind, a.url, a.key === ${JSON.stringify(k.env)} ? 'env-key' : a.key === ${JSON.stringify(k.ui)} ? 'ui-key' : a.key]), locked: m.lockedKeys() };`);

  const r1 = add([{ name: 'radarr-2', kind: 'radarr', url: 'http://r2:7878/', key: k.ui }, { name: 'music', kind: 'lidarr', url: 'http://l:8686', key: k.ui2 }]);
  assert.deepEqual(r1.arrs.map((a) => a.slice(0, 3)), [['tv', 'sonarr', 'http://s1:8989'], ['radarr-2', 'radarr', 'http://r2:7878'], ['music', 'lidarr', 'http://l:8686']]);
  assert.ok(!r1.locked.includes('arrs'));

  // the UI sends a blank key for rows it already has: the stored one is kept, and the environment's row is never written to the file
  const r2 = add([{ name: 'radarr-2', kind: 'radarr', url: 'http://r2:7878', key: '' }]);
  assert.deepEqual(r2.arrs.map((a) => a[0]), ['tv', 'radarr-2']);
  assert.equal(r2.arrs[1][3], 'ui-key');
  const file = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
  assert.deepEqual(file.arrs.map((a) => a.name), ['radarr-2']);
  assert.ok(!JSON.stringify(file).includes(k.env), 'environment secrets are not copied into config.json');

  // what the UI is told: which rows are read-only
  const pub = inProcess(env, 'return m.publicConfig().arrs.map((a) => [a.name, a.fromEnv, a.keySet, "key" in a]);');
  assert.deepEqual(pub, [['tv', true, true, false], ['radarr-2', false, true, false]]);

  // a name already taken by an environment instance (or used twice) is refused, with a reason
  assert.throws(() => add([{ name: 'tv', kind: 'sonarr', url: 'http://x', key: 'k' }]), /already used by one set in the environment/);
  assert.throws(() => add([{ name: 'a', kind: 'radarr', url: 'http://x', key: 'k' }, { name: 'a', kind: 'radarr', url: 'http://y', key: 'k' }]), /already used/);

  // removing the UI-added ones leaves the environment's alone
  assert.deepEqual(add([]).arrs.map((a) => a[0]), ['tv']);

  // the .env export numbers both kinds together
  add([{ name: 'radarr-2', kind: 'radarr', url: 'http://r2:7878', key: k.ui }, { name: 'tv4k', kind: 'sonarr', url: 'http://s2:8989', key: k.ui2 }]);
  const exported = inProcess(env, 'return m.envFile();');
  assert.match(exported, /SONARR_1_NAME=tv\nSONARR_1_URL=http:\/\/s1:8989/);
  assert.match(exported, /SONARR_2_NAME=tv4k/);
  assert.match(exported, /RADARR_1_NAME=radarr-2/);
});

test('download clients mix the same way', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-mixc-'));
  const env = { DATA_DIR: data, CLIENTS: JSON.stringify([{ name: 'qb1', kind: 'qbittorrent', url: 'http://q1:8080', username: 'u', password: rnd(), apiKey: '' }]) };
  const r = inProcess(env, `m.saveConfig({ clients: [{ name: 'sab', kind: 'sabnzbd', url: 'http://s:8080', apiKey: ${JSON.stringify(rnd())} }] }); return { names: m.getConfig().clients.map((x) => x.name), pub: m.publicConfig().clients.map((x) => [x.name, x.fromEnv]) };`);
  assert.deepEqual(r.names, ['qb1', 'sab']);
  assert.deepEqual(r.pub, [['qb1', true], ['sab', false]]);
});

test('the no-login warning can be hidden: a setting in the UI, or HIDE_LOGIN_WARNING in the environment', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-warn-'));
  // from the UI: off by default, saved, exported
  const r = inProcess({ DATA_DIR: data }, `const before = m.getConfig().hideLoginWarning; m.saveConfig({ hideLoginWarning: true }); return { before, after: m.getConfig().hideLoginWarning, pub: m.publicConfig().hideLoginWarning, locked: m.lockedKeys(), env: /HIDE_LOGIN_WARNING=true/.test(m.envFile()) };`);
  assert.deepEqual(r, { before: false, after: true, pub: true, locked: [], env: true });
  // from the environment: it wins, and the UI cannot undo it
  const e = inProcess({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-warn2-')), HIDE_LOGIN_WARNING: 'true' }, `m.saveConfig({ hideLoginWarning: false }); return { now: m.getConfig().hideLoginWarning, locked: m.lockedKeys() };`);
  assert.deepEqual(e, { now: true, locked: ['hideLoginWarning'] });
  assert.equal(loadConfig({ HIDE_LOGIN_WARNING: 'false' }).c.hideLoginWarning, false);
});
