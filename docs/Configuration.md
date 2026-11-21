# Configuration

Everything can be set with environment variables (the `.env` file), in the web UI, or both. **A value set in the environment wins and shows as read-only in the UI.** UI changes are stored in `/data/config.json` and apply on the next poll.

**Instances and download clients mix.** Sonarr, Radarr and Lidarr instances (and download clients) defined in the environment are shown read-only with an `env` badge, and you can still add more in the UI with the **Add Sonarr / Add Radarr / Add Lidarr** buttons. The two lists are merged: the environment's come first, and the ones you add are saved in `/data/config.json` next to them. Names must be unique; a name already used by an environment instance is refused. Removing a row you added only removes that row.

| Variable | Default | Purpose |
|---|---|---|
| `PLEX_URL`, `PLEX_KEY` | | A Plex server and its owner's token (needed to read reports). `PLEX_TOKEN` also works for the key. For more servers number them: `PLEX_2_URL`, `PLEX_2_KEY`, `PLEX_2_NAME`, `PLEX_3_*`, and so on, as many as you have. |
| `SONARR_1_URL`, `SONARR_1_KEY`, `RADARR_1_URL`, `RADARR_1_KEY`, `LIDARR_1_URL`, `LIDARR_1_KEY`, `WHISPARR_1_URL`, `WHISPARR_1_KEY` | | Your Sonarr, Radarr, Lidarr (music) and Whisparr instances. Number them 1, 2, 3, and so on, as many as you have (`SONARR_2_URL`, `RADARR_3_KEY`, `LIDARR_2_URL`, ...). Include any URL base path. `SONARR_1_NAME` optionally sets the display name (default `sonarr-1`). Unnumbered `SONARR_URL`/`SONARR_KEY` and the older `ARRS` JSON list also still work. |
| `OVERSEERR_URL`, `OVERSEERR_KEY` | | An Overseerr/Seerr and its API key (Settings, General). Leave blank to skip Overseerr. More instances: `OVERSEERR_2_URL`, `OVERSEERR_2_KEY`, `OVERSEERR_2_NAME`, and so on. |
| `OVERSEERR_ISSUE_TYPES`, `OVERSEERR_2_ISSUE_TYPES`, ... | `video,audio,subtitles,other` | Which issue types replace the file: `video`, `audio`, `subtitles`, `other`. |
| `OVERSEERR_WHOLE_SERIES`, `OVERSEERR_2_WHOLE_SERIES`, ... | `true` | An issue on a series that names no season replaces every episode with a file. Set `false` to close those with a note asking for the particular episode instead. A big series is replaced over several hours (see the hourly limit). |
| `OVERSEERR_PUBLIC_URL`, `OVERSEERR_2_PUBLIC_URL`, ... | | The address people use for Seerr, for the **View your report** link in emails. Blank: Reportarr reads Seerr's own **Application URL** (Settings, General, needs an admin API key) at most once an hour, and falls back to `OVERSEERR_URL` only if neither is set. |
| `OVERSEERR_RESOLVE`, `OVERSEERR_2_RESOLVE`, ... | `true` | Comment on the Overseerr issue after replacing, and resolve it once the new file is imported. Set `false` to leave the issue alone. |
| `BAZARR_1_URL`, `BAZARR_1_KEY`, `BAZARR_1_NAME` | | A Bazarr, to fix subtitle issues (see [Subtitles](Subtitles.md)). Use its URL including any base path (`http://bazarr:6767/bazarr`) and the API key from Settings, General. Number more: `BAZARR_2_URL`, ... |
| `DISCORD_WEBHOOK`, `DISCORD_USERNAME`, `DISCORD_EVENTS` | | A Discord channel webhook (Server Settings, Integrations, Webhooks), an optional bot name (default Reportarr), and which events it hears about. More channels: `DISCORD_2_WEBHOOK`, `DISCORD_2_USERNAME`, `DISCORD_2_EVENTS`, `DISCORD_2_NAME`, and so on. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_TO`, `SMTP_TLS`, `SMTP_EVENTS` | port `587`, TLS `true` | Email through an SMTP server. `SMTP_TO` takes several addresses, comma-separated. TLS means implicit TLS on port 465 and STARTTLS on any other port; `SMTP_TLS=false` sends without it. More: `SMTP_2_HOST`, `SMTP_2_TO`, ... |
| `SMTP_TO_REPORTER`, `SMTP_2_TO_REPORTER`, ... | `false` | `true` also emails the person who made an Overseerr/Seerr report when it is completed (resolved, denied or skipped), with the reason. See [Notifications](Notifications.md). |
| `SMTP_TEMPLATE`, `SMTP_2_TEMPLATE`, ... | | A common provider, so only the login is needed: `gmail`, `outlook`, `yahoo`, `icloud`, `fastmail`, `zoho`, `proton`, `sendgrid`, `mailgun`, `brevo`, `ses` or `relay`. It fills in `SMTP_HOST`, `SMTP_PORT` and `SMTP_TLS` (anything you set yourself wins). `SMTP_TEMPLATE=gmail` with `SMTP_USERNAME`, `SMTP_PASSWORD` (an App Password), `SMTP_FROM` and `SMTP_TO` is a complete setup. |
| `DISCORD_EVENTS`, `SMTP_EVENTS`, `DISCORD_2_EVENTS`, ... | all four | Comma-separated events that channel is told about: `replaced`, `failed`, `resolved`, `cap`. Unset means all of them. |
| `DRY_RUN` | `true` | Log what would happen without deleting anything. |
| `POLL_SECONDS` | `60` | How often to check for new reports. |
| `MAX_PER_USER_PER_DAY` | `5` | Maximum replacements per person per day (the local day), for Overseerr/Seerr issues, counted the same way. `0` turns it off. A person over their limit has their reports **held** until tomorrow, or until you press Override. Plex reports name no user, so only the hourly limit applies to them. |
| `SERVER_NAME` | | A name for this server (for example `latte`), shown on the emails Reportarr sends: in the subject (`[Reportarr - latte] ...`) and the sign-off ("Reportarr (automated system) on latte"), so you can tell servers apart. Also under App settings. |
| `MAX_PER_HOUR` | `10` | Maximum replacements per hour: each episode, movie or album counts as one. When it is reached Reportarr pauses and carries on when the hour turns over. |
| `WEB_UI` | `8080` | Host port for the web UI (compose). |
| `UI_PORT` | `8080` | Web UI port inside the container. |
| `BASE_URL` | | For a reverse proxy that serves Reportarr under a path: `/reportarr`, or the full public URL `https://media.example.com/reportarr`. See [Reverse proxy](Reverse-proxy.md). |
| `UI_USERNAME` | | Username for the UI. If blank, any username is accepted (only the password is checked). Has no effect without `UI_PASSWORD`. |
| `UI_PASSWORD` | | HTTP basic auth password for the UI. **Set this.** If it is blank there is no login at all: the page just loads, with a warning banner, but only at an IP address or a LAN name (`nas`, `nas.local`, `.lan`, `.home.arpa`, `.internal`) or the host in `BASE_URL`, so a website can't reach it through DNS rebinding. |
| `HIDE_LOGIN_WARNING` | `false` | Hide the "No login is set" banner in the web UI (also a switch under App settings). Only matters when `UI_PASSWORD` is not set. |
| `DATA_DIR` | `/data` | Where state, config and the change log live. |
| `CLIENTS` | | JSON list of download clients for queue priority: `{"name","kind":"qbittorrent"\|"sabnzbd","url","username","password","apiKey"}`. Supports any number of each. |
| `QBIT_URL`, `QBIT_USERNAME`, `QBIT_PASSWORD` | | One qBittorrent, for setups with one. Shown as a read-only "default" download client, used when no other client matches by address. |
| `SAB_URL`, `SAB_API_KEY` | | One SABnzbd, the same way. |

## Moving UI settings into compose

Once you have configured things in the web UI, **Download .env** (below the Save button, shown when you have saved settings in the UI) downloads your settings as `reportarr.env` (browsers drop the leading dot, so rename it to `.env`): numbered `SONARR_N_*` and `RADARR_N_*` instances, `PLEX_KEY`, Overseerr, queue settings and so on. It contains your API keys and passwords, so keep it private and never commit it. Put it next to `docker-compose.yml` and restart; from then on the settings come from the file and show as read-only in the UI. `UI_USERNAME` and `UI_PASSWORD` are never stored by the UI, so they are left blank in the file for you to fill in.

## Why the qBittorrent and SABnzbd settings exist

Sonarr and Radarr don't expose their download clients' passwords or full API keys, so Reportarr can't borrow them. Without `QBIT_PASSWORD` / `SAB_API_KEY` the replacement is still searched and downloaded, it just isn't moved to the top of the queue (the Changes table says so). With several qBittorrent or SABnzbd instances, list each in `CLIENTS` (or the **Download clients** table in the UI). Each queued replacement is matched to its client by the host and port Sonarr/Radarr use for it, falling back to the client's name, so the right instance is always the one that gets the call. For SABnzbd use the **full** API key, not the NZB key. qBittorrent needs torrent queueing enabled for priority to apply.
