# Reportarr

Automagically fix Plex reports.

When a user uses Plex's **Report an issue** (or an Overseerr/Seerr issue) on a title (bad quality, wrong movie, broken file), Reportarr finds the reported file in Sonarr, Radarr or Lidarr, deletes it, blocklists the release it came from, and searches again. Nobody has to hand-manage anything.

> **Built by Claude.** This app was written by [Claude](https://claude.com/claude-code) (Anthropic's AI coding assistant) working with the repository owner, and has been tested against a real Plex, Sonarr, Radarr, qBittorrent and SABnzbd setup. Treat it like any young project: start in dry-run mode, read the code, and keep backups of anything you can't re-download.

## What it does

1. Polls Plex's community API for **Reported Issues** on your server (the same data the Plex web app shows), and optionally your Overseerr/Seerr's open issues. Neither has a webhook for this, so it polls every 60 seconds by default.
2. For each **new** report, resolves the reported item to its file, then to the Sonarr/Radarr instance that owns that exact file. Multiple instances (for example 1080p and 4K) are supported, and so is music through Lidarr.
3. Deletes the file, marks the grabbed release as failed (which blocklists it), and starts a search for a replacement.
4. Optionally moves the replacement to the top of the qBittorrent or SABnzbd queue.
5. Shows every action, and your settings, in a small web UI on port 8080. Reports that were already open when Reportarr first started are left alone, but a button in the UI can action them (or dry-run them) when you want.

The report text is ignored on purpose: any report on a file means "replace this file".

### Safety

- **Dry run is on by default.** Nothing is deleted until you set `DRY_RUN=false`.
- **Existing reports are never acted on.** On first start, everything already reported is recorded as seen. Only reports created after that are handled.
- A **daily cap** (`MAX_PER_DAY`, default 20) limits how much one bad day of reports can delete.
- Duplicate reports for the same file are handled once.
- Plex can't close or delete reports, so Reportarr keeps its own record of handled ones in `/data/state.json`. Reports stay visible in Plex.

## Install

```yaml
services:
  app:
    image: ghcr.io/trentnbauer/reportarr:latest
    restart: unless-stopped
    ports:
      - ${WEB_UI:-8080}:8080
    volumes:
      - data:/data
    env_file:
      - path: .env
        required: false
volumes:
  data:
```

This is [`docker-compose.yml`](docker-compose.yml). All settings live in a `.env` file next to it, and every variable in it reaches the container, so adding another Sonarr or Radarr never needs a change to the compose file. Copy [`.env.example`](.env.example) to `.env` and fill it in. You can also skip the file, start the container and configure everything in the web UI, then use its **Download .env** button to get the same settings as a `.env` file to run from compose.

Open `http://<host>:8080` (it has a light/dark/auto theme toggle), watch the **Changes** table in dry-run for a while, then set `DRY_RUN=false`.

## Configuration

Everything can be set with environment variables (the `.env` file), in the web UI, or both. **A value set in the environment wins and shows as read-only in the UI.** UI changes are stored in `/data/config.json` and apply on the next poll.

| Variable | Default | Purpose |
|---|---|---|
| `PLEX_URL` | `http://plex:32400` | Your Plex server. |
| `PLEX_KEY` | | Plex server owner's token. Needed to read reports. (`PLEX_TOKEN` also works.) |
| `SONARR_1_URL`, `SONARR_1_KEY`, `RADARR_1_URL`, `RADARR_1_KEY`, `LIDARR_1_URL`, `LIDARR_1_KEY` | | Your Sonarr, Radarr and Lidarr (music) instances. Number them 1, 2, 3, and so on, as many as you have (`SONARR_2_URL`, `RADARR_3_KEY`, `LIDARR_2_URL`, ...). Include any URL base path. `SONARR_1_NAME` optionally sets the display name (default `sonarr-1`). Unnumbered `SONARR_URL`/`SONARR_KEY` and the older `ARRS` JSON list also still work. |
| `OVERSEERR_URL`, `OVERSEERR_KEY` | | Your Overseerr/Seerr and its API key (Settings, General). Leave blank to skip Overseerr. |
| `OVERSEERR_ISSUE_TYPES` | `video,audio,other` | Which issue types replace the file: `video`, `audio`, `subtitles`, `other`. |
| `OVERSEERR_RESOLVE` | `true` | Comment on and resolve the Overseerr issue after replacing. |
| `DRY_RUN` | `true` | Log what would happen without deleting anything. |
| `POLL_SECONDS` | `60` | How often to check for new reports. |
| `MAX_PER_DAY` | `20` | Maximum replacements per day. |
| `WEB_UI` | `8080` | Host port for the web UI (compose). |
| `UI_PORT` | `8080` | Web UI port inside the container. |
| `BASE_URL` | | For a reverse proxy that serves Reportarr under a path: `/reportarr`, or the full public URL `https://media.example.com/reportarr`. See below. |
| `UI_USERNAME` | | Username for the UI. If blank, any username is accepted (only the password is checked). Has no effect without `UI_PASSWORD`. |
| `UI_PASSWORD` | | HTTP basic auth password for the UI. **Set this.** If it is blank there is no login at all: the page just loads, with a warning banner. |
| `DATA_DIR` | `/data` | Where state, config and the change log live. |
| `CLIENTS` | | JSON list of download clients for queue priority: `{"name","kind":"qbittorrent"\|"sabnzbd","url","username","password","apiKey"}`. Supports any number of each. |
| `QBIT_URL`, `QBIT_USERNAME`, `QBIT_PASSWORD` | | Default qBittorrent, for setups with one. Used when no `CLIENTS` entry matches. |
| `SAB_URL`, `SAB_API_KEY` | | Default SABnzbd, for setups with one. |

### Behind a reverse proxy, under a path

Reportarr works at `https://media.example.com/reportarr` as well as at its own port. The page works out where it is mounted from the URL it was loaded at, and the server accepts the path prefix whether or not your proxy strips it, so the simplest setup needs no setting at all. Setting `BASE_URL` makes it explicit and adds two things:

- `/reportarr` (no trailing slash) is redirected to `/reportarr/`, which matters if your proxy passes the prefix through.
- If you give the full URL (`BASE_URL=https://media.example.com/reportarr`), the browser's `Origin` for that host is accepted when saving settings. Saving settings is checked against the `Host` the app sees, which behind a proxy is often the internal one; the app also accepts `X-Forwarded-Host`, so either set `BASE_URL` to the full URL or have the proxy send that header.

Examples (adapt the container name and port; I have only tested these shapes against a small test proxy, not against nginx, Caddy or Traefik themselves):

```nginx
location = /reportarr { return 308 /reportarr/; }
location /reportarr/ {
    proxy_pass http://reportarr:8080/;          # the trailing slash strips the prefix
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
}
```

```caddy
media.example.com {
    redir /reportarr /reportarr/
    handle_path /reportarr/* {                   # strips the prefix
        reverse_proxy reportarr:8080
    }
}
```

If your proxy does not strip the prefix (for example `reverse_proxy /reportarr/* reportarr:8080` in Caddy), that works too; set `BASE_URL=https://media.example.com/reportarr`. The login, if you set one, is HTTP basic auth, which proxies pass through unchanged. Keep it behind TLS.

### Test buttons

Each integration in the settings has a **Test** button: Plex, Overseerr/Seerr, every Sonarr/Radarr instance, every download client, and the default qBittorrent and SABnzbd. It checks the values currently in the form, so you can test before saving, and a blank secret uses the one you saved. A check makes the same kind of call the app makes (for example it confirms the Plex token can read reports, that an address really is Sonarr and not Radarr, and that the SABnzbd key is the full one) and times out after 10 seconds. Results never show keys or passwords. A test only reads; it never changes anything in the service.

### Moving UI settings into compose

Once you have configured things in the web UI, **Download .env** (below the Save button, shown when you have saved settings in the UI) downloads your settings as `reportarr.env` (browsers drop the leading dot, so rename it to `.env`): numbered `SONARR_N_*` and `RADARR_N_*` instances, `PLEX_KEY`, Overseerr, queue settings and so on. It contains your API keys and passwords, so keep it private and never commit it. Put it next to `docker-compose.yml` and restart; from then on the settings come from the file and show as read-only in the UI. `UI_USERNAME` and `UI_PASSWORD` are never stored by the UI, so they are left blank in the file for you to fill in.

### Why the qBittorrent and SABnzbd settings exist

Sonarr and Radarr don't expose their download clients' passwords or full API keys, so Reportarr can't borrow them. Without `QBIT_PASSWORD` / `SAB_API_KEY` the replacement is still searched and downloaded, it just isn't moved to the top of the queue (the Changes table says so). With several qBittorrent or SABnzbd instances, list each in `CLIENTS` (or the **Download clients** table in the UI). Each queued replacement is matched to its client by the host and port Sonarr/Radarr use for it, falling back to the client's name, so the right instance is always the one that gets the call. For SABnzbd use the **full** API key, not the NZB key. qBittorrent needs torrent queueing enabled for priority to apply.

## How it matches a report to a file

**Plex.** A report holds a Plex item reference. Reportarr asks Plex for that item's file name and IDs (TVDB for series, TMDB for movies), looks the item up in each Sonarr/Radarr instance of the right kind, and acts on the instance whose file name matches. If no instance owns the file, or the item is already gone from Plex, the report is logged as skipped.

**Plex music.** A reported track is matched to Lidarr by artist name and file name. Lidarr works per album, so the **whole album** is replaced: all of its files are deleted, the release they came from is blocklisted and the album is searched again. That keeps the album one consistent release. Tracks whose artist or file Lidarr does not have are skipped.

**Overseerr/Seerr.** An issue names a title, not a file, so Reportarr looks the title up by TMDB id (movies) or TVDB/TMDB id (series) in every Radarr or Sonarr and replaces the file in each instance that has one (so a 1080p and a 4K copy both go). Movie issues replace the movie file. TV issues replace the reported episode; if the issue names a season but no episode, every episode with a file in that season; issues against the whole series are skipped, as are issue types not listed in `OVERSEERR_ISSUE_TYPES` (subtitle problems are better fixed by Bazarr). After replacing, Reportarr comments on the issue and resolves it, unless `OVERSEERR_RESOLVE=false`. Open issues that exist when you first add Overseerr are never actioned automatically; use the button in the web UI for those.

## Security

- **Set `UI_PASSWORD`, and `UI_USERNAME` too.** The UI can change which servers Reportarr talks to, and the app holds your Plex token and the arr API keys. Without a password anyone who can reach the port can use it. Don't expose it to the internet; put it behind a reverse proxy with TLS if you need remote access (basic auth is sent in clear text over plain HTTP).
- Secrets are never sent to the browser, and `/data/config.json` is written readable only by its owner.
- Changes to settings must be sent as JSON from the same origin, which stops other websites from changing your settings through your browser.
- The container runs as root so that existing `/data` volumes keep working. If you prefer, run it with `user: "1000:1000"` and make `./data` writable by that user.

## Limitations

- **Plex reports can't be closed or deleted.** Plex has no way to do that, so they stay open in Plex (Overseerr issues are resolved). Reportarr could post a reply on a Plex report; it doesn't do that yet.
- Only the 100 newest open Overseerr issues are read each poll.
- Uses an unofficial Plex endpoint (`community.plex.tv`), the same one the Plex web app uses. Plex could change it without notice.
- A replacement may be the same bad release again if Sonarr/Radarr don't match it to the blocklist entry. Check the Changes table after the first few real runs.
- Supported apps are Sonarr, Radarr and Lidarr. **Readarr is not supported**: the project has been retired, Plex has no ebook library to report on, and Overseerr does not handle books, so there is nothing to drive it. Whisparr is not supported either.
- Lidarr support was verified against a real Lidarr and a real Plex music library for matching (dry run), but the delete, blocklist and search calls were only exercised against a test server. Run it in dry run first.
- One bad report from one user deletes a file. That is the design, so mind who can report on your server and keep `MAX_PER_DAY` sensible.

## Versions

Each image build gets a version: `0.1.<run number>` for builds from `main`, or the tag for tagged releases (`v1.4.0` becomes `1.4.0`). It is shown in the web UI header, set as the image's `org.opencontainers.image.version` label, and added as an image tag next to `latest`. Bump the major.minor part with `VERSION_BASE` in `.github/workflows/docker.yml`.

## Development

```sh
node --test          # unit tests
DATA_DIR=./data node app.mjs
```

Plain Node 22, no dependencies, no build step.

## Licence

None chosen yet. Until the owner adds one, all rights are reserved.
