// Settings come from env (compose) and /data/config.json (web UI). Env wins and is shown read-only in the UI.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR ?? '/data';
const FILE = path.join(DATA_DIR, 'config.json');
const e = process.env;

export const SECRETS = ['plexToken', 'qbitPassword', 'sabApiKey', 'overseerrKey'];
const DEFAULTS = {
  plexUrl: 'http://plex:32400', plexToken: '', pollSeconds: 60, maxPerDay: 20, dryRun: true,
  // Overseerr/Seerr issues are a second source of reports. Types: video, audio, subtitles, other.
  overseerrUrl: '', overseerrKey: '', overseerrTypes: 'video,audio,other', overseerrResolve: true,
  // [{name, kind: 'sonarr'|'radarr', url, key}]
  arrs: [],
  // [{name, kind: 'qbittorrent'|'sabnzbd', url, username, password, apiKey}], matched to the arr's client by host:port or name
  clients: [],
  // default client per kind, used when no entry in `clients` matches (single-client setups)
  qbitUrl: '', qbitUsername: '', qbitPassword: '', sabUrl: '', sabApiKey: '',
};
// Instances come from numbered variables, any number of them: SONARR_1_URL, SONARR_1_KEY, SONARR_2_URL, ... and the same for RADARR.
// An optional SONARR_1_NAME sets the display name. Unnumbered SONARR_URL/SONARR_KEY still work, and so does the older ARRS JSON.
function arrsFromEnv() {
  const out = [];
  for (const kind of ['sonarr', 'radarr']) {
    const K = kind.toUpperCase();
    const ids = new Set(Object.keys(e).map((k) => k.match(new RegExp(`^${K}_(?:(\\d+)_)?URL$`))).filter(Boolean).map((m) => m[1] ?? ''));
    for (const n of [...ids].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a - b))) {
      const p = n === '' ? K : `${K}_${n}`;
      if (e[`${p}_URL`]) out.push({ name: e[`${p}_NAME`] || (n === '' ? kind : `${kind}-${n}`), kind, url: e[`${p}_URL`].replace(/\/$/, ''), key: e[`${p}_KEY`] ?? '' });
    }
  }
  return [...(e.ARRS ? JSON.parse(e.ARRS) : []), ...out];
}
const ENV = {
  plexUrl: e.PLEX_URL, plexToken: e.PLEX_KEY || e.PLEX_TOKEN,
  pollSeconds: e.POLL_SECONDS && +e.POLL_SECONDS, maxPerDay: e.MAX_PER_DAY && +e.MAX_PER_DAY,
  dryRun: e.DRY_RUN && e.DRY_RUN !== 'false',
  overseerrUrl: e.OVERSEERR_URL, overseerrKey: e.OVERSEERR_KEY || e.OVERSEERR_API_KEY, overseerrTypes: e.OVERSEERR_ISSUE_TYPES,
  overseerrResolve: e.OVERSEERR_RESOLVE && e.OVERSEERR_RESOLVE !== 'false',
  arrs: arrsFromEnv(),
  clients: e.CLIENTS && JSON.parse(e.CLIENTS),
  qbitUrl: e.QBIT_URL, qbitUsername: e.QBIT_USERNAME, qbitPassword: e.QBIT_PASSWORD,
  sabUrl: e.SAB_URL, sabApiKey: e.SAB_API_KEY,
};
const fromEnv = () => Object.entries(ENV).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
const readFile = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };

export const hasFileConfig = () => Object.keys(readFile()).length > 0;
export const lockedKeys = () => fromEnv().map(([k]) => k);
export const getConfig = () => ({ ...DEFAULTS, ...readFile(), ...Object.fromEntries(fromEnv()) });

// Secrets never leave the server; the UI only learns whether one is set.
export function publicConfig() {
  const c = getConfig();
  const out = {
    ...c,
    arrs: c.arrs.map(({ key, ...a }) => ({ ...a, keySet: !!key })),
    clients: c.clients.map(({ password, apiKey, ...x }) => ({ ...x, passwordSet: !!password, apiKeySet: !!apiKey })),
  };
  for (const k of SECRETS) { out[k] = ''; out[k + 'Set'] = !!c[k]; }
  return out;
}

export function validate(patch) {
  for (const x of patch.clients ?? []) {
    if (!x.name || !CLIENT_KINDS.includes(x.kind) || !/^https?:\/\//.test(x.url)) {
      throw new Error(`invalid download client "${x.name ?? ''}": needs name, kind qbittorrent|sabnzbd and an http(s) url`);
    }
  }
  for (const a of patch.arrs ?? []) {
    if (!a.name || !['sonarr', 'radarr'].includes(a.kind) || !/^https?:\/\//.test(a.url)) {
      throw new Error(`invalid instance "${a.name ?? ''}": needs name, kind sonarr|radarr and an http(s) url`);
    }
  }
}

const CLIENT_KINDS = ['qbittorrent', 'sabnzbd'];

export function saveConfig(patch) {
  validate(patch);
  const cur = readFile();
  const locked = new Set(lockedKeys());
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS) || locked.has(k)) continue;
    if (SECRETS.includes(k) && v === '') continue; // blank = keep current (shortcut: a secret can't be cleared from the UI)
    cur[k] = v;
  }
  if (patch.arrs && !locked.has('arrs')) {
    const old = getConfig().arrs;
    cur.arrs = patch.arrs.map((a) => ({ name: a.name, kind: a.kind, url: a.url.replace(/\/$/, ''), key: a.key || old.find((o) => o.name === a.name)?.key || '' }));
  }
  if (patch.clients && !locked.has('clients')) {
    const old = getConfig().clients;
    cur.clients = patch.clients.map((x) => {
      const o = old.find((y) => y.name === x.name);
      return { name: x.name, kind: x.kind, url: x.url.replace(/\/$/, ''), username: x.username ?? '', password: x.password || o?.password || '', apiKey: x.apiKey || o?.apiKey || '' };
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
  add('PLEX_URL', c.plexUrl); add('PLEX_KEY', c.plexToken);
  for (const kind of ['sonarr', 'radarr']) {
    c.arrs.filter((a) => a.kind === kind).forEach((a, i) => {
      L.push('', `# ${a.name}`);
      add(`${kind.toUpperCase()}_${i + 1}_NAME`, a.name); add(`${kind.toUpperCase()}_${i + 1}_URL`, a.url); add(`${kind.toUpperCase()}_${i + 1}_KEY`, a.key);
    });
  }
  L.push('');
  add('OVERSEERR_URL', c.overseerrUrl); add('OVERSEERR_KEY', c.overseerrKey); add('OVERSEERR_ISSUE_TYPES', c.overseerrTypes); add('OVERSEERR_RESOLVE', c.overseerrResolve);
  L.push(''); add('DRY_RUN', c.dryRun); add('POLL_SECONDS', c.pollSeconds); add('MAX_PER_DAY', c.maxPerDay);
  L.push(''); add('QBIT_URL', c.qbitUrl); add('QBIT_USERNAME', c.qbitUsername); add('QBIT_PASSWORD', c.qbitPassword);
  add('SAB_URL', c.sabUrl); add('SAB_API_KEY', c.sabApiKey);
  if (c.clients.length) add('CLIENTS', JSON.stringify(c.clients));
  L.push('', '# Not stored by the UI: set these yourself.', 'WEB_UI=8080', 'UI_USERNAME=', 'UI_PASSWORD=', '');
  return L.join('\n');
}
