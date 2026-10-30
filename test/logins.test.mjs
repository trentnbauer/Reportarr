import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-logins-'));
const { checkLogins, health } = await import('../src/engine.mjs');

const rnd = () => randomBytes(8).toString('hex'); // generated per run so the repo holds no secret-looking literals
const GOOD = rnd(), logins = [];
const qbit = await new Promise((res) => { const s = http.createServer(async (req, r) => {
  let body = ''; for await (const d of req) body += d;
  if (req.url === '/api/v2/auth/login') { logins.push(new URLSearchParams(body).get('password')); if (new URLSearchParams(body).get('password') !== GOOD) return r.end('Fails.'); r.setHeader('set-cookie', 'SID=x; path=/'); return r.end('Ok.'); }
  if (req.url === '/api/v2/app/version') return r.end('v5.0.2');
  r.writeHead(404).end();
}).listen(0, '127.0.0.1', () => res(s)); });
const closed = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => res(port)); }); }); // nothing listens here
const client = (name, port, password) => ({ name, kind: 'qbittorrent', url: `http://127.0.0.1:${port}`, username: 'admin', password, apiKey: '' });
const at = (min) => Date.parse('2026-01-01T00:00:00Z') + min * 60_000;

test('download clients are checked on their own: green when they work, red with the reason when they do not', async () => {
  const c = { clients: [client('ok', qbit.address().port, GOOD), client('wrong', qbit.address().port, 'nope'), client('down', closed, GOOD), { name: 'default', kind: 'qbittorrent', url: '', default: true }], subtitles: [] };
  await checkLogins(c, at(0));
  assert.equal(health['client:ok'].ok, true);
  assert.equal(health['client:wrong'].ok, false);
  assert.match(health['client:wrong'].message, /refused the username or password/);
  assert.equal(health['client:down'].ok, false);
  assert.equal(health['client:default'], undefined, 'a default client has no address of its own to check');
  assert.ok(!Object.values(health).some((h) => /nope|admin/.test(h.message)), 'no secrets in the messages');
});

test('gently: not again within 10 minutes, a refused login not at all, a down client again', async () => {
  const c = { clients: [client('ok', qbit.address().port, GOOD), client('wrong', qbit.address().port, 'nope'), client('down', closed, GOOD)], subtitles: [] };
  logins.length = 0;
  await checkLogins(c, at(5));
  assert.equal(logins.length, 0, 'nothing is asked again within 10 minutes');
  await checkLogins(c, at(11));
  assert.deepEqual(logins, [GOOD], 'only the working one again: the refused login is left alone so the address is not banned');
  assert.equal(health['client:down'].ok, false);
  await checkLogins(c, at(60));
  assert.deepEqual(logins, [GOOD, GOOD], 'and still not the refused one an hour later');
});

test('fixing the password is noticed at once, without waiting for the interval', async () => {
  const c = { clients: [client('wrong', qbit.address().port, GOOD)], subtitles: [] };
  logins.length = 0;
  await checkLogins(c, at(61));
  assert.deepEqual(logins, [GOOD]);
  assert.equal(health['client:wrong'].ok, true);
});

test.after(() => qbit.close());
