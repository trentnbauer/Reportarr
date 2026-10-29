// Lidarr (music), API v1. Plex music reports only; Overseerr does not handle music.
import path from 'node:path';
import { request, fromEnv, envLines, normalize, checkArgs, check, fields } from './arr.mjs';

const call = (a, method, p, body) => request('v1', a, method, p, body);

const lidarr = {
  kind: 'lidarr', label: 'Lidarr', prefix: 'lidarr', defaultUrl: 'http://lidarr:8686', api: 'v1', appName: 'Lidarr', fields, defaults: {},
  fromEnv: (e) => fromEnv('lidarr', e), envLines: envLines('lidarr'), normalize: normalize('lidarr'), checkArgs: checkArgs('lidarr'),
  check: (args) => check(lidarr, args),

  // Lidarr works per album: find the artist by name, the file by name, then take the whole album so it stays one release.
  async fromPlex({ a, m, files }) {
    if (m.type !== 'track') return;
    const artist = (await call(a, 'GET', '/artist')).find((x) => x.artistName.toLowerCase() === m.grandparentTitle?.toLowerCase());
    const file = artist && (await call(a, 'GET', `/trackfile?artistId=${artist.id}`)).find((f) => files.has(path.basename(f.path)));
    if (file) return { a, albumId: file.albumId, fileIds: (await call(a, 'GET', `/trackfile?albumId=${file.albumId}`)).map((f) => f.id) };
  },

  plan: ({ albumId }) => ({
    hist: `/history?albumId=${albumId}&eventType=1&pageSize=1&sortKey=date&sortDirection=descending`,
    del: (id) => `/trackfile/${id}`, cmd: { name: 'AlbumSearch', albumIds: [albumId] }, match: { albumId },
  }),
};
export default lidarr;
