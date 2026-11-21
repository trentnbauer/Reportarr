# Development

```sh
node --test          # unit tests
DATA_DIR=./data node app.mjs
```

Plain Node 22, no dependencies, no build step.

## Project layout

Each app Reportarr talks to is one file in `src/integrations/` that owns everything about it: its environment variables, how its settings are saved and exported, its connection test, its API calls and how it matches a reported file. The rest of the code loops over a registry and has no app-specific branches.

```
app.mjs                     starts the web UI and the polling loop
ui.html                     the web UI (no dependencies; draws its cards from what the server says each kind needs)
src/engine.mjs              the polling loop and the replace flow
src/server.mjs              the web UI's HTTP server, login, and reverse-proxy handling
src/config.mjs              settings from the environment and the UI: merge, save, export
src/checks.mjs              finds the right integration for a Test button
src/notify.mjs              turns log rows into events and sends them (batched) to the notification channels
src/util.mjs                small shared helpers
src/integrations/
  index.mjs                 the registry: lists every integration
  plex.mjs  seerr.mjs      report sources
  arr.mjs                   what Sonarr, Radarr, Lidarr and Whisparr share
  sonarr.mjs  radarr.mjs  lidarr.mjs  whisparr.mjs
  qbittorrent.mjs  sabnzbd.mjs   download clients
  discord.mjs  smtp.mjs    notification channels (events.mjs: the events they share)
  bazarr.mjs               subtitle manager
test/                       one test file per area (node --test)
```

## Adding an integration

Copy the closest existing file, make it declare the same things, and list it in `src/integrations/index.mjs`. `test/integrations.test.mjs` checks that every integration declares what the core relies on:

- everything: `kind`, `label`, `prefix`, `defaultUrl`, `fields` (what the settings card shows), `defaults`, `fromEnv(env)` (your environment variables), `check(args)` and `checkArgs(request, saved)` (the Test button);
- a **source** (where reports come from): `fetch(source)` returns the open reports, `replace(ctx, report)` handles one, plus `label`, `isConfigured`, `normalize` and `envLines`;
- an ***arr app**: `plan(hit)` says how to delete, blocklist and search again, and `fromPlex` and/or `fromIssue` find the file a report is about;
- a **download client**: `implementation` (the name the \*arr gives it) and `prioritize(client, queueItem)`;
- a **subtitle manager**: `refresh(manager, hit)` fixes one item's subtitles, plus `isConfigured`, `normalize` and `envLines`;
- a **notification channel**: `send(channel, message)`, `validate`, `normalize`, `envLines`, `isConfigured` and its event switches (it has no URL, so no `defaultUrl`).

The settings page, the `.env` export, the Test button and the Connections strip then pick it up with no other change.

## Versions

Each image build gets a version: `0.1.<run number>` for builds from `main`, or the tag for tagged releases (`v1.4.0` becomes `1.4.0`). It is shown in the web UI header, set as the image's `org.opencontainers.image.version` label, and added as an image tag next to `latest`. Bump the major.minor part with `VERSION_BASE` in `.github/workflows/docker.yml`.
