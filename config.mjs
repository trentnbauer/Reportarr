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
const ENV = {
  plexUrl: e.PLEX_URL, plexToken: e.PLEX_TOKEN,
  pollSeconds: e.POLL_SECONDS && +e.POLL_SECONDS, maxPerDay: e.MAX_PER_DAY && +e.MAX_PER_DAY,
  dryRun: e.DRY_RUN && e.DRY_RUN !== 'false',
  overseerrUrl: e.OVERSEERR_URL, overseerrKey: e.OVERSEERR_API_KEY, overseerrTypes: e.OVERSEERR_ISSUE_TYPES,
  overseerrResolve: e.OVERSEERR_RESOLVE && e.OVERSEERR_RESOLVE !== 'false',
  arrs: e.ARRS && JSON.parse(e.ARRS),
  clients: e.CLIENTS && JSON.parse(e.CLIENTS),
  qbitUrl: e.QBIT_URL, qbitUsername: e.QBIT_USERNAME, qbitPassword: e.QBIT_PASSWORD,
  sabUrl: e.SAB_URL, sabApiKey: e.SAB_API_KEY,
};
const fromEnv = () => Object.entries(ENV).filter(([, v]) => v !== undefined && v !== '');
const readFile = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };

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
