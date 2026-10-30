import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const rnd = () => randomBytes(8).toString('hex'); // generated per run so the repo holds no secret-looking literals
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s)); });

// a Discord that records what it is sent, one path per channel
const posts = [];
const discordServer = await listen(async (req, res) => {
  let body = ''; for await (const d of req) body += d;
  posts.push({ path: req.url, body: JSON.parse(body) });
  res.writeHead(req.url === '/refused' ? 401 : 204).end();
});
const hook = (p) => `http://127.0.0.1:${discordServer.address().port}${p}`;

// a mail server that speaks just enough SMTP, remembering the mail and whether it was asked to log in
const mails = [];
const PASS = rnd();
const smtpServer = await new Promise((res) => {
  const s = net.createServer((sock) => {
    let data = false, buf = '', mail = { to: [] };
    const say = (l) => sock.write(l + '\r\n');
    say('220 test ESMTP');
    sock.on('data', (d) => {
      buf += d;
      if (data) { if (!buf.endsWith('\r\n.\r\n')) return; mail.raw = buf; mails.push(mail); data = false; buf = ''; return say('250 queued'); }
      for (const line of buf.split('\r\n').slice(0, -1)) {
        if (/^EHLO/.test(line)) say('250-test\r\n250 AUTH PLAIN');
        else if (/^AUTH PLAIN /.test(line)) { mail.auth = Buffer.from(line.slice(11), 'base64').toString().split('\0'); say(mail.auth[2] === PASS ? '235 ok' : '535 bad login'); }
        else if (/^MAIL FROM:/.test(line)) { mail.from = line.slice(10); say('250 ok'); }
        else if (/^RCPT TO:/.test(line)) { const t = line.slice(8); if (t.includes('nobody')) say('550 no such user'); else { mail.to.push(t); say('250 ok'); } }
        else if (line === 'DATA') { data = true; say('354 go'); }
        else if (line === 'QUIT') { say('221 bye'); sock.end(); }
        buf = buf.slice(line.length + 2);
        if (data) break;
      }
    });
    sock.on('error', () => {});
  }).listen(0, '127.0.0.1', () => res(s));
});
const smtpPort = smtpServer.address().port;

// channels from the environment, as an operator would set them, then the real modules
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-notify-'));
Object.assign(process.env, {
  DISCORD_WEBHOOK: hook('/all'), DISCORD_NAME: 'everything',
  DISCORD_2_WEBHOOK: hook('/failures'), DISCORD_2_EVENTS: 'failed',
});
const discord = (await import('../src/integrations/discord.mjs')).default;
const smtp = (await import('../src/integrations/smtp.mjs')).default;
const { getConfig, saveConfig, publicConfig, validate, envFile } = await import('../src/config.mjs');
const { notifyRow, notifyReporter, flushAll, eventOf, compose } = await import('../src/notify.mjs');
const { record, changesFile } = await import('../src/engine.mjs');
const { runCheck } = await import('../src/checks.mjs');

const SMTP = { name: 'email-1', kind: 'smtp', host: '127.0.0.1', port: String(smtpPort), username: 'me', password: PASS, from: 'reportarr@example.com', to: 'a@example.com, b@example.com', tls: false };

test('Discord: a message is one embed, signed, that cannot ping anyone', async () => {
  posts.length = 0;
  await discord.send({ webhook: hook('/x'), username: 'Bot' }, { event: 'replaced', title: 'Replaced', lines: ['Show S01E01 on sonarr'] });
  const b = posts[0].body;
  assert.equal(b.username, 'Bot');
  assert.deepEqual(b.allowed_mentions, { parse: [] });
  assert.equal(b.embeds[0].title, 'Replaced');
  assert.match(b.embeds[0].description, /Show S01E01 on sonarr/);
  assert.equal(b.embeds[0].footer.text, 'Reportarr (automated system)');
  await assert.rejects(discord.send({ webhook: hook('/refused') }, { event: 'failed', title: 't', lines: [] }), /was refused/);
});

test('Discord: only Discord webhook addresses can be saved or tested', async () => {
  assert.throws(() => validate({ notifications: [{ name: 'd', kind: 'discord', webhook: 'http://127.0.0.1/hook' }] }), /Discord webhook URL/);
  assert.doesNotThrow(() => validate({ notifications: [{ name: 'd', kind: 'discord', webhook: 'https://discord.com/api/webhooks/123456/abc_DEF-1' }] }));
  assert.equal((await runCheck(getConfig(), { target: 'notification', kind: 'discord', name: '', webhook: 'https://example.com/x' })).ok, false);
  assert.match((await runCheck(getConfig(), { target: 'notification', kind: 'discord', name: '', webhook: '' })).message, /Set a webhook/);
});

test('SMTP: logs in, sends to every address, and the body is the message plus the sign-off', async () => {
  mails.length = 0;
  await smtp.send(SMTP, { event: 'replaced', title: 'Replaced (2)', lines: ['Show S01E01 on sonarr', 'Café – ü'] });
  const m = mails[0];
  assert.deepEqual(m.auth, ['', 'me', PASS]);
  assert.equal(m.from, '<reportarr@example.com>');
  assert.deepEqual(m.to, ['<a@example.com>', '<b@example.com>']);
  const [head, body] = m.raw.split('\r\n\r\n');
  assert.match(head, /Subject: \[Reportarr\] Replaced \(2\)/);
  const text = Buffer.from(body.replace(/\r\n/g, '').replace(/\.$/, ''), 'base64').toString();
  assert.match(text, /Café – ü/);
  assert.match(text, /— Reportarr \(automated system\)/);
});

test('SMTP: a refused login or recipient is reported, and the Test button sends a real message', async () => {
  await assert.rejects(smtp.send({ ...SMTP, password: 'wrong' }, { event: 'test', title: 't', lines: [] }), /535 bad login/);
  await assert.rejects(smtp.send({ ...SMTP, to: 'nobody@example.com' }, { event: 'test', title: 't', lines: [] }), /550 no such user/);
  mails.length = 0;
  const ok = await runCheck({ ...getConfig(), notifications: [SMTP] }, { target: 'notification', kind: 'smtp', name: 'email-1', host: SMTP.host, port: SMTP.port, username: 'me', password: '', from: SMTP.from, to: SMTP.to, tls: false });
  assert.deepEqual([ok.ok, ok.message], [true, 'Test email sent'], 'a blank password uses the saved one by name');
  assert.equal(mails.length, 1);
  assert.equal((await runCheck(getConfig(), { target: 'notification', kind: 'smtp', name: '', host: '' })).ok, false);
});

test('SMTP: bad addresses and ports are refused before anything is sent', () => {
  const bad = (o) => () => validate({ notifications: [{ ...SMTP, ...o }] });
  assert.throws(bad({ host: '' }), /needs a host/);
  assert.throws(bad({ port: '99999' }), /port/);
  assert.throws(bad({ from: 'not an address' }), /From/);
  assert.throws(bad({ to: 'a@example.com, evil@example.com\r\nRCPT TO:<x@y>' }), /To address/);
  assert.doesNotThrow(bad({}));
});

test('settings: channels are saved, secrets never leave the server, and a blank keeps the saved one', () => {
  saveConfig({ notifications: [SMTP, { name: 'discord-9', kind: 'discord', webhook: 'https://discord.com/api/webhooks/1/tok', username: 'Bot', onCap: false }] });
  const pub = publicConfig().notifications;
  const mail = pub.find((x) => x.name === 'email-1'), dc = pub.find((x) => x.name === 'discord-9');
  assert.ok(!('password' in mail) && mail.passwordSet === true && !('webhook' in dc) && dc.webhookSet === true);
  assert.equal(dc.onCap, false);
  saveConfig({ notifications: [{ ...SMTP, password: '' }, { name: 'discord-9', kind: 'discord', webhook: '', username: 'Bot' }] });
  const kept = getConfig().notifications;
  assert.equal(kept.find((x) => x.name === 'email-1').password, PASS);
  assert.equal(kept.find((x) => x.name === 'discord-9').webhook, 'https://discord.com/api/webhooks/1/tok');
  assert.equal(kept.find((x) => x.name === 'discord-9').onCap, true, 'events default to on');
});

test('the environment defines channels, read-only, with the events they listen to', () => {
  const cfg = getConfig().notifications;
  assert.deepEqual(cfg.filter((x) => /^(everything|discord-2)$/.test(x.name)).map((x) => x.name), ['everything', 'discord-2']);
  const all = cfg.find((x) => x.name === 'everything'), failures = cfg.find((x) => x.name === 'discord-2');
  assert.ok(all.onReplaced !== false && failures.onReplaced === false && failures.onFailed === true);
  assert.deepEqual(smtp.fromEnv({ SMTP_HOST: 'h', SMTP_TO: 'a@b.c', SMTP_FROM: 'r@b.c', SMTP_TLS: 'false', SMTP_EVENTS: 'cap' }).map((x) => [x.name, x.host, x.tls, x.onCap, x.onReplaced]), [['email', 'h', false, true, false]]);
  assert.deepEqual(smtp.fromEnv({ SMTP_2_HOST: 'h2', SMTP_2_NAME: 'work' }).map((x) => [x.name, x.host, x.port]), [['work', 'h2', '587']]);
  assert.deepEqual(discord.fromEnv({}), [], 'nothing configured means nothing returned');
  assert.throws(() => saveConfig({ notifications: [{ name: 'everything', kind: 'discord', webhook: 'https://discord.com/api/webhooks/1/t' }] }), /already used by one set in the environment/);
});

test('the .env export includes the channels, and reads back the same', () => {
  const out = envFile();
  assert.match(out, /^SMTP_1_HOST=127\.0\.0\.1$/m);
  assert.match(out, /^SMTP_1_EVENTS=replaced,failed,resolved,cap,userlimit$/m);
  assert.match(out, /^DISCORD_3_WEBHOOK=https:\/\/discord\.com\/api\/webhooks\/1\/tok$/m, 'channels added in the UI follow the ones from the environment');
});

test('log rows become events; queue-priority failures and repeats of the daily cap are not worth a message', () => {
  assert.equal(eventOf({ status: 'replaced' }), 'replaced');
  assert.equal(eventOf({ status: 'resolved' }), 'resolved');
  assert.equal(eventOf({ status: 'error', detail: 'DELETE /moviefile/5 500' }), 'failed');
  assert.equal(eventOf({ status: 'error', detail: 'priority failed: qBittorrent login failed' }), undefined);
  assert.equal(eventOf({ status: 'info', detail: 'baselined 3 existing reports' }), undefined);
  assert.equal(eventOf({ status: 'dry-run' }), undefined);
  assert.equal(eventOf({ status: 'info', detail: 'hourly limit 20 reached; 2 new report(s) wait until the next hour' }), 'cap');
  assert.equal(eventOf({ status: 'skipped', detail: 'hourly limit 20 reached: not replaced' }), undefined, 'once an hour');
});

test('a user reaching their daily limit is announced once a day, however many of their reports are held', () => {
  const row = { status: 'held', userLimit: true, user: 'alice', detail: 'alice has reached their daily limit of 5' };
  assert.equal(eventOf(row), 'userlimit');
  assert.equal(eventOf({ ...row, reportId: 'overseerr:2' }), undefined, 'a second held report of hers adds no message');
  assert.equal(eventOf({ ...row, user: 'bob' }), 'userlimit', 'another user is told about separately');
  assert.equal(eventOf({ status: 'info', userLimit: true, user: 'carol', detail: 'carol reached their daily limit of 5' }), 'userlimit', 'reaching it mid-run counts too');
  assert.match(compose('userlimit', [row]).lines[0], /alice has reached their daily limit/);
});

test('events close together are one message, and each channel gets only the events it chose', async () => {
  await flushAll();
  posts.length = 0;
  saveConfig({ notifications: [] }); // only the two from the environment remain
  for (const n of [1, 2, 3]) notifyRow({ status: 'replaced', title: `Show S01E0${n}`, instance: 'sonarr', file: `ep${n}.mkv`, source: 'Plex report' });
  notifyRow({ status: 'error', title: 'Film', detail: 'DELETE /moviefile/5 500', source: 'Plex report' });
  await flushAll();
  const to = (p) => posts.filter((x) => x.path === p);
  assert.equal(to('/all').length, 2, 'one message for the three replacements, one for the failure');
  const replaced = to('/all').find((x) => /Replaced/.test(x.body.embeds[0].title)).body.embeds[0];
  assert.equal(replaced.title, 'Replaced (3)');
  assert.match(replaced.description, /Show S01E02 on sonarr \(ep2\.mkv\)/);
  assert.equal(to('/failures').length, 1, 'the second channel only listens for failures');
  assert.match(to('/failures')[0].body.embeds[0].description, /Film: DELETE \/moviefile\/5 500/);
});

test('a broken channel never stops anything', async () => {
  saveConfig({ notifications: [] });
  const c = compose('replaced', Array.from({ length: 25 }, (_, i) => ({ title: `T${i}` })));
  assert.equal(c.lines.length, 21);
  assert.match(c.lines.at(-1), /and 5 more/);
  notifyRow({ status: 'replaced', title: 'x' });
  await assert.doesNotReject(flushAll());
});

test('SMTP templates: each is complete, and picking one by name fills in the host, port and TLS', () => {
  const keys = smtp.templates.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, 'no template twice');
  for (const t of smtp.templates) {
    assert.ok(t.label && t.note, `${t.key} has a name and a note`);
    assert.ok(Number.isInteger(+t.port) && +t.port > 0 && +t.port < 65536, `${t.key} has a port`);
    if (+t.port === 465) assert.equal(t.tls, true, `${t.key}: 465 is implicit TLS`);
  }
  const gmail = smtp.templates.find((t) => t.key === 'gmail');
  assert.deepEqual([gmail.host, gmail.port, gmail.tls], ['smtp.gmail.com', '587', true]);
});

test('SMTP_TEMPLATE in the environment: the template fills in what is not set, explicit settings win, numbered ones work, an unknown name is ignored', () => {
  const one = (env) => smtp.fromEnv(env).map((x) => [x.name, x.template, x.host, x.port, x.tls]);
  assert.deepEqual(one({ SMTP_TEMPLATE: 'Gmail', SMTP_FROM: 'a@b.c' }), [['email', 'gmail', 'smtp.gmail.com', '587', true]], 'a template alone is a channel; the name is not case-sensitive');
  assert.deepEqual(one({ SMTP_TEMPLATE: 'yahoo' }), [['email', 'yahoo', 'smtp.mail.yahoo.com', '465', true]]);
  assert.deepEqual(one({ SMTP_TEMPLATE: 'gmail', SMTP_HOST: 'proxy.local', SMTP_PORT: '2525', SMTP_TLS: 'false' }), [['email', 'gmail', 'proxy.local', '2525', false]], 'explicit settings win');
  assert.deepEqual(one({ SMTP_2_TEMPLATE: 'sendgrid', SMTP_2_NAME: 'work' }), [['work', 'sendgrid', 'smtp.sendgrid.net', '587', true]]);
  assert.deepEqual(one({ SMTP_TEMPLATE: 'nonsense', SMTP_HOST: 'h' }), [['email', '', 'h', '587', true]], 'an unknown template is ignored');
  assert.deepEqual(one({}), []);
});

test('the template is saved with the channel, shown to the UI, and exported to .env', () => {
  saveConfig({ notifications: [{ ...SMTP, name: 'gmail-1', template: 'gmail', host: 'smtp.gmail.com', port: '587', tls: true }] });
  assert.equal(getConfig().notifications.find((x) => x.name === 'gmail-1').template, 'gmail');
  assert.match(envFile(), /^SMTP_\d+_TEMPLATE=gmail$/m);
  saveConfig({ notifications: [{ ...SMTP, name: 'gmail-1', template: 'bogus' }] });
  assert.equal(getConfig().notifications.find((x) => x.name === 'gmail-1').template, '', 'an unknown template is not stored');
  saveConfig({ notifications: [] });
});

const bodyOf = (m) => { const [head, body] = m.raw.split('\r\n\r\n'); return { head, text: Buffer.from(body.replace(/\r\n/g, '').replace(/\.$/, ''), 'base64').toString() }; };

test('the reporter is emailed when their report is completed, with the reason, only through a channel that has it on', async () => {
  saveConfig({ notifications: [{ ...SMTP, name: 'on', toReporter: true }, { ...SMTP, name: 'off', toReporter: false }] });
  mails.length = 0;
  await notifyReporter({ reporterEmail: 'bob@example.com', outcome: 'Denied', notice: 'Series report. Report a season or 1 file.', link: 'http://seerr/issues/9' });
  assert.equal(mails.length, 1, 'one email, from the channel that has it on');
  assert.deepEqual(mails[0].to, ['<bob@example.com>'], 'to the reporter only, not the channel\'s own recipients');
  const { head, text } = bodyOf(mails[0]);
  assert.match(head, /Subject: \[Reportarr\] Denied/);
  assert.match(text, /Denied - Series report\. Report a season or 1 file\./);
  assert.match(text, /http:\/\/seerr\/issues\/9/);
  assert.match(text, /— Reportarr \(automated system\)/);
  mails.length = 0;
  await notifyReporter({ outcome: 'Denied', notice: 'x' });
  await notifyReporter({ reporterEmail: 'bob@example.com', outcome: 'Denied' });
  assert.equal(mails.length, 0, 'nothing without an address or a reason');
  saveConfig({ notifications: [{ ...SMTP, toReporter: false }] });
  await notifyReporter({ reporterEmail: 'bob@example.com', outcome: 'Resolved', notice: 'The file was replaced and the new one is ready.' });
  assert.equal(mails.length, 0, 'nothing when no channel has it on');
  saveConfig({ notifications: [] });
});

test('logging a completed report emails the reporter, and keeps their address out of the log', async () => {
  saveConfig({ notifications: [{ ...SMTP, toReporter: true }] });
  mails.length = 0;
  record({ status: 'denied', reportId: 'overseerr:5', title: 'Heat', reporterEmail: 'dana@example.com', outcome: 'Denied', notice: 'No file was found.', detail: 'x' });
  for (let i = 0; i < 40 && !mails.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(mails.length, 1);
  assert.match(bodyOf(mails[0]).head, /Subject: \[Reportarr\] Denied: Heat/);
  const log = fs.readFileSync(changesFile(), 'utf8');
  assert.ok(!log.includes('dana@example.com'), 'the address is not stored');
  assert.match(log, /No file was found\./);
  saveConfig({ notifications: [] });
});

test('"Email the reporter" is off by default, comes from SMTP_TO_REPORTER, and is exported', () => {
  assert.equal(smtp.fromEnv({ SMTP_HOST: 'h' })[0].toReporter, false);
  assert.equal(smtp.fromEnv({ SMTP_HOST: 'h', SMTP_TO_REPORTER: 'true' })[0].toReporter, true);
  assert.equal(smtp.normalize({ name: 'e', host: 'h', from: 'a@b.c', to: 'a@b.c' }).toReporter, false);
  assert.equal(smtp.normalize({ name: 'e', toReporter: true }).toReporter, true);
  assert.deepEqual(smtp.envLines({ toReporter: true }, 1).find(([k]) => k === 'SMTP_1_TO_REPORTER'), ['SMTP_1_TO_REPORTER', true]);
  assert.equal(smtp.defaults.toReporter, false);
  assert.ok(smtp.switches.some((s) => s.name === 'toReporter'));
});

test.after(() => { discordServer.close(); smtpServer.close(); });
