// Radarr (movies). Finds the movie file a Plex report or Overseerr issue is about, and says how to replace it.
import path from 'node:path';
import { request, fromEnv, envLines, normalize, checkArgs, check, fields } from './arr.mjs';
import { idsOf } from './plex.mjs';

const call = (a, method, p, body) => request('v3', a, method, p, body);

const radarr = {
  kind: 'radarr', label: 'Radarr', prefix: 'radarr', defaultUrl: 'http://radarr:7878', api: 'v3', appName: 'Radarr', fields, defaults: {},
  fromEnv: (e) => fromEnv('radarr', e), envLines: envLines('radarr'), normalize: normalize('radarr'), checkArgs: checkArgs('radarr'),
  check: (args) => check(radarr, args),

  // A reported Plex movie: by TMDB id (from Plex), then check the file has the reported name.
  async fromPlex({ a, m, files }) {
    if (m.type !== 'movie') return;
    const [movie] = await call(a, 'GET', `/movie?tmdbId=${idsOf(m.Guid).tmdb}`);
    if (movie?.hasFile && files.has(path.basename(movie.movieFile.path))) return { a, movie, fileId: movie.movieFile.id };
  },

  // An Overseerr issue on a movie.
  async fromIssue({ a, issue }) {
    if (issue.media.mediaType !== 'movie') return [];
    const [movie] = await call(a, 'GET', `/movie?tmdbId=${issue.media.tmdbId}`);
    return movie?.hasFile ? [{ a, movie, fileId: movie.movieFile.id, title: movie.title }] : [];
  },

  plan: ({ movie }) => ({
    hist: `/history/movie?movieId=${movie.id}&eventType=1`,
    del: (id) => `/moviefile/${id}`, cmd: { name: 'MoviesSearch', movieIds: [movie.id] }, match: { movieId: movie.id }, check: `/movie/${movie.id}`,
  }),
};
export default radarr;
