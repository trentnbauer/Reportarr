// Settings come from env (compose) and /data/config.json (web UI). Env wins and is shown read-only in the UI.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR ?? '/data';
const FILE = path.join(DATA_DIR, 'config.json');
const e = process.env;

export const SECRETS = ['plexToken', 'qbitPassword', 'sabApiKey'];
const DEFAULTS = {
  plexUrl: 'http://plex:32400', plexToken: '', pollSeconds: 60, maxPerDay: 20, dryRun: true,
  // [{name, kind: 'sonarr'|'radarr', url, key}]
  arrs: [],
  // optional overrides; by default the download client settings are read from each Sonarr/Radarr
  qbitUrl: '', qbitUsername: '', qbitPassword: '', sabUrl: '', sabApiKey: '',
};
const ENV = {
  plexUrl: e.PLEX_URL, plexToken: e.PLEX_TOKEN,
  pollSeconds: e.POLL_SECONDS && +e.POLL_SECONDS, maxPerDay: e.MAX_PER_DAY && +e.MAX_PER_DAY,
  dryRun: e.DRY_RUN && e.DRY_RUN !== 'false',
  arrs: e.ARRS && JSON.parse(e.ARRS),
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
  const out = { ...c, arrs: c.arrs.map(({ key, ...a }) => ({ ...a, keySet: !!key })) };
  for (const k of SECRETS) { out[k] = ''; out[k + 'Set'] = !!c[k]; }
  return out;
}

export function validate(patch) {
  for (const a of patch.arrs ?? []) {
    if (!a.name || !['sonarr', 'radarr'].includes(a.kind) || !/^https?:\/\//.test(a.url)) {
      throw new Error(`invalid instance "${a.name ?? ''}": needs name, kind sonarr|radarr and an http(s) url`);
    }
  }
}

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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cur, null, 2));
}
