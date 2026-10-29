// qBittorrent: a download client. Used to move a replacement to the top of the queue.
import { trim, get, refused, pass, fail, need } from '../util.mjs';

const qbittorrent = {
  kind: 'qbittorrent', label: 'qBittorrent', prefix: 'qbit', defaultUrl: 'http://qbittorrent:8080', implementation: 'QBittorrent',
  fields: [
    { name: 'url', label: 'URL' }, { name: 'username', label: 'Username' },
    { name: 'password', label: 'Password', type: 'password', set: 'passwordSet' },
  ],
  defaults: { username: '', password: '', apiKey: '' },

  // the older single-client settings: one qBittorrent, used for any qBittorrent not matched by address
  fromEnv: (e) => ((e.QBIT_URL || e.QBIT_USERNAME || e.QBIT_PASSWORD)
    ? [{ name: 'qbittorrent', kind: 'qbittorrent', url: trim(e.QBIT_URL), username: e.QBIT_USERNAME ?? '', password: e.QBIT_PASSWORD ?? '', apiKey: '', default: true }] : []),
  legacy: {
    keys: ['qbitUrl', 'qbitUsername', 'qbitPassword'],
    entries: (f) => ((f.qbitUrl || f.qbitUsername || f.qbitPassword)
      ? [{ name: 'qbittorrent', kind: 'qbittorrent', url: trim(f.qbitUrl), username: f.qbitUsername ?? '', password: f.qbitPassword ?? '', apiKey: '', default: true }] : []),
  },

  checkArgs: (req, s) => ({ url: trim(req.url || s?.url), username: req.username || s?.username, password: req.password || s?.password }),
  async check({ url, username, password }) {
    if (!url) return fail('Set a URL first');
    const login = await get(`${url}/api/v2/auth/login`, { method: 'POST', body: new URLSearchParams({ username: username ?? '', password: password ?? '' }) });
    if (!login.ok) return fail(`qBittorrent: ${refused(login.status, 'the login')}${login.status === 403 ? ' (too many failed logins from this address, or "Host header validation" is on)' : ''}`);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (!cookie || /fails/i.test(await login.text())) return fail('qBittorrent refused the username or password'); // a failed login answers "Fails."
    const v = await get(`${url}/api/v2/app/version`, { headers: { cookie } });
    return pass(`qBittorrent ${v.ok ? (await v.text()).trim() : ''}: login accepted`);
  },

  // Move a torrent to the top of the queue. dc is the matched client (its secrets resolved); q is the *arr's queue item.
  async prioritize(dc, q) {
    if (!dc.password) throw new Error(`qBittorrent password for ${q.downloadClient} (${dc.url}) is hidden by the arr: add it to CLIENTS or set QBIT_PASSWORD`);
    const body = new URLSearchParams({ username: dc.username, password: dc.password });
    const cookie = (await fetch(`${dc.url}/api/v2/auth/login`, { method: 'POST', body })).headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error(`qBittorrent login failed at ${dc.url}`);
    const r = await fetch(`${dc.url}/api/v2/torrents/topPrio`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ hashes: q.downloadId.toLowerCase() }) });
    if (!r.ok) throw new Error(`qBittorrent topPrio ${r.status}`); // 409 = torrent queueing disabled
  },
};
export default qbittorrent;
