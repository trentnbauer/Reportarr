import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reportarr-'));
process.env.POLL_SECONDS = '30'; // env-locked key
const { ratingKeyOf, idsOf } = await import('./app.mjs');
const { getConfig, publicConfig, saveConfig, lockedKeys } = await import('./config.mjs');

test('ratingKeyOf / idsOf parse Plex references', () => {
  assert.equal(ratingKeyOf('server://abc/com.plexapp.plugins.library/library/metadata/121709'), '121709');
  assert.equal(ratingKeyOf('nonsense'), undefined);
  assert.deepEqual(idsOf([{ id: 'tvdb://190252' }, { id: 'tmdb://178916' }]), { tvdb: '190252', tmdb: '178916' });
});

test('env wins over the UI and is reported as locked', () => {
  saveConfig({ pollSeconds: 5, maxPerDay: 3 });
  assert.equal(getConfig().pollSeconds, 30);
  assert.equal(getConfig().maxPerDay, 3);
  assert.deepEqual(lockedKeys(), ['pollSeconds']);
});

test('secrets are never exposed and blank keeps the stored one', () => {
  saveConfig({ plexToken: 'T0KEN', arrs: [{ name: 's', kind: 'sonarr', url: 'http://s:8989/', key: 'KEY' }] });
  saveConfig({ plexToken: '', arrs: [{ name: 's', kind: 'sonarr', url: 'http://s:8989', key: '' }] });
  assert.equal(getConfig().plexToken, 'T0KEN');
  assert.equal(getConfig().arrs[0].key, 'KEY');
  assert.ok(!JSON.stringify(publicConfig()).includes('T0KEN') && !JSON.stringify(publicConfig()).includes('KEY'));
  assert.equal(publicConfig().arrs[0].keySet, true);
});

test('invalid instances are rejected', () => {
  assert.throws(() => saveConfig({ arrs: [{ name: 'x', kind: 'lidarr', url: 'http://x' }] }), /invalid instance/);
});
