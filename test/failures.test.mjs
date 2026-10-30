import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-fail-'));
const { clearFailures, dismissFailures, changesFile } = await import('../src/engine.mjs');

const NOW = Date.parse('2026-10-30T12:00:00Z');
const at = (h) => new Date(NOW - h * 3600_000).toISOString();
const row = (id, h, status, o = {}) => ({ id, time: at(h), status, reportId: 'overseerr:6', ...o });
const PRIORITY = 'priority failed: qBittorrent password for qbit is hidden by the arr';
const dismissed = (rows, id) => rows.find((r) => r.id === id).dismissed;

test('a failed queue priority clears when that item is later moved, or arrives', () => {
  const rows = [
    row('a', 5, 'error', { title: 'Show S01E01', instance: 'sonarr', detail: PRIORITY }),
    row('b', 4, 'prioritized', { title: 'Show S01E01', instance: 'sonarr', reportId: undefined }), // the prioritize step logs no report id
    row('c', 5, 'error', { title: 'Show S01E02', instance: 'sonarr', detail: PRIORITY }),
    row('d', 4, 'prioritized', { title: 'Show S01E03', instance: 'sonarr' }),
    row('e', 5, 'error', { title: 'Show S01E04', instance: 'sonarr', detail: PRIORITY }),
    row('f', 2, 'imported', { title: 'Show S01E04', instance: 'sonarr' }),
  ];
  assert.equal(clearFailures(rows, NOW), true);
  assert.equal(dismissed(rows, 'a'), 'fixed');
  assert.equal(dismissed(rows, 'c'), undefined, 'another episode being moved does not fix this one');
  assert.equal(dismissed(rows, 'e'), 'fixed', 'it arrived, so moving it up the queue no longer matters');
});

test('a failed report clears when the same report later gets through; an earlier success does not count', () => {
  const rows = [
    row('x0', 9, 'replaced', { title: 'Film' }),
    row('x1', 8, 'error', { title: 'Film', detail: 'DELETE /moviefile/5 500' }),
    row('y1', 8, 'error', { reportId: 'overseerr:7', detail: 'DELETE /moviefile/6 500' }),
    row('y2', 7, 'replaced', { reportId: 'overseerr:7', title: 'Other' }),
  ];
  clearFailures(rows, NOW);
  assert.equal(dismissed(rows, 'x1'), undefined);
  assert.equal(dismissed(rows, 'y1'), 'fixed');
});

test('pressing Retry clears the old failure, and old ones expire after 7 days', () => {
  const rows = [
    row('r1', 3, 'error', { detail: 'DELETE /moviefile/5 500', retried: true }),
    row('o1', 24 * 7 + 1, 'error', { reportId: undefined, detail: 'old' }),
    row('n1', 24 * 6, 'error', { reportId: undefined, detail: 'recent' }),
  ];
  clearFailures(rows, NOW);
  assert.equal(dismissed(rows, 'r1'), 'retried');
  assert.equal(dismissed(rows, 'o1'), 'expired');
  assert.equal(dismissed(rows, 'n1'), undefined);
  assert.equal(clearFailures(rows, NOW), false, 'nothing left to change');
});

test('Dismiss clears one failure or all of them, and only failures', () => {
  const rows = [row('f1', 1, 'error', { detail: 'x' }), row('f2', 1, 'error', { detail: 'y' }), row('ok', 1, 'replaced')];
  fs.writeFileSync(changesFile(), JSON.stringify(rows));
  assert.equal(dismissFailures('f1'), 1);
  assert.equal(dismissFailures('ok'), 0, 'a row that is not a failure is left alone');
  assert.equal(dismissFailures('nope'), 0);
  assert.equal(dismissFailures('all'), 1, 'f1 is already dismissed');
  const saved = JSON.parse(fs.readFileSync(changesFile(), 'utf8'));
  assert.deepEqual(saved.map((r) => r.dismissed), ['manual', 'manual', undefined]);
});
