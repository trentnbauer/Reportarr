# Reportarr

Automagically fix Plex reports.

When a user uses Plex's **Report an issue** on a title (bad quality, wrong movie, broken file), Reportarr finds the reported file in Sonarr or Radarr, deletes it, blocklists the release it came from, and searches again. Nobody has to hand-manage anything.

> **Built by Claude.** This app was written by [Claude](https://claude.com/claude-code) (Anthropic's AI coding assistant) working with the repository owner, and has been tested against a real Plex, Sonarr, Radarr, qBittorrent and SABnzbd setup. Treat it like any young project: start in dry-run mode, read the code, and keep backups of anything you can't re-download.

## What it does

1. Polls Plex's community API for **Reported Issues** on your server (the same data the Plex web app shows). Plex has no webhook for this, so it polls every 60 seconds by default.
2. For each **new** report, resolves the reported item to its file, then to the Sonarr/Radarr instance that owns that exact file. Multiple instances (for example 1080p and 4K) are supported.
3. Deletes the file, marks the grabbed release as failed (which blocklists it), and starts a search for a replacement.
4. Optionally moves the replacement to the top of the qBittorrent or SABnzbd queue.
5. Shows every action, and your settings, in a small web UI on port 8080.

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
  reportarr:
    image: ghcr.io/trentnbauer/reportarr:latest
    restart: unless-stopped
    ports: ["8080:8080"]
    volumes: ["./data:/data"]
    environment:
      PLEX_URL: http://plex:32400
      PLEX_TOKEN: ${PLEX_TOKEN}
      DRY_RUN: "true"
      UI_PASSWORD: ${UI_PASSWORD}
      ARRS: >-
        [{"name":"sonarr","kind":"sonarr","url":"http://sonarr:8989","key":"${SONARR_KEY}"},
         {"name":"radarr","kind":"radarr","url":"http://radarr:7878","key":"${RADARR_KEY}"}]
```

See [`docker-compose.yml`](docker-compose.yml) for a fuller example. Open `http://<host>:8080`, watch the **Changes** table in dry-run for a while, then set `DRY_RUN=false`.

## Configuration

Everything can be set with environment variables, in the web UI, or both. **A value set in the environment wins and shows as read-only in the UI.** UI changes are stored in `/data/config.json` and apply on the next poll.

| Variable | Default | Purpose |
|---|---|---|
| `PLEX_URL` | `http://plex:32400` | Your Plex server. |
| `PLEX_TOKEN` | | Plex server owner's token. Needed to read reports. |
| `ARRS` | | JSON list of instances: `{"name","kind":"sonarr"\|"radarr","url","key"}`. Include any URL base path. |
| `DRY_RUN` | `true` | Log what would happen without deleting anything. |
| `POLL_SECONDS` | `60` | How often to check for new reports. |
| `MAX_PER_DAY` | `20` | Maximum replacements per day. |
| `UI_PORT` | `8080` | Web UI port. |
| `UI_PASSWORD` | | HTTP basic auth for the UI (any username). **Set this.** The app holds your Plex token and can delete files. |
| `DATA_DIR` | `/data` | Where state, config and the change log live. |
| `QBIT_URL`, `QBIT_USERNAME`, `QBIT_PASSWORD` | | qBittorrent details, used to move the replacement to the top of the queue. |
| `SAB_URL`, `SAB_API_KEY` | | SABnzbd details, used for the same. |

### Why the qBittorrent and SABnzbd settings exist

Sonarr and Radarr don't expose their download clients' passwords or full API keys, so Reportarr can't borrow them. Without `QBIT_PASSWORD` / `SAB_API_KEY` the replacement is still searched and downloaded, it just isn't moved to the top of the queue (the Changes table says so). For SABnzbd use the **full** API key, not the NZB key. qBittorrent needs torrent queueing enabled for priority to apply.

## How it matches a report to a file

A report holds a Plex item reference. Reportarr asks Plex for that item's file name and IDs (TVDB for series, TMDB for movies), looks the item up in each Sonarr/Radarr instance of the right kind, and acts on the instance whose file name matches. If no instance owns the file, or the item is already gone from Plex, the report is logged as skipped.

## Limitations

- **Plex reports can't be closed or deleted.** Plex has no way to do that. Reportarr could post a reply on a report; it doesn't do that yet.
- Uses an unofficial Plex endpoint (`community.plex.tv`), the same one the Plex web app uses. Plex could change it without notice.
- A replacement may be the same bad release again if Sonarr/Radarr don't match it to the blocklist entry. Check the Changes table after the first few real runs.
- Only Sonarr and Radarr are supported (no Lidarr).
- One bad report from one user deletes a file. That is the design, so mind who can report on your server and keep `MAX_PER_DAY` sensible.

## Development

```sh
node --test          # unit tests
DATA_DIR=./data node app.mjs
```

Plain Node 22, no dependencies, no build step.

## Licence

None chosen yet. Until the owner adds one, all rights are reserved.
