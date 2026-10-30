// Settings come from env (compose) and /data/config.json (web UI). Env wins and is shown read-only in the UI.
// This file knows nothing about any particular app: each integration (src/integrations/) declares how it reads
// its environment variables, saves its settings and exports them, and this file loops over them.
import fs from 'node:fs';
import path from 'node:path';
import { trim, writeFileAtomic, log } from './util.mjs';
import { LISTS } from './integrations/index.mjs';

export const DATA_DIR = process.env.DATA_DIR ?? '/data';
const FILE = path.join(DATA_DIR, 'config.json');
const e = process.env;
if (e.MAX_PER_DAY && !e.MAX_PER_HOUR) log('MAX_PER_DAY is no longer used: the limit is per hour now. Set MAX_PER_HOUR (default 10).');

const DEFAULTS = {
  pollSeconds: 60, maxPerHour: 10, dryRun: true,
  hideLoginWarning: false, // hide the "No login is set" banner in the web UI
  // [{name, kind, url, ...}]: report sources (Plex, Overseerr/Seerr), *arr instances, download clients.
  // Each entry's kind names an integration; what an entry holds is declared by that integration.
  sources: [], arrs: [], clients: [],
  notifications: [], // Discord and email channels: where to tell people what happened
};
const LIST_NAMES = Object.keys(LISTS);
const mods = (list) => Object.values(LISTS[list]);
// secret fields per list: never sent to the browser, and kept when the UI sends them blank
const SECRET_FIELDS = { sources: ['key'], arrs: ['key'], clients: ['password', 'apiKey'], notifications: ['webhook', 'password'] };

// ---- the environment
const fromEnvVars = {
  sources: () => mods('sources').flatMap((m) => m.fromEnv(e)),
  // ARRS is the older way: a JSON list of instances
  arrs: () => [...(e.ARRS ? JSON.parse(e.ARRS) : []), ...mods('arrs').flatMap((m) => m.fromEnv(e))],
  // CLIENTS is a JSON list; the older single-client variables (QBIT_*, SAB_*) become one read-only default each
  clients: () => [...(e.CLIENTS ? JSON.parse(e.CLIENTS) : []), ...mods('clients').flatMap((m) => m.fromEnv(e))],
  notifications: () => mods('notifications').flatMap((m) => m.fromEnv(e)),
};
const ENV = {
  pollSeconds: e.POLL_SECONDS && +e.POLL_SECONDS, maxPerHour: e.MAX_PER_HOUR && +e.MAX_PER_HOUR,
  dryRun: e.DRY_RUN && e.DRY_RUN !== 'false',
  hideLoginWarning: e.HIDE_LOGIN_WARNING && e.HIDE_LOGIN_WARNING !== 'false',
  ...Object.fromEntries(LIST_NAMES.map((l) => [l, fromEnvVars[l]()])),
};
const fromEnv = () => Object.entries(ENV).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
const envList = (l) => (Array.isArray(ENV[l]) ? ENV[l] : []);
const envNames = (l) => envList(l).map((x) => x.name);

// ---- the saved file. Settings saved by older versions (a single Plex, Overseerr, default qBittorrent/SABnzbd, as flat keys)
// are read as list entries, so upgrading keeps working; they are dropped from the file the next time settings are saved.
function migrate(file) {
  const keys = LIST_NAMES.flatMap((l) => mods(l).flatMap((m) => m.legacy?.keys ?? []));
  if (!keys.some((k) => k in file)) return file;
  const out = { ...file };
  for (const l of LIST_NAMES) out[l] = [...(file[l] ?? []), ...mods(l).flatMap((m) => m.legacy?.entries(file) ?? [])];
  for (const k of keys) delete out[k];
  return out;
}
const readFile = () => { try { return migrate(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { return {}; } };
export const hasFileConfig = () => Object.keys(readFile()).length > 0;

// ---- effective settings. The lists merge instead of locking: what the environment defines is read-only, and anything
// added in the UI is kept next to it (an environment entry wins if a name is used twice).
const merge = (fromEnvList, fromFile = []) => [...fromEnvList, ...fromFile.filter((f) => !fromEnvList.some((e2) => e2.name === f.name))];
export const lockedKeys = () => fromEnv().map(([k]) => k).filter((k) => !LIST_NAMES.includes(k));
export const getConfig = () => {
  const file = readFile();
  return { ...DEFAULTS, ...file, ...Object.fromEntries(fromEnv()), ...Object.fromEntries(LIST_NAMES.map((l) => [l, merge(envList(l), file[l])])) };
};

// Secrets never leave the server; the UI only learns whether one is set.
export function publicConfig() {
  const c = getConfig();
  const out = { pollSeconds: c.pollSeconds, maxPerHour: c.maxPerHour, dryRun: c.dryRun, hideLoginWarning: c.hideLoginWarning };
  for (const l of LIST_NAMES) {
    out[l] = c[l].map((x) => {
      const pub = { ...x };
      for (const f of SECRET_FIELDS[l]) { delete pub[f]; pub[`${f}Set`] = !!x[f]; }
      return { ...pub, fromEnv: envNames(l).includes(x.name) };
    });
  }
  return out;
}

// ---- saving
const WHAT = { sources: 'source', arrs: 'instance', clients: 'download client', notifications: 'notification channel' };
const isUrl = (u) => /^https?:\/\//.test(u);

export function validate(patch) {
  for (const l of LIST_NAMES) {
    const seen = new Set(envNames(l)); // names must be unique, and must not reuse one set by an environment variable
    for (const x of patch[l] ?? []) {
      if (seen.has(x.name)) throw new Error(`${WHAT[l]} name "${x.name}" is already used${envNames(l).includes(x.name) ? ' by one set in the environment' : ''}: pick another`);
      seen.add(x.name);
      const m = Object.hasOwn(LISTS[l], x.kind) && LISTS[l][x.kind];
      if (m?.validate) { // a kind that is not an address (email) checks its own settings
        const bad = x.name ? m.validate(x) : 'needs a name';
        if (bad) throw new Error(`invalid ${WHAT[l]} "${x.name ?? ''}": ${bad}`);
        continue;
      }
      const blankOk = l === 'clients' && x.default && !x.url; // a default client may leave the address to the *arr
      if (!x.name || !m || !(isUrl(x.url) || blankOk)) {
        throw new Error(`invalid ${WHAT[l]} "${x.name ?? ''}": needs a name, a kind (${Object.keys(LISTS[l]).join('|')}) and an http(s) url`);
      }
    }
  }
  if ('pollSeconds' in patch && !(Number.isInteger(+patch.pollSeconds) && +patch.pollSeconds >= 10 && +patch.pollSeconds <= 86400)) throw new Error('poll interval must be a whole number of seconds from 10 to 86400');
  if ('maxPerHour' in patch && !(Number.isInteger(+patch.maxPerHour) && +patch.maxPerHour >= 0 && +patch.maxPerHour <= 10000)) throw new Error('max replacements per hour must be a whole number from 0 to 10000');
}

// the stored shape of an entry: an integration may define its own, otherwise all its fields are kept
const normalizeEntry = (l, x, old) => {
  const m = LISTS[l][x.kind];
  if (m.normalize) return m.normalize(x, old);
  const out = { name: x.name, kind: x.kind, url: trim(x.url), username: x.username ?? '', ...(x.default ? { default: true } : {}) };
  for (const f of SECRET_FIELDS[l]) out[f] = x[f] || old?.[f] || ''; // blank keeps the stored secret
  return out;
};

export function saveConfig(patch) {
  validate(patch);
  const file = readFile(), cur = { ...file }, locked = new Set(lockedKeys());
  if ('pollSeconds' in patch && !locked.has('pollSeconds')) cur.pollSeconds = +patch.pollSeconds;
  if ('maxPerHour' in patch && !locked.has('maxPerHour')) cur.maxPerHour = +patch.maxPerHour;
  delete cur.maxPerDay; // the old per-day limit is not used any more
  for (const k of ['dryRun', 'hideLoginWarning']) if (k in patch && !locked.has(k)) cur[k] = !!patch[k];
  // only the UI-added entries are stored; the environment's stay in the environment
  for (const l of LIST_NAMES) {
    if (patch[l]) cur[l] = patch[l].map((x) => normalizeEntry(l, x, (file[l] ?? []).find((o) => o.name === x.name)));
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(FILE, JSON.stringify(cur, null, 2), { mode: 0o600 }); // holds API keys and passwords
}

// ---- export: the effective settings as a .env file for docker compose, so UI-configured settings can be moved into the compose setup
const q = (v) => {
  v = String(v ?? '');
  if (/^[A-Za-z0-9_.\/:@%+,=-]*$/.test(v)) return v;
  return v.includes("'") ? `"${v.replace(/[\\"$]/g, '\\$&')}"` : `'${v}'`;
};
export function envFile(c = getConfig()) {
  const L = ['# Reportarr settings, exported from the web UI. Contains secrets: keep it private and never commit it.', '# Save as .env next to docker-compose.yml.', ''];
  const add = (k, v) => L.push(`${k}=${q(v)}`);
  for (const l of ['sources', 'arrs', 'notifications']) {
    for (const m of mods(l)) {
      c[l].filter((x) => x.kind === m.kind).forEach((x, i) => { L.push('', `# ${x.name}`); for (const [k, v] of m.envLines(x, i + 1)) add(k, v); });
    }
  }
  L.push(''); add('DRY_RUN', c.dryRun); add('POLL_SECONDS', c.pollSeconds); add('MAX_PER_HOUR', c.maxPerHour); add('HIDE_LOGIN_WARNING', c.hideLoginWarning);
  if (c.clients.length) { L.push(''); add('CLIENTS', JSON.stringify(c.clients)); }
  L.push('', '# Not stored by the UI: set these yourself.', 'WEB_UI=8080', 'UI_USERNAME=', 'UI_PASSWORD=', '');
  return L.join('\n');
}
