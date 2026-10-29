// Reportarr: polls Plex "Reported Issues" and Overseerr/Seerr issues, and for each new report replaces the reported
// file in Sonarr/Radarr/Lidarr and moves the new grab to the top of the download queue.
//   src/engine.mjs        the polling loop and the replace flow
//   src/server.mjs        the web UI and its API
//   src/config.mjs        settings from the environment and the web UI
//   src/integrations/     one file per app: Plex, Seerr, Sonarr, Radarr, Lidarr, qBittorrent, SABnzbd
import { serve } from './src/server.mjs';
import { run } from './src/engine.mjs';

serve();
run();
