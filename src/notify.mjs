// Tells the notification channels (Discord, email) what happened. A log row becomes an event (see eventOf); events of one
// kind that arrive close together are sent as one message, so a replaced season is one Discord post, not twelve.
// Nothing here may throw or wait: a broken webhook must never stop a replacement.
import { getConfig } from './config.mjs';
import { NOTIFIERS } from './integrations/index.mjs';
import { wants, clip } from './integrations/events.mjs';
import { log, why } from './util.mjs';
import { notificationHtml, reporterHtml } from './email.mjs';

const WAIT_MS = 5000;
const MAX_LINES = 20;
const queue = new Map(); // event -> { items: [log rows], timer }
let capHour = '';
const userLimitDay = new Map(); // user -> the day we last told about them

// What a log row means to a notification channel, if anything.
export function eventOf(r) {
  const detail = r.detail ?? '';
  if (r.userLimit) { // a user reached their daily limit: once a day per user, however many of their reports are held
    const day = new Date().toLocaleDateString('en-CA');
    if (userLimitDay.get(r.user) === day) return;
    userLimitDay.set(r.user, day);
    return 'userlimit';
  }
  if (r.status === 'replaced') return 'replaced';
  if (r.status === 'resolved') return 'resolved';
  if (r.status === 'error') return /^priority failed/.test(detail) ? undefined : 'failed'; // a queue priority that did not work is not worth a message
  if ((r.status === 'info' || r.status === 'skipped') && /hourly limit|daily cap/i.test(detail)) {
    const hour = new Date().toISOString().slice(0, 13);
    if (capHour === hour) return; // once an hour
    capHour = hour;
    return 'cap';
  }
}

const HEAD = { replaced: 'Replaced', failed: 'Failed', resolved: 'Resolved', cap: 'Hourly limit reached', userlimit: 'User limit reached' };
const lineOf = (event, r) => {
  if (event === 'replaced') return `${r.title ?? r.source ?? 'A file'}${r.instance ? ` on ${r.instance}` : ''}${r.file ? ` (${r.file})` : ''}`;
  if (event === 'failed') return `${r.title ? `${r.title}: ` : ''}${r.detail ?? 'something went wrong'}${r.source ? ` (${r.source})` : ''}`;
  return r.detail ?? r.title ?? '';
};
export function compose(event, rows) {
  const lines = rows.slice(0, MAX_LINES).map((r) => clip(lineOf(event, r), 300));
  if (rows.length > MAX_LINES) lines.push(`…and ${rows.length - MAX_LINES} more`);
  return { event, title: rows.length === 1 ? HEAD[event] : `${HEAD[event]} (${rows.length})`, lines };
}

export async function flush(event) {
  const q = queue.get(event);
  if (!q) return;
  queue.delete(event); clearTimeout(q.timer);
  const cfg = getConfig(), msg = { ...compose(event, q.items), server: cfg.serverName };
  msg.html = notificationHtml({ event, rows: q.items, server: cfg.serverName, dryRun: cfg.dryRun, subject: msg.title }); // only the email channels use it
  await Promise.allSettled(getConfig().notifications
    .filter((ch) => NOTIFIERS[ch.kind]?.isConfigured(ch) && wants(ch, event))
    .map((ch) => NOTIFIERS[ch.kind].send(ch, msg).catch((e) => log('notification', ch.name, 'failed:', why(e)))));
}
export const flushAll = () => Promise.all([...queue.keys()].map(flush));

// Email the person who made a report when it is completed (resolved, denied or skipped), with the reason. Only through SMTP channels
// that have "Email the reporter" on. Never batched: one email per report, to that person only. Returns a promise for tests.
export function notifyReporter(r) {
  if (!r.reporterEmail || !r.notice) return Promise.resolve();
  try {
    const msg = { event: 'reporter', server: getConfig().serverName, to: [r.reporterEmail], title: `${r.outcome}${r.title ? `: ${r.title}` : ''}`,
      lines: [`${r.outcome} - ${r.notice}`, ...(r.title ? [`About: ${r.title}`] : []), ...(r.link ? [`Your report: ${r.link}`] : [])] };
    msg.html = reporterHtml(r, { server: msg.server, subject: msg.title });
    return Promise.allSettled(getConfig().notifications
      .filter((ch) => ch.kind === 'smtp' && ch.toReporter === true && NOTIFIERS.smtp.isConfigured(ch))
      .map((ch) => NOTIFIERS.smtp.send(ch, msg).catch((e) => log('notification', ch.name, 'failed to email the reporter:', why(e)))));
  } catch (e) { log('notification', 'reporter not emailed:', why(e)); return Promise.resolve(); }
}

// Called for every row the app logs.
export function notifyRow(row) {
  try {
    const event = eventOf(row);
    if (!event || !getConfig().notifications.some((ch) => wants(ch, event))) return;
    const q = queue.get(event) ?? { items: [] };
    q.items.push({ time: new Date().toISOString(), ...row }); queue.set(event, q);
    q.timer ??= setTimeout(() => flush(event), WAIT_MS).unref();
  } catch (e) { log('notification', 'not queued:', why(e)); }
}
