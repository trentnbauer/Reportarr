// Whisparr. Finds the file a Plex report is about, and says how to replace it. Whisparr 2 is built on Sonarr (series and
// episodes) and Whisparr 3 on Radarr (movies); both answer on API v3, so each is handled the way its parent is, and the hit
// says which (an episode or a movie) so plan() can pick the matching calls. Overseerr/Seerr does not do adult titles, so only
// Plex reports reach it. Plex's adult libraries carry no TVDB/TMDB ids, so the file is found by its name.
import { request, fileName, fromEnv, envLines, normalize, checkArgs, check, fields } from './arr.mjs';
import sonarr from './sonarr.mjs';
import radarr from './radarr.mjs';

const call = (a, method, p, body) => request('v3', a, method, p, body);
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const absent = (e) => /\b(404|405)$/.test(e.message); // this Whisparr is the other generation: it has no such endpoint

const whisparr = {
  kind: 'whisparr', label: 'Whisparr', prefix: 'whisparr', defaultUrl: 'http://whisparr:6969', api: 'v3', appName: 'Whisparr', fields, defaults: {},
  fromEnv: (e) => fromEnv('whisparr', e), envLines: envLines('whisparr'), normalize: normalize('whisparr'), checkArgs: checkArgs('whisparr'),
  check: (args) => check(whisparr, args),

  async fromPlex({ a, m, files }) {
    try {
      if (m.type === 'movie') { // Whisparr 3: movies
        const movie = (await call(a, 'GET', '/movie')).find((x) => x.hasFile && files.has(fileName(x.movieFile?.path)));
        return movie && { a, movie, fileId: movie.movieFile.id, file: fileName(movie.movieFile.path) };
      }
      if (m.type !== 'episode') return;
      // Whisparr 2: the series by its name (Plex's show), then the episode whose file has the reported name
      const series = (await call(a, 'GET', '/series')).find((x) => norm(x.title) === norm(m.grandparentTitle));
      if (!series) return;
      const ep = (await call(a, 'GET', `/episode?seriesId=${series.id}&includeEpisodeFile=true`)).find((e) => e.hasFile && files.has(fileName(e.episodeFile?.path)));
      return ep && { a, ep, fileId: ep.episodeFile.id, file: fileName(ep.episodeFile.path) };
    } catch (e) { if (!absent(e)) throw e; }
  },

  plan: (hit) => (hit.ep ? sonarr.plan(hit) : radarr.plan(hit)),
};
export default whisparr;
