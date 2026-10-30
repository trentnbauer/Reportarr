// Bazarr: the subtitle manager. A subtitle problem is not fixed by replacing the video: Reportarr deletes the item's subtitle
// files and has Bazarr search for new ones. Bazarr knows an item by its Sonarr episode id / Radarr movie id, which is what the
// *arr hits carry, so the ids line up when Bazarr and the *arr are connected.
import { work, get, refused, pass, fail, need, trim } from '../util.mjs';
import { fromEnv, envLines, normalize, fields } from './arr.mjs';

const api = async (b, method, p) => {
  const r = await work(`${trim(b.url)}/api${p}`, { method, headers: { 'X-API-KEY': b.key } });
  if (!r.ok) throw new Error(`${b.name} ${method} ${p.split('?')[0]} ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};
const flag = (s) => `language=${encodeURIComponent(s.code2)}&forced=${s.forced ? 'True' : 'False'}&hi=${s.hi ? 'True' : 'False'}`;

const bazarr = {
  kind: 'bazarr', label: 'Bazarr', prefix: 'bazarr', defaultUrl: 'http://bazarr:6767', fields, defaults: {},
  fromEnv: (e) => fromEnv('bazarr', e), envLines: envLines('bazarr'), normalize: normalize('bazarr'),
  checkArgs: (req, stored) => ({ url: trim(req.url), key: req.key || stored?.key }),
  isConfigured: (b) => !!(b.url && b.key),

  async check({ url, key }) {
    const missing = need({ url, key }, 'url', 'key');
    if (missing.length) return fail(`Set ${missing.join(' and ')} first`);
    const r = await get(`${url}/api/system/status`, { headers: { 'X-API-KEY': key } });
    if (!r.ok) return fail(`bazarr: ${refused(r.status, 'the API key')}${r.status === 404 ? ' (is the URL right, including any base path such as /bazarr?)' : ''}`);
    const d = await r.json().catch(() => null);
    if (!d?.data?.bazarr_version) return fail('That address answered, but it does not look like Bazarr (is the URL right, including any base path such as /bazarr?)');
    return pass(`Bazarr ${d.data.bazarr_version}: API key accepted`);
  },

  // Delete the subtitle files of one item and have Bazarr search for what is then missing. hit is an *arr hit (an episode or a movie).
  // Returns what it did, or nothing when this Bazarr does not know the item (it may be connected to another Sonarr/Radarr).
  async refresh(b, hit) {
    const episode = !!hit.ep, id = episode ? hit.ep.id : hit.movie?.id;
    if (!id) return;
    const root = episode ? '/episodes' : '/movies', query = `${episode ? 'episodeid' : 'radarrid'}%5B%5D=${id}`;
    const item = (await api(b, 'GET', `${root}?${query}`))?.data?.[0];
    if (!item) return;
    const ids = episode ? `seriesid=${item.sonarrSeriesId}&episodeid=${id}` : `radarrid=${id}`;
    const external = (item.subtitles ?? []).filter((s) => s.path); // a subtitle inside the video (no path) cannot be deleted
    for (const s of external) await api(b, 'DELETE', `${root}/subtitles?${ids}&${flag(s)}&path=${encodeURIComponent(s.path)}`);
    const now = external.length ? (await api(b, 'GET', `${root}?${query}`))?.data?.[0] : item;
    const missing = now?.missing_subtitles ?? [];
    for (const s of missing) await api(b, 'PATCH', `${root}/subtitles?${ids}&${flag(s)}`); // Bazarr queues the search and answers at once; it downloads in the background
    return `deleted ${external.length} subtitle file(s), asked Bazarr to search for ${missing.length} language(s)`;
  },
};
export default bazarr;
