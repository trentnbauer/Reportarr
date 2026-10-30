// The HTML emails: two templates (src/templates/) with Mustache-style placeholders, and what fills them in.
//   notification.html: to the addresses in SMTP_TO, one row per batched event
//   reporter.html:     to the person who made a Seerr report, when it is completed
// To restyle them, copy a template, edit it, and point EMAIL_TEMPLATE_DIR at the folder holding your copies (a file missing there falls
// back to the built-in one). The variables each template takes are listed in the comment at the top of the file, which is stripped
// before sending.
import fs from 'node:fs';
import path from 'node:path';

const read = (name) => {
  const own = process.env.EMAIL_TEMPLATE_DIR && path.join(process.env.EMAIL_TEMPLATE_DIR, name);
  const file = own && fs.existsSync(own) ? own : new URL(`./templates/${name}`, import.meta.url);
  return fs.readFileSync(file, 'utf8').replace(/<!--(?!\[if)[\s\S]*?-->/, ''); // the documentation comment, not the Outlook conditionals
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// {{name}} is escaped text; {{#name}}...{{/name}} repeats for a list, or shows once when the value is truthy and hides when it is not.
// One pass over the template, so what is filled in is never read as a placeholder itself (a title like "{{server_name}}" stays text).
export function render(tpl, ctx) {
  return tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}|\{\{(\w+)\}\}/g, (_, section, inner, name) => {
    if (name) return esc(ctx[name]);
    const v = ctx[section];
    return Array.isArray(v) ? v.map((x) => render(inner, { ...ctx, ...x })).join('') : v ? render(inner, ctx) : '';
  });
}

const TONE = { ok: ['#e5f3ea', '#157f3b'], acc: ['#fbf1df', '#8f5d07'], bad: ['#fcebe9', '#b42318'], neu: ['#eceef1', '#4b5260'] };
const tone = (t) => ({ status_bg: TONE[t][0], status_fg: TONE[t][1] });
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const appUrl = () => (/^https?:\/\//.test(process.env.BASE_URL ?? '') ? process.env.BASE_URL : ''); // the button is left out when there is no public address

// What each event looks like in the notification email.
const EVENT = {
  replaced: { label: 'Replaced', tone: 'ok', heading: (n) => `${n} ${n === 1 ? 'file' : 'files'} replaced`, summary: 'Reportarr deleted these files and started searching for new ones.' },
  resolved: { label: 'Resolved', tone: 'ok', heading: (n) => `${n} ${n === 1 ? 'report' : 'reports'} resolved`, summary: 'The new files are ready and the reports are closed.' },
  failed: { label: 'Failed', tone: 'bad', heading: (n) => `${n} ${n === 1 ? 'failure' : 'failures'}`, summary: 'These need a look.' },
  cap: { label: 'Limit reached', tone: 'acc', heading: () => 'Hourly limit reached', summary: 'Replacements are paused until the hour turns over, or until you override the limit.' },
  userlimit: { label: 'Held', tone: 'acc', heading: () => 'User limit reached', summary: 'Their other reports are held until tomorrow, or until you press Override limit.' },
  test: { label: 'Test', tone: 'neu', heading: () => 'Test message', summary: 'Reportarr can send email through this server.' },
};

const MAX_ROWS = 50; // a season is a few dozen rows; the full list is in the web UI
// event: replaced | resolved | failed | cap | userlimit | test; rows: the log rows, as recorded
export function notificationHtml({ event, rows, server, dryRun, subject }) {
  const e = EVENT[event] ?? EVENT.failed, name = server || 'Reportarr';
  const events = rows.slice(0, MAX_ROWS).map((r) => ({ ...tone(e.tone), status_label: e.label, title: r.title ?? '', source: r.source ?? '', instance: r.instance ?? '', file: r.file ?? '', detail: r.detail ?? '', time: when(r.time) }));
  if (rows.length > MAX_ROWS) events.push({ ...tone('neu'), status_label: 'More', title: `…and ${rows.length - MAX_ROWS} more`, source: '', instance: '', file: '', detail: 'Open Reportarr to see them all.', time: '' });
  return render(read('notification.html'), {
    server_name: name, subject, preheader: `${e.summary}`, heading: e.heading(rows.length), summary: e.summary, app_url: appUrl(),
    mode_label: dryRun ? 'DRY RUN' : 'LIVE', mode_bg: dryRun ? '#fbf1df' : '#fcebe9', mode_fg: dryRun ? '#8f5d07' : '#b42318', events,
  });
}

const OUTCOME = {
  Resolved: { tone: 'ok', status_bg: '#e5f3ea', status_fg: '#157f3b', heading: (t) => (t ? `${t} is fixed` : 'Your report is fixed') },
  Denied: { tone: 'neu', status_bg: '#eceef1', status_fg: '#b42318', heading: () => "We couldn't fix this one automatically" },
  Skipped: { tone: 'neu', status_bg: '#eceef1', status_fg: '#4b5260', heading: () => "We couldn't find this file" },
};

// r: the completed row, with the reporter's details (see seerr.mjs tell())
export function reporterHtml(r, { server, subject }) {
  const o = OUTCOME[r.outcome] ?? OUTCOME.Skipped, name = server || 'Reportarr', title = r.title || r.source || 'Your report';
  return render(read('reporter.html'), {
    server_name: name, subject, preheader: r.notice, user: r.userName || 'there', title, heading: o.heading(r.title), status_label: r.outcome,
    status_bg: o.status_bg, status_fg: o.status_fg, reason: r.notice, issue_type: r.issueType ?? '', reported_at: when(r.reportedAt), issue_url: r.link ?? '',
  });
}
