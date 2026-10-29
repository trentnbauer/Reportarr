// Settings come from env (compose) and /data/config.json (web UI). Env wins and is shown read-only in the UI.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR ?? '/data';
const FILE = path.join(DATA_DIR, 'config.json');
const e = process.env;

// The apps Reportarr can replace files in. Lidarr's API is v1, the others v3.
export const ARR_KINDS = ['sonarr', 'radarr', 'lidarr'];
export const ARR_API = { sonarr: 'v3', radarr: 'v3', lidarr: 'v1' };
export const SOURCE_KINDS = ['plex', 'seerr']; // where reports come from: Plex "Reported Issues", Overseerr/Seerr issues
export const CLIENT_KINDS = ['qbittorrent', 'sabnzbd'];
export const ISSUE_TYPES = ['video', 'audio', 'subtitles', 'other'];
const DEFAULT_TYPES = 'video,audio,other';

const DEFAULTS = {
  pollSeconds: 60, maxPerDay: 20, dryRun: true,
  // [{name, kind: 'plex'|'seerr', url, key, issueTypes, resolve}]: issueTypes and resolve only apply to seerr
  sources: [],
  // [{name, kind: 'sonarr'|'radarr'|'lidarr', url, key}]
  arrs: [],
  // [{name, kind: 'qbittorrent'|'sabnzbd', url, username, password, apiKey, default}], matched to the arr's client by
  // host:port or name; a `default` one (the old single QBIT_*/SAB_* settings) is used when none matches
  clients: [],
};

const trim = (u) => String(u ?? '').trim().replace(/\/+$/, '');
export const normalizeTypes = (v) => {
  const t = String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s, i, a) => ISSUE_TYPES.includes(s) && a.indexOf(s) === i);
  return (t.length ? t : DEFAULT_TYPES.split(',')).join(',');
};

// The numbers n for which PREFIX_n_URL, _KEY or _NAME is set, in order: PLEX_2_URL gives 2.
const numbers = (K) => [...new Set(Object.keys(e).map((k) => k.match(new RegExp(`^${K}_(\\d+)_(?:URL|KEY|NAME)$`))?.[1]).filter(Boolean))].sort((a, b) => a - b);

// Instances come from numbered variables, any number of them: SONARR_1_URL, SONARR_1_KEY, SONARR_2_URL, ... and the same for RADARR.
// An optional SONARR_1_NAME sets the display name. The same works for LIDARR_N_*. Unnumbered SONARR_URL/SONARR_KEY still work, and so does the older ARRS JSON.
function arrsFromEnv() {
  const out = [];
  for (const kind of ARR_KINDS) {
    const K = kind.toUpperCase();
    const ids = new Set(Object.keys(e).map((k) => k.match(new RegExp(`^${K}_(?:(\\d+)_)?URL$`))).filter(Boolean).map((m) => m[1] ?? ''));
    for (const n of [...ids].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a - b))) {
      const p = n === '' ? K : `${K}_${n}`;
      if (e[`${p}_URL`]) out.push({ name: e[`${p}_NAME`] || (n === '' ? kind : `${kind}-${n}`), kind, url: e[`${p}_URL`].replace(/\/$/, ''), key: e[`${p}_KEY`] ?? '' });
    }
  }
  return [...(e.ARRS ? JSON.parse(e.ARRS) : []), ...out];
}

// Report sources: PLEX_URL + PLEX_KEY (or PLEX_TOKEN) is one Plex server, PLEX_2_URL/PLEX_2_KEY/PLEX_2_NAME are more;
// OVERSEERR_URL/OVERSEERR_KEY is one Overseerr/Seerr, OVERSEERR_2_URL/KEY/NAME/ISSUE_TYPES/RESOLVE are more.
function sourcesFromEnv() {
  const out = [];
  const plexKey = e.PLEX_KEY || e.PLEX_TOKEN;
  if (plexKey) out.push({ name: e.PLEX_NAME || 'plex', kind: 'plex', url: trim(e.PLEX_URL || 'http://plex:32400'), key: plexKey });
  for (const n of numbers('PLEX')) {
    const p = `PLEX_${n}`;
    if (e[`${p}_URL`]) out.push({ name: e[`${p}_NAME`] || `plex-${n}`, kind: 'plex', url: trim(e[`${p}_URL`]), key: e[`${p}_KEY`] ?? e[`${p}_TOKEN`] ?? '' });
  }
  if (e.OVERSEERR_URL) out.push({ name: e.OVERSEERR_NAME || 'overseerr', kind: 'seerr', url: trim(e.OVERSEERR_URL), key: e.OVERSEERR_KEY || e.OVERSEERR_API_KEY || '', issueTypes: normalizeTypes(e.OVERSEERR_ISSUE_TYPES), resolve: e.OVERSEERR_RESOLVE !== 'false' });
  for (const n of numbers('OVERSEERR')) {
    const p = `OVERSEERR_${n}`;
    if (e[`${p}_URL`]) out.push({ name: e[`${p}_NAME`] || `seerr-${n}`, kind: 'seerr', url: trim(e[`${p}_URL`]), key: e[`${p}_KEY`] ?? '', issueTypes: normalizeTypes(e[`${p}_ISSUE_TYPES`]), resolve: e[`${p}_RESOLVE`] !== 'false' });
  }
  return out;
}

// Download clients: CLIENTS is a JSON list. The older single QBIT_* and SAB_* settings become one read-only client each, used
// as the default for any client of that kind not matched by address (a blank URL means "the host the arr has for it").
function clientsFromEnv() {
  const out = e.CLIENTS ? JSON.parse(e.CLIENTS) : [];
  if (e.QBIT_URL || e.QBIT_USERNAME || e.QBIT_PASSWORD) out.push({ name: 'qbittorrent', kind: 'qbittorrent', url: trim(e.QBIT_URL), username: e.QBIT_USERNAME ?? '', password: e.QBIT_PASSWORD ?? '', apiKey: '', default: true });
  if (e.SAB_URL || e.SAB_API_KEY) out.push({ name: 'sabnzbd', kind: 'sabnzbd', url: trim(e.SAB_URL), username: '', password: '', apiKey: e.SAB_API_KEY ?? '', default: true });
  return out;
}

const ENV = {
  pollSeconds: e.POLL_SECONDS && +e.POLL_SECONDS, maxPerDay: e.MAX_PER_DAY && +e.MAX_PER_DAY,
  dryRun: e.DRY_RUN && e.DRY_RUN !== 'false',
  sources: sourcesFromEnv(), arrs: arrsFromEnv(), clients: clientsFromEnv(),
};
const fromEnv = () => Object.entries(ENV).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));

// Settings saved by older versions (single Plex, Overseerr, default qBittorrent/SABnzbd) are read as list entries.
const LEGACY = ['plexUrl', 'plexToken', 'overseerrUrl', 'overseerrKey', 'overseerrTypes', 'overseerrResolve', 'qbitUrl', 'qbitUsername', 'qbitPassword', 'sabUrl', 'sabApiKey'];
function migrate(file) {
  if (!LEGACY.some((k) => k in file)) return file;
  const f = { ...file }, sources = [...(f.sources ?? [])], clients = [...(f.clients ?? [])];
  if (f.plexToken) sources.unshift({ name: 'plex', kind: 'plex', url: trim(f.plexUrl || 'http://plex:32400'), key: f.plexToken });
  if (f.overseerrUrl) sources.push({ name: 'overseerr', kind: 'seerr', url: trim(f.overseerrUrl), key: f.overseerrKey ?? '', issueTypes: normalizeTypes(f.overseerrTypes), resolve: f.overseerrResolve !== false });
  if (f.qbitUrl || f.qbitUsername || f.qbitPassword) clients.push({ name: 'qbittorrent', kind: 'qbittorrent', url: trim(f.qbitUrl), username: f.qbitUsername ?? '', password: f.qbitPassword ?? '', apiKey: '', default: true });
  if (f.sabUrl || f.sabApiKey) clients.push({ name: 'sabnzbd', kind: 'sabnzbd', url: trim(f.sabUrl), username: '', password: '', apiKey: f.sabApiKey ?? '', default: true });
  for (const k of LEGACY) delete f[k];
  return { ...f, sources, clients };
}
const readFile = () => { try { return migrate(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { return {}; } };

export const hasFileConfig = () => Object.keys(readFile()).length > 0;

// The lists merge instead of locking: what the environment defines is read-only, and anything added in the UI is kept
// next to it (an environment entry wins if a name is used twice).
const LISTS = ['sources', 'arrs', 'clients'];
const envList = (k) => (Array.isArray(ENV[k]) ? ENV[k] : []);
const merge = (fromEnvList, fromFile = []) => [...fromEnvList, ...fromFile.filter((f) => !fromEnvList.some((e2) => e2.name === f.name))];
const envNames = (k) => envList(k).map((x) => x.name);
export const lockedKeys = () => fromEnv().map(([k]) => k).filter((k) => !LISTS.includes(k));
export const getConfig = () => {
  const file = readFile();
  return { ...DEFAULTS, ...file, ...Object.fromEntries(fromEnv()), sources: merge(envList('sources'), file.sources), arrs: merge(envList('arrs'), file.arrs), clients: merge(envList('clients'), file.clients) };
};

// Secrets never leave the server; the UI only learns whether one is set.
export function publicConfig() {
  const c = getConfig();
  return {
    pollSeconds: c.pollSeconds, maxPerDay: c.maxPerDay, dryRun: c.dryRun,
    sources: c.sources.map(({ key, ...s }) => ({ ...s, keySet: !!key, fromEnv: envNames('sources').includes(s.name) })),
    arrs: c.arrs.map(({ key, ...a }) => ({ ...a, keySet: !!key, fromEnv: envNames('arrs').includes(a.name) })),
    clients: c.clients.map(({ password, apiKey, ...x }) => ({ ...x, passwordSet: !!password, apiKeySet: !!apiKey, fromEnv: envNames('clients').includes(x.name) })),
  };
}

// names must be unique, and must not reuse one set by an environment variable (those are read-only here)
function uniqueNames(list = [], k, what) {
  const seen = new Set(envNames(k));
  for (const x of list) {
    if (seen.has(x.name)) throw new Error(`${what} name "${x.name}" is already used${envNames(k).includes(x.name) ? ' by one set in the environment' : ''}: pick another`);
    seen.add(x.name);
  }
}
const isUrl = (u) => /^https?:\/\//.test(u);

export function validate(patch) {
  uniqueNames(patch.sources, 'sources', 'source');
  uniqueNames(patch.arrs, 'arrs', 'instance');
  uniqueNames(patch.clients, 'clients', 'download client');
  for (const s of patch.sources ?? []) {
    if (!s.name || !SOURCE_KINDS.includes(s.kind) || !isUrl(s.url)) throw new Error(`invalid source "${s.name ?? ''}": needs name, kind plex|seerr and an http(s) url`);
  }
  for (const x of patch.clients ?? []) {
    if (!x.name || !CLIENT_KINDS.includes(x.kind) || !(isUrl(x.url) || (x.default && !x.url))) {
      throw new Error(`invalid download client "${x.name ?? ''}": needs name, kind qbittorrent|sabnzbd and an http(s) url`);
    }
  }
  for (const a of patch.arrs ?? []) {
    if (!a.name || !ARR_KINDS.includes(a.kind) || !isUrl(a.url)) throw new Error(`invalid instance "${a.name ?? ''}": needs name, kind sonarr|radarr|lidarr and an http(s) url`);
  }
  if ('pollSeconds' in patch && !(Number.isInteger(+patch.pollSeconds) && +patch.pollSeconds >= 10 && +patch.pollSeconds <= 86400)) throw new Error('poll interval must be a whole number of seconds from 10 to 86400');
  if ('maxPerDay' in patch && !(Number.isInteger(+patch.maxPerDay) && +patch.maxPerDay >= 0 && +patch.maxPerDay <= 10000)) throw new Error('max replacements per day must be a whole number from 0 to 10000');
}

export function saveConfig(patch) {
  validate(patch);
  const file = readFile();
  const cur = { ...file };
  const locked = new Set(lockedKeys());
  if ('pollSeconds' in patch && !locked.has('pollSeconds')) cur.pollSeconds = +patch.pollSeconds;
  if ('maxPerDay' in patch && !locked.has('maxPerDay')) cur.maxPerDay = +patch.maxPerDay;
  if ('dryRun' in patch && !locked.has('dryRun')) cur.dryRun = !!patch.dryRun;
  // only the UI-added entries are stored; the environment's stay in the environment. A blank secret keeps the stored one.
  const keep = (list, name) => (list ?? []).find((o) => o.name === name);
  if (patch.sources) {
    cur.sources = patch.sources.map((s) => ({
      name: s.name, kind: s.kind, url: trim(s.url), key: s.key || keep(file.sources, s.name)?.key || '',
      ...(s.kind === 'seerr' ? { issueTypes: normalizeTypes(s.issueTypes), resolve: s.resolve !== false } : {}),
    }));
  }
  if (patch.arrs) cur.arrs = patch.arrs.map((a) => ({ name: a.name, kind: a.kind, url: trim(a.url), key: a.key || keep(file.arrs, a.name)?.key || '' }));
  if (patch.clients) {
    cur.clients = patch.clients.map((x) => {
      const o = keep(file.clients, x.name);
      return { name: x.name, kind: x.kind, url: trim(x.url), username: x.username ?? '', password: x.password || o?.password || '', apiKey: x.apiKey || o?.apiKey || '', ...(x.default ? { default: true } : {}) };
    });
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cur, null, 2), { mode: 0o600 }); // holds API keys and passwords
}

// The effective settings as a .env file for docker compose, so UI-configured settings can be moved into the compose setup.
const q = (v) => {
  v = String(v ?? '');
  if (/^[A-Za-z0-9_.\/:@%+,=-]*$/.test(v)) return v;
  return v.includes("'") ? `"${v.replace(/[\\"$]/g, '\\$&')}"` : `'${v}'`;
};
export function envFile(c = getConfig()) {
  const L = ['# Reportarr settings, exported from the web UI. Contains secrets: keep it private and never commit it.', '# Save as .env next to docker-compose.yml.', ''];
  const add = (k, v) => L.push(`${k}=${q(v)}`);
  c.sources.filter((s) => s.kind === 'plex').forEach((s, i) => {
    L.push('', `# ${s.name}`); add(`PLEX_${i + 1}_NAME`, s.name); add(`PLEX_${i + 1}_URL`, s.url); add(`PLEX_${i + 1}_KEY`, s.key);
  });
  c.sources.filter((s) => s.kind === 'seerr').forEach((s, i) => {
    const p = `OVERSEERR_${i + 1}`;
    L.push('', `# ${s.name}`); add(`${p}_NAME`, s.name); add(`${p}_URL`, s.url); add(`${p}_KEY`, s.key); add(`${p}_ISSUE_TYPES`, s.issueTypes ?? DEFAULT_TYPES); add(`${p}_RESOLVE`, s.resolve !== false);
  });
  for (const kind of ARR_KINDS) {
    c.arrs.filter((a) => a.kind === kind).forEach((a, i) => {
      L.push('', `# ${a.name}`);
      add(`${kind.toUpperCase()}_${i + 1}_NAME`, a.name); add(`${kind.toUpperCase()}_${i + 1}_URL`, a.url); add(`${kind.toUpperCase()}_${i + 1}_KEY`, a.key);
    });
  }
  L.push(''); add('DRY_RUN', c.dryRun); add('POLL_SECONDS', c.pollSeconds); add('MAX_PER_DAY', c.maxPerDay);
  if (c.clients.length) { L.push(''); add('CLIENTS', JSON.stringify(c.clients)); }
  L.push('', '# Not stored by the UI: set these yourself.', 'WEB_UI=8080', 'UI_USERNAME=', 'UI_PASSWORD=', '');
  return L.join('\n');
}
