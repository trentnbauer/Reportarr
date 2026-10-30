import test from 'node:test';
import assert from 'node:assert/strict';

const { LISTS, kindsMeta, CLIENT_BY_IMPLEMENTATION } = await import('../src/integrations/index.mjs');

// What the core relies on from every integration. A new integration is one file that satisfies this and is listed in
// src/integrations/index.mjs; the settings, environment variables, Test button and web UI then follow from it.
const COMMON = ['kind', 'label', 'prefix', 'defaultUrl', 'fields', 'defaults', 'fromEnv', 'check', 'checkArgs'];
const NEEDS = {
  sources: ['envLines', 'legacy', 'normalize', 'isConfigured', 'fetch', 'label', 'replace'],
  arrs: ['api', 'appName', 'envLines', 'normalize', 'plan'],
  clients: ['implementation', 'prioritize', 'legacy'],
  notifications: ['envLines', 'normalize', 'isConfigured', 'send', 'validate', 'switches'], // not an address, so no defaultUrl or url field
};

for (const [list, mods] of Object.entries(LISTS)) {
  for (const [kind, m] of Object.entries(mods)) {
    test(`${list}/${kind} declares what the core needs`, () => {
      assert.equal(m.kind, kind, 'registered under its own kind');
      for (const k of [...COMMON.filter((k) => list !== 'notifications' || k !== 'defaultUrl'), ...NEEDS[list]]) assert.ok(m[k] !== undefined, `${kind}.${k}`);
      assert.ok(m.fields.every((f) => f.name && f.label), 'every field has a name and a label');
      if (list !== 'notifications') assert.ok(m.fields.some((f) => f.name === 'url'), 'a card always has a URL');
      assert.equal(typeof m.fromEnv({}), 'object');
      assert.deepEqual(m.fromEnv({}), [], 'nothing configured means nothing returned');
      assert.ok(Array.isArray(m.fromEnv({})));
    });
  }
}

test('an *arr app says how to find a reported file (or an issue) and how to replace it', () => {
  for (const m of Object.values(LISTS.arrs)) assert.ok(m.fromPlex || m.fromIssue, `${m.kind} can find something`);
  const plan = LISTS.arrs.sonarr.plan({ ep: { id: 7 } });
  assert.deepEqual(Object.keys(plan).sort(), ['check', 'cmd', 'del', 'hist', 'match']);
  assert.equal(plan.del(3), '/episodefile/3');
  assert.equal(plan.check, '/episode/7');
  assert.deepEqual([LISTS.arrs.radarr.plan({ movie: { id: 1 } }).del(2), LISTS.arrs.lidarr.plan({ albumId: 9 }).del(2)], ['/moviefile/2', '/trackfile/2']);
});

test('the UI is told every kind, with its label, fields and defaults, so it hard-codes no app names', () => {
  const meta = kindsMeta();
  assert.deepEqual(Object.keys(meta), ['sources', 'arrs', 'clients', 'notifications']);
  assert.deepEqual(Object.keys(meta.notifications), ['discord', 'smtp']);
  assert.deepEqual(Object.keys(meta.sources), ['plex', 'seerr']);
  assert.deepEqual(Object.keys(meta.arrs), ['sonarr', 'radarr', 'lidarr']);
  assert.deepEqual(Object.keys(meta.clients), ['qbittorrent', 'sabnzbd']);
  for (const kinds of Object.values(meta)) for (const [k, m] of Object.entries(kinds)) assert.ok(typeof m.label === 'string' && m.label, `${k} has a name to show`);
  assert.equal(meta.sources.seerr.switches[0].name, 'resolve');
  assert.deepEqual(meta.sources.seerr.defaults, { issueTypes: 'video,audio,other', resolve: true, wholeSeries: true });
  assert.ok(!JSON.stringify(meta).includes('function'), 'plain data only');
});

test('a download client is found from the name the *arr gives it', () => {
  assert.equal(CLIENT_BY_IMPLEMENTATION.QBittorrent.kind, 'qbittorrent');
  assert.equal(CLIENT_BY_IMPLEMENTATION.Sabnzbd.kind, 'sabnzbd');
});
