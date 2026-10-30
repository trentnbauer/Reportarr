// SMTP email: a notification channel. A small SMTP client on node:net / node:tls, so the image needs no mail library.
// Port 465 with TLS on is implicit TLS; any other port with TLS on is upgraded with STARTTLS; TLS off sends in the clear.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { TIMEOUT_MS, pass, fail, SIGN_OFF } from '../util.mjs';
import { eventSwitches, flagsOf, eventFlags, eventsLine, envIndexes } from './events.mjs';

const ADDRESS = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/; // also keeps line breaks and extra commands out of the SMTP conversation
const addresses = (v) => String(v ?? '').split(',').map((a) => a.trim()).filter(Boolean);
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

// base64 body: no dot-stuffing or line-length worries, any text is safe
const build = ({ from, to, subject, text }) => [
  `From: ${from}`, `To: ${to.join(', ')}`, `Subject: ${header(oneLine(subject))}`, `Date: ${new Date().toUTCString()}`,
  `Message-ID: <${crypto.randomUUID()}@reportarr>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
  b64(text).replace(/.{1,76}/g, '$&\r\n'),
].join('\r\n');

const open = (host, port, implicit) => new Promise((resolve, reject) => {
  const s = implicit ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  s.setTimeout(TIMEOUT_MS * 1.5, () => s.destroy(new Error('no answer from the mail server')));
  s.once(implicit ? 'secureConnect' : 'connect', () => resolve(s));
  s.once('error', reject);
});
const upgrade = (sock, host) => new Promise((resolve, reject) => {
  sock.removeAllListeners('data');
  const s = tls.connect({ socket: sock, servername: host });
  s.setTimeout(TIMEOUT_MS * 1.5, () => s.destroy(new Error('no answer from the mail server')));
  s.once('secureConnect', () => resolve(s));
  s.once('error', reject);
});

// A reader of the server's replies: each call resolves with the next complete reply (a multi-line reply ends at "250 ...").
function replies(sock) {
  let buf = '', waiting = null, failed = null;
  const take = () => {
    const lines = buf.split('\r\n'), done = lines.findIndex((l) => /^\d{3}( |$)/.test(l));
    if (done < 0 || done >= lines.length - 1) return null; // the last element is a line still arriving
    buf = lines.slice(done + 1).join('\r\n');
    return lines.slice(0, done + 1).join('\n');
  };
  const pump = () => {
    if (!waiting) return;
    if (failed) { waiting.reject(failed); waiting = null; return; }
    const r = take();
    if (r !== null) { waiting.resolve(r); waiting = null; }
  };
  sock.on('data', (d) => { buf += d; pump(); });
  sock.on('error', (e) => { failed = e; pump(); });
  sock.on('close', () => { failed ??= new Error('the mail server closed the connection'); pump(); });
  return () => new Promise((resolve, reject) => { waiting = { resolve, reject }; pump(); });
}
const expect = (reply, ...codes) => {
  if (!codes.includes(+reply.slice(0, 3))) throw new Error(`mail server said: ${reply.split('\n').at(-1).slice(0, 160)}`);
  return reply;
};

export async function sendMail(o) {
  const port = +o.port || 587, implicit = o.tls !== false && port === 465;
  let sock = await open(o.host, port, implicit), read = replies(sock);
  const say = async (line, ...ok) => { sock.write(line + '\r\n'); return expect(await read(), ...ok); };
  try {
    expect(await read(), 220);
    let hello = await say('EHLO reportarr', 250);
    if (o.tls !== false && !implicit) {
      if (!/STARTTLS/i.test(hello)) throw new Error('the mail server does not offer STARTTLS: turn off "Use TLS" to send without it');
      await say('STARTTLS', 220);
      sock = await upgrade(sock, o.host); read = replies(sock);
      hello = await say('EHLO reportarr', 250);
    }
    if (o.username) await say('AUTH PLAIN ' + b64(`\0${o.username}\0${o.password ?? ''}`), 235);
    await say(`MAIL FROM:<${o.from}>`, 250);
    for (const t of o.to) await say(`RCPT TO:<${t}>`, 250, 251);
    await say('DATA', 354);
    sock.write(build(o) + '.\r\n');
    expect(await read(), 250);
    sock.write('QUIT\r\n');
  } finally { sock.destroy(); }
}

const entry = (name, v) => ({ name, kind: 'smtp', host: v('HOST') ?? '', port: v('PORT') ?? '587', username: v('USERNAME') ?? '', password: v('PASSWORD') ?? '', from: v('FROM') ?? '', to: v('TO') ?? '', tls: v('TLS') !== 'false', ...eventFlags(v('EVENTS')) });

const smtp = {
  kind: 'smtp', label: 'SMTP email', prefix: 'email',
  fields: [
    { name: 'host', label: 'Host' },
    { name: 'port', label: 'Port', type: 'number', hint: '587 for STARTTLS, 465 for TLS' },
    { name: 'username', label: 'Username' },
    { name: 'password', label: 'Password', type: 'password', set: 'passwordSet' },
    { name: 'from', label: 'From', type: 'email' },
    { name: 'to', label: 'To', hint: 'Comma-separate several addresses' },
  ],
  switches: [{ name: 'tls', label: 'Use TLS', hint: 'STARTTLS or implicit TLS, by port' }, ...eventSwitches],
  defaults: { host: '', port: '587', username: '', password: '', from: '', to: '', tls: true },

  // SMTP_HOST (+ SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM, SMTP_TO, SMTP_TLS, SMTP_EVENTS, SMTP_NAME) is one channel;
  // SMTP_2_HOST ... are more
  fromEnv(e) {
    const out = [];
    if (e.SMTP_HOST) out.push(entry(e.SMTP_NAME || 'email', (k) => e[`SMTP_${k}`]));
    for (const n of envIndexes(e, 'SMTP', 'HOST')) out.push(entry(e[`SMTP_${n}_NAME`] || `email-${n}`, (k) => e[`SMTP_${n}_${k}`]));
    return out;
  },
  envLines: (s, n) => [['NAME', s.name], ['HOST', s.host], ['PORT', s.port], ['USERNAME', s.username], ['PASSWORD', s.password], ['FROM', s.from], ['TO', s.to], ['TLS', s.tls !== false], ['EVENTS', eventsLine(s)]].map(([k, v]) => [`SMTP_${n}_${k}`, v]),
  validate(x) {
    if (!x.host) return 'needs a host';
    if (x.port && !(Number.isInteger(+x.port) && +x.port >= 1 && +x.port <= 65535)) return 'the port must be a number from 1 to 65535';
    if (!ADDRESS.test(String(x.from ?? '').trim())) return 'needs a From address';
    const to = addresses(x.to);
    if (!to.length || !to.every((a) => ADDRESS.test(a))) return 'needs at least one valid To address (comma-separate several)';
    return '';
  },
  normalize: (s, old) => ({
    name: s.name, kind: 'smtp', host: String(s.host ?? '').trim(), port: String(s.port || '587'), username: String(s.username ?? '').trim(), password: s.password || old?.password || '',
    from: String(s.from ?? '').trim(), to: addresses(s.to).join(', '), tls: s.tls !== false, ...flagsOf(s),
  }),
  isConfigured: (s) => !!(s.host && ADDRESS.test(s.from ?? '') && addresses(s.to).length),

  // msg is { event, title, lines }
  send: (ch, msg) => sendMail({ ...ch, to: addresses(ch.to), subject: `[Reportarr] ${msg.title}`, text: `${msg.lines.join('\n')}\n\n— ${SIGN_OFF}\n` }),

  checkArgs: (req, stored) => ({ host: req.host, port: req.port, username: req.username, password: req.password || stored?.password || '', from: req.from, to: req.to, tls: req.tls !== false }),
  async check(ch) {
    if (!smtp.isConfigured(ch)) return fail('Set a host, a From address and at least one To address first');
    await smtp.send(ch, { event: 'test', title: 'Test message', lines: ['Reportarr can send email through this server.'] });
    return pass('Test email sent');
  },
};
export default smtp;
