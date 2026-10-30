import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render, notificationHtml, reporterHtml } from '../src/email.mjs';

test('render: values are escaped, a list repeats, a section shows only when truthy, and a filled-in value is never read as a placeholder', () => {
  assert.equal(render('<b>{{x}}</b>', { x: '<i>&"\'' }), '<b>&lt;i&gt;&amp;&quot;&#39;</b>');
  assert.equal(render('{{#l}}[{{n}}]{{/l}}', { l: [{ n: 1 }, { n: 2 }] }), '[1][2]');
  assert.equal(render('{{#l}}x{{/l}}', { l: [] }), '');
  assert.equal(render('a{{#s}}[{{s}}]{{/s}}b', { s: 'yes' }), 'a[yes]b');
  assert.equal(render('a{{#s}}[{{s}}]{{/s}}b', { s: '' }), 'ab');
  assert.equal(render('{{a}} {{b}}', { a: '{{b}}', b: 'B' }), '{{b}} B', 'one pass: the text put in for a is not rendered again');
  assert.equal(render('{{#l}}{{t}}{{/l}}', { l: [{ t: '{{#l}}boom{{/l}}' }], t: 'no' }), '{{#l}}boom{{/l}}', 'nor is data inside a list');
  assert.equal(render('{{missing}}', {}), '', 'an unknown placeholder is empty');
});

test('the notification email: the server name, the batched rows, the status colours, the mode badge, and no template documentation', () => {
  const rows = [{ title: 'Show S01E01', source: 'Plex report', instance: 'sonarr', file: 'a<b>.mkv', detail: 'deleted file 1', time: '2026-10-30T10:00:00Z' }, { title: 'Film', detail: 'x' }];
  const html = notificationHtml({ event: 'replaced', rows, server: 'latte', dryRun: false, subject: '[Reportarr - latte] Replaced (2)' });
  assert.match(html, /<title>\[Reportarr - latte\] Replaced \(2\)<\/title>/);
  assert.match(html, />latte<\/span>/, 'the server name chip');
  assert.match(html, /2 files replaced/);
  assert.match(html, /Show S01E01/);
  assert.match(html, /a&lt;b&gt;\.mkv/, 'a file name is escaped');
  assert.match(html, /background:#e5f3ea;color:#157f3b/, 'Replaced is green');
  assert.match(html, /&#9679;&nbsp;LIVE/);
  assert.equal((html.match(/&#9679;&nbsp;Replaced/g) ?? []).length, 2, 'one row per event');
  assert.ok(!html.includes('{{') && !html.includes('Mustache-style placeholders'), 'no placeholder left and the documentation comment is gone');
  assert.match(html, /<!--\[if mso\]>/, 'the Outlook conditionals stay');
  assert.match(notificationHtml({ event: 'failed', rows, server: '', dryRun: true, subject: 's' }), /DRY RUN/);
  assert.match(notificationHtml({ event: 'failed', rows, server: '', dryRun: true, subject: 's' }), /background:#fcebe9;color:#b42318/, 'Failed is red');
  assert.match(notificationHtml({ event: 'failed', rows, server: '', dryRun: true, subject: 's' }), />Reportarr<\/span>/, 'no server name: Reportarr');
});

test('the Open Reportarr button is there only when BASE_URL is a full address', () => {
  const was = process.env.BASE_URL;
  try {
    process.env.BASE_URL = 'https://media.example.com/reportarr';
    assert.match(notificationHtml({ event: 'replaced', rows: [{ title: 't' }], subject: 's' }), /href="https:\/\/media\.example\.com\/reportarr"[^>]*>Open Reportarr/);
    process.env.BASE_URL = '/reportarr';
    assert.ok(!notificationHtml({ event: 'replaced', rows: [{ title: 't' }], subject: 's' }).includes('Open Reportarr'));
  } finally { if (was === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = was; }
});

test('a batch of hundreds is capped in the HTML, and says how many more there were', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ title: `T${i}` }));
  const html = notificationHtml({ event: 'replaced', rows, subject: 's' });
  assert.match(html, /120 files replaced/);
  assert.equal((html.match(/&#9679;&nbsp;Replaced/g) ?? []).length, 50);
  assert.match(html, /and 70 more/);
});

test('the reporter email: the outcome, the reason, the details, the link, and the right colours for each outcome', () => {
  const row = { outcome: 'Denied', notice: 'Series report. Report a season or 1 file.', title: '', source: 'Overseerr issue #9 · video', userName: 'Erin <3', issueType: 'Video', reportedAt: '2026-10-29T10:14:00Z', link: 'http://seerr/issues/9' };
  const html = reporterHtml(row, { server: 'latte', subject: '[Reportarr - latte] Denied' });
  assert.match(html, /We couldn&#39;t fix this one automatically/);
  assert.match(html, /Series report\. Report a season or 1 file\./);
  assert.match(html, /Hi Erin &lt;3, thanks for reporting a problem on latte\./, 'the name is escaped');
  assert.match(html, /Overseerr issue #9 · video/, 'a report with no title is named by its source');
  assert.match(html, />Video<\/td>/);
  assert.match(html, /href="http:\/\/seerr\/issues\/9"[^>]*>View your report/);
  assert.match(html, /background:#eceef1;color:#b42318/);
  const done = reporterHtml({ ...row, outcome: 'Resolved', title: 'Show S01E01', notice: 'The file was replaced and the new one is ready.' }, { server: 'latte', subject: 's' });
  assert.match(done, /Show S01E01 is fixed/);
  assert.match(done, /background:#e5f3ea;color:#157f3b/);
  assert.match(reporterHtml({ ...row, outcome: 'Skipped' }, { subject: 's' }), /We couldn&#39;t find this file/);
  assert.ok(!reporterHtml({ ...row, link: '' }, { subject: 's' }).includes('View your report'), 'no link, no button');
  assert.ok(!html.includes('{{'));
});

test('your own templates: EMAIL_TEMPLATE_DIR overrides a template, and a file missing there falls back to the built-in one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-tpl-'));
  fs.writeFileSync(path.join(dir, 'reporter.html'), '<!-- doc --><p>{{status_label}} for {{user}}</p>');
  const was = process.env.EMAIL_TEMPLATE_DIR;
  try {
    process.env.EMAIL_TEMPLATE_DIR = dir;
    assert.equal(reporterHtml({ outcome: 'Resolved', notice: 'n', userName: 'Bo' }, { subject: 's' }), '<p>Resolved for Bo</p>');
    assert.match(notificationHtml({ event: 'replaced', rows: [{ title: 't' }], subject: 's' }), /Reportarr/, 'the notification template is the built-in one');
  } finally { if (was === undefined) delete process.env.EMAIL_TEMPLATE_DIR; else process.env.EMAIL_TEMPLATE_DIR = was; }
});
