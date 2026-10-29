// What Sonarr, Radarr and Lidarr have in common: the same request style, the same settings, the same connection test.
// What differs (how a reported file is found, how it is replaced) lives in sonarr.mjs, radarr.mjs and lidarr.mjs.
import { trim, get, refused, pass, fail, need } from '../util.mjs';

export async function request(version, a, method, p, body) {
  const r = await fetch(`${a.url}/api/${version}${p}`, {
    method,
    headers: { 'X-Api-Key': a.key, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${a.name} ${method} ${p} ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// SONARR_1_URL / SONARR_1_KEY / SONARR_1_NAME, SONARR_2_*, ... and the unnumbered SONARR_URL / SONARR_KEY
export function fromEnv(kind, e) {
  const out = [], K = kind.toUpperCase();
  const ids = new Set(Object.keys(e).map((k) => k.match(new RegExp(`^${K}_(?:(\\d+)_)?URL$`))).filter(Boolean).map((m) => m[1] ?? ''));
  for (const n of [...ids].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a - b))) {
    const p = n === '' ? K : `${K}_${n}`;
    if (e[`${p}_URL`]) out.push({ name: e[`${p}_NAME`] || (n === '' ? kind : `${kind}-${n}`), kind, url: e[`${p}_URL`].replace(/\/$/, ''), key: e[`${p}_KEY`] ?? '' });
  }
  return out;
}

export const envLines = (kind) => (a, n) => [[`${kind.toUpperCase()}_${n}_NAME`, a.name], [`${kind.toUpperCase()}_${n}_URL`, a.url], [`${kind.toUpperCase()}_${n}_KEY`, a.key]];
export const normalize = (kind) => (a, old) => ({ name: a.name, kind, url: trim(a.url), key: a.key || old?.key || '' });
export const checkArgs = (kind) => (req, stored) => ({ url: trim(req.url), key: req.key || stored?.key, kind });

export async function check(mod, { url, key }) {
  const missing = need({ url, key }, 'url', 'key');
  if (missing.length) return fail(`Set ${missing.join(' and ')} first`);
  const r = await get(`${url}/api/${mod.api}/system/status`, { headers: { 'X-Api-Key': key } });
  if (!r.ok) return fail(`${mod.kind}: ${refused(r.status, 'the API key')}${r.status === 404 ? ' (is the URL right, including any base path?)' : ''}`);
  const st = await r.json().catch(() => ({}));
  if (st.appName && st.appName.toLowerCase() !== mod.kind) return fail(`That address is ${st.appName}, but it is set up as ${mod.kind}`);
  return pass(`${st.appName ?? mod.kind} ${st.version ?? ''}: API key accepted`);
}

// the fields every *arr card shows
export const fields = [{ name: 'url', label: 'URL (include base path)' }, { name: 'key', label: 'API key', type: 'password', set: 'keySet' }];
