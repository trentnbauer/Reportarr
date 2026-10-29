// "Test" buttons: each check makes the same kind of call the app really makes, with a short timeout, and returns
// { ok, message }. Messages never contain keys or passwords.
import { ARR_API } from './config.mjs';

const TIMEOUT_MS = 10_000;
export const PLEX_COMMUNITY_URL = () => process.env.PLEX_COMMUNITY_URL || 'https://community.plex.tv/api';

const get = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
const trim = (u) => String(u ?? '').trim().replace(/\/+$/, '');
const why = (e) => (e.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000}s` : (e.cause?.code ?? e.message));
const refused = (status, what) => (status === 401 || status === 403 ? `${what} was refused (HTTP ${status})` : `HTTP ${status}`);
const ok = (message) => ({ ok: true, message });
const fail = (message) => ({ ok: false, message });
const WORDS = { url: 'a URL', token: 'a token', key: 'an API key', apiKey: 'an API key' };
const need = (o, ...keys) => keys.filter((k) => !o[k]).map((k) => WORDS[k]);

const CHECKS = {
  async plex({ url, token }) {
    const missing = need({ url, token }, 'url', 'token');
    if (missing.length) return fail(`Set ${missing.join(' and ')} first`);
    const r = await get(`${url}/`, { headers: { 'X-Plex-Token': token, Accept: 'application/json' } });
    if (!r.ok) return fail(`Plex server: ${refused(r.status, 'the token')}`);
    const mc = (await r.json()).MediaContainer ?? {};
    const q = await get(PLEX_COMMUNITY_URL(), {
      method: 'POST', headers: { 'X-Plex-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ reports(first: 2) { nodes { id } } }' }),
    });
    const j = await q.json().catch(() => ({}));
    if (!q.ok || j.errors) return fail(`Plex server "${mc.friendlyName}" is reachable, but plex.tv would not list reports: ${q.ok ? j.errors[0]?.message : refused(q.status, 'the token')}`);
    return ok(`Plex "${mc.friendlyName}" ${mc.version}: token accepted, reports readable`);
  },

  async overseerr({ url, key }) {
    const missing = need({ url, key }, 'url', 'key');
    if (missing.length) return fail(`Set ${missing.join(' and ')} first`);
    const s = await get(`${url}/api/v1/status`);
    if (!s.ok) return fail(`Overseerr/Seerr: HTTP ${s.status} (is the URL right, including any path?)`);
    const version = (await s.json().catch(() => ({}))).version;
    const i = await get(`${url}/api/v1/issue?take=1&filter=open`, { headers: { 'X-Api-Key': key } });
    if (!i.ok) return fail(`Overseerr/Seerr ${version ?? ''} is reachable, but the API key ${i.status === 401 || i.status === 403 ? 'was refused or cannot view issues' : `failed (HTTP ${i.status})`}`);
    return ok(`Overseerr/Seerr ${version ?? ''}: API key accepted, issues readable`);
  },

  async arr({ kind, url, key }) {
    const missing = need({ url, key }, 'url', 'key');
    if (missing.length) return fail(`Set ${missing.join(' and ')} first`);
    const r = await get(`${url}/api/${ARR_API[kind] ?? 'v3'}/system/status`, { headers: { 'X-Api-Key': key } });
    if (!r.ok) return fail(`${kind}: ${refused(r.status, 'the API key')}${r.status === 404 ? ' (is the URL right, including any base path?)' : ''}`);
    const st = await r.json().catch(() => ({}));
    if (st.appName && st.appName.toLowerCase() !== kind) return fail(`That address is ${st.appName}, but it is set up as ${kind}`);
    return ok(`${st.appName ?? kind} ${st.version ?? ''}: API key accepted`);
  },

  async qbittorrent({ url, username, password }) {
    if (!url) return fail('Set a URL first');
    const login = await get(`${url}/api/v2/auth/login`, { method: 'POST', body: new URLSearchParams({ username: username ?? '', password: password ?? '' }) });
    if (!login.ok) return fail(`qBittorrent: ${refused(login.status, 'the login')}${login.status === 403 ? ' (too many failed logins from this address, or "Host header validation" is on)' : ''}`);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (!cookie || /fails/i.test(await login.text())) return fail('qBittorrent refused the username or password'); // a failed login answers "Fails."
    const v = await get(`${url}/api/v2/app/version`, { headers: { cookie } });
    return ok(`qBittorrent ${v.ok ? (await v.text()).trim() : ''}: login accepted`);
  },

  async sabnzbd({ url, apiKey }) {
    const missing = need({ url, apiKey }, 'url', 'apiKey');
    if (missing.length) return fail(`Set ${missing.join(' and ')} first`);
    const v = await get(`${url}/api?mode=version&output=json`);
    if (!v.ok) return fail(`SABnzbd: HTTP ${v.status} (is the URL right?)`);
    const version = (await v.json().catch(() => ({}))).version;
    const q = await get(`${url}/api?mode=queue&limit=1&output=json&apikey=${encodeURIComponent(apiKey)}`);
    if (!q.ok) return fail(`SABnzbd ${version ?? ''} is reachable, but the API key was refused: use the full API key, not the NZB key`);
    return ok(`SABnzbd ${version ?? ''}: API key accepted, queue readable`);
  },
};

// req is what the UI sends for one card: the values currently in the form. Blank secrets fall back to the saved ones by name.
export async function runCheck(c, req = {}) {
  const by = (list) => (list ?? []).find((x) => x.name === req.name && req.name);
  let target, args;
  switch (req.target) {
    case 'source': {
      const key = req.key || by(c.sources)?.key;
      [target, args] = req.kind === 'plex' ? ['plex', { url: trim(req.url), token: key }] : ['overseerr', { url: trim(req.url), key }]; break;
    }
    case 'arr': [target, args] = ['arr', { kind: req.kind, url: trim(req.url), key: req.key || by(c.arrs)?.key }]; break;
    case 'client': {
      const s = by(c.clients);
      if (req.kind === 'qbittorrent') [target, args] = ['qbittorrent', { url: trim(req.url || s?.url), username: req.username || s?.username, password: req.password || s?.password }];
      else [target, args] = ['sabnzbd', { url: trim(req.url || s?.url), apiKey: req.apiKey || s?.apiKey }];
      break;
    }
    default: return fail('Unknown test');
  }
  try { return await CHECKS[target](args); } catch (e) { return fail(`${target === 'arr' ? args.kind : target}: ${why(e)}`); }
}
