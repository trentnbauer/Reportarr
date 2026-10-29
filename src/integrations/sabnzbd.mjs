// SABnzbd: a download client. Used to move a replacement to the top of the queue.
import { trim, get, work, pass, fail, need } from '../util.mjs';

const sabnzbd = {
  kind: 'sabnzbd', label: 'SABnzbd', prefix: 'sab', defaultUrl: 'http://sabnzbd:8080', implementation: 'Sabnzbd',
  fields: [{ name: 'url', label: 'URL' }, { name: 'apiKey', label: 'API key (full, not NZB key)', type: 'password', set: 'apiKeySet' }],
  defaults: { username: '', password: '', apiKey: '' },

  // the older single-client settings: one SABnzbd, used for any SABnzbd not matched by address
  fromEnv: (e) => ((e.SAB_URL || e.SAB_API_KEY)
    ? [{ name: 'sabnzbd', kind: 'sabnzbd', url: trim(e.SAB_URL), username: '', password: '', apiKey: e.SAB_API_KEY ?? '', default: true }] : []),
  legacy: {
    keys: ['sabUrl', 'sabApiKey'],
    entries: (f) => ((f.sabUrl || f.sabApiKey)
      ? [{ name: 'sabnzbd', kind: 'sabnzbd', url: trim(f.sabUrl), username: '', password: '', apiKey: f.sabApiKey ?? '', default: true }] : []),
  },

  checkArgs: (req, s) => ({ url: trim(req.url || s?.url), apiKey: req.apiKey || s?.apiKey }),
  async check({ url, apiKey }) {
    const missing = need({ url, apiKey }, 'url', 'apiKey');
    if (missing.length) return fail(`Set ${missing.join(' and ')} first`);
    const v = await get(`${url}/api?mode=version&output=json`);
    if (!v.ok) return fail(`SABnzbd: HTTP ${v.status} (is the URL right?)`);
    const version = (await v.json().catch(() => ({}))).version;
    const q = await get(`${url}/api?mode=queue&limit=1&output=json&apikey=${encodeURIComponent(apiKey)}`);
    if (!q.ok) return fail(`SABnzbd ${version ?? ''} is reachable, but the API key was refused: use the full API key, not the NZB key`);
    return pass(`SABnzbd ${version ?? ''}: API key accepted, queue readable`);
  },

  // Move a download to the top of the queue (position 0).
  async prioritize(dc, q) {
    if (!dc.apiKey) throw new Error(`SABnzbd API key for ${q.downloadClient} (${dc.url}) is hidden by the arr: add it to CLIENTS or set SAB_API_KEY`);
    const r = await work(`${dc.url}/api?mode=switch&value=${encodeURIComponent(q.downloadId)}&value2=0&output=json&apikey=${encodeURIComponent(dc.apiKey)}`);
    if (!r.ok) throw new Error(`sabnzbd switch ${r.status}`);
  },
};
export default sabnzbd;
