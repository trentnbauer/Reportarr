import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const rnd = () => randomBytes(8).toString('hex'); // generated per run so the repo holds no secret-looking literals
const dir = path.dirname(new URL(import.meta.url).pathname);

// Load config.mjs in a clean process with exactly these variables, like the container sees them.
const loadConfig = (env) => JSON.parse(execFileSync(process.execPath, ['-e',
  "import('./config.mjs').then((m) => console.log(JSON.stringify({ c: m.getConfig(), locked: m.lockedKeys() })))"],
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
  assert.ok(locked.includes('arrs'));
});

test('unnumbered SONARR_URL and the older ARRS JSON keep working next to numbered ones', () => {
  const { c } = loadConfig({
    ARRS: JSON.stringify([{ name: 'old', kind: 'radarr', url: 'http://old:7878', key: 'k' }]),
    SONARR_URL: 'http://plain:8989', SONARR_KEY: 'k', RADARR_1_URL: 'http://r1:7878', RADARR_1_KEY: 'k' });
  assert.deepEqual(c.arrs.map((a) => a.name), ['old', 'sonarr', 'radarr-1']);
});

test('PLEX_KEY is the Plex token, PLEX_TOKEN still works, and blank variables lock nothing', () => {
  const t = rnd();
  assert.equal(loadConfig({ PLEX_KEY: t }).c.plexToken, t);
  assert.equal(loadConfig({ PLEX_TOKEN: t }).c.plexToken, t);
  const none = loadConfig({ PLEX_KEY: '', SONARR_1_URL: '', OVERSEERR_KEY: '' });
  assert.deepEqual(none.locked, []);
  assert.equal(loadConfig({ OVERSEERR_API_KEY: t }).c.overseerrKey, t);
});

test('the exported .env reproduces the same settings, including awkward characters', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-export-'));
  const { saveConfig, getConfig, envFile } = await import('./config.mjs');
  const awkward = `p a#ss$word'"x\\${rnd()}`;
  saveConfig({
    plexUrl: 'http://plex:32400', plexToken: awkward, dryRun: false, maxPerDay: 7, pollSeconds: 90,
    overseerrUrl: 'http://seerr:5055', overseerrKey: rnd(), overseerrTypes: 'video,audio', overseerrResolve: false,
    qbitUrl: 'http://qb:8080', qbitUsername: 'admin', qbitPassword: awkward, sabApiKey: rnd(),
    arrs: [{ name: 'tv one', kind: 'sonarr', url: 'http://s1:8989/sonarr', key: rnd() }, { name: 'tv two', kind: 'sonarr', url: 'http://s2:8989', key: rnd() }, { name: 'films', kind: 'radarr', url: 'http://r:7878', key: rnd() }, { name: 'my music', kind: 'lidarr', url: 'http://l:8686/lidarr', key: rnd() }],
    clients: [{ name: 'q1', kind: 'qbittorrent', url: 'http://q1:8080', username: 'u', password: awkward, apiKey: '' }],
  });
  const original = getConfig();
  const text = envFile(original);
  assert.match(text, /SONARR_1_URL=.*\n.*SONARR_2_|SONARR_1_NAME/s);
  const { c } = loadConfig(parseDotenv(text));
  for (const k of ['plexUrl', 'plexToken', 'dryRun', 'maxPerDay', 'pollSeconds', 'overseerrUrl', 'overseerrKey', 'overseerrTypes', 'overseerrResolve', 'qbitUrl', 'qbitUsername', 'qbitPassword', 'sabApiKey', 'arrs', 'clients']) {
    assert.deepEqual(c[k], original[k], k);
  }
});

test('the .env download needs the web UI password and carries the saved settings', async () => {
  const pass = rnd(), token = rnd();
  process.env.UI_PASSWORD = pass; process.env.UI_PORT = '0';
  const { saveConfig } = await import('./config.mjs');
  const { serve } = await import('./app.mjs');
  saveConfig({ plexToken: token });
  const srv = serve(); await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/env`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const ok = await fetch(url, { headers: { authorization: 'Basic ' + Buffer.from('x:' + pass).toString('base64') } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-disposition'), /attachment; filename="reportarr\.env"/);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.match(await ok.text(), new RegExp(`PLEX_KEY=${token}`));
  } finally { srv.close(); }
});
