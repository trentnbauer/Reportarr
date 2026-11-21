# Security and limitations

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
- Supported apps are Sonarr, Radarr, Lidarr and Whisparr. **Readarr is not supported**: the project has been retired, Plex has no ebook library to report on, and Overseerr does not handle books, so there is nothing to drive it. Whisparr is not supported either.
- Lidarr support was verified against a real Lidarr and a real Plex music library for matching (dry run), but the delete, blocklist and search calls were only exercised against a test server. Run it in dry run first.
- One bad report from one user deletes a file. That is the design, so mind who can report on your server and keep `MAX_PER_HOUR` sensible.
