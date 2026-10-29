// Sonarr (TV). Finds the episode file a Plex report or Overseerr issue is about, and says how to replace it.
import path from 'node:path';
import { request, fromEnv, envLines, normalize, checkArgs, check, fields } from './arr.mjs';
import { idsOf } from './plex.mjs';

const call = (a, method, p, body) => request('v3', a, method, p, body);
const sxe = (e) => `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`;

const sonarr = {
  kind: 'sonarr', label: 'Sonarr', prefix: 'sonarr', defaultUrl: 'http://sonarr:8989', api: 'v3', appName: 'Sonarr', fields, defaults: {},
  fromEnv: (e) => fromEnv('sonarr', e), envLines: envLines('sonarr'), normalize: normalize('sonarr'), checkArgs: checkArgs('sonarr'),
  check: (args) => check(sonarr, args),

  // A reported Plex episode: the series by TVDB id (from Plex), then the episode whose file has the reported name.
  async fromPlex({ a, m, files, plexGet }) {
    if (m.type !== 'episode') return;
    const tvdb = idsOf((await plexGet(`/library/metadata/${m.grandparentRatingKey}`)).Metadata[0].Guid).tvdb;
    const [series] = await call(a, 'GET', `/series?tvdbId=${tvdb}`);
    if (!series) return;
    const eps = await call(a, 'GET', `/episode?seriesId=${series.id}&includeEpisodeFile=true`);
    const ep = eps.find((e) => e.seasonNumber === m.parentIndex && e.episodeNumber === m.index && e.hasFile && files.has(path.basename(e.episodeFile.path)));
    if (ep) return { a, ep, fileId: ep.episodeFile.id };
  },

  // An Overseerr issue on a series: the reported episode, or every episode with a file in the reported season.
  async fromIssue({ a, issue }) {
    const { tmdbId, tvdbId, mediaType } = issue.media;
    if (mediaType !== 'tv') return [];
    const series = tvdbId ? (await call(a, 'GET', `/series?tvdbId=${tvdbId}`))[0] : (await call(a, 'GET', '/series')).find((x) => x.tmdbId === tmdbId);
    if (!series) return [];
    const eps = await call(a, 'GET', `/episode?seriesId=${series.id}&includeEpisodeFile=true`);
    return eps.filter((e) => e.hasFile && e.seasonNumber === issue.problemSeason && (!issue.problemEpisode || e.episodeNumber === issue.problemEpisode))
      .map((ep) => ({ a, ep, fileId: ep.episodeFile.id, title: `${series.title} ${sxe(ep)}` }));
  },

  // what to call to find the grabbed release, delete the file, search again, and spot the new grab in the queue
  plan: ({ ep }) => ({
    hist: `/history?episodeId=${ep.id}&eventType=1&pageSize=1&sortKey=date&sortDirection=descending`,
    del: (id) => `/episodefile/${id}`, cmd: { name: 'EpisodeSearch', episodeIds: [ep.id] }, ours: (r) => r.episodeId === ep.id,
  }),
};
export default sonarr;
