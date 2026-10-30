// The registry: every integration Reportarr knows. To support another app, add a file here and list it below;
// the settings, environment variables, connection tests and the web UI all follow from what the file declares.
import plex from './plex.mjs';
import seerr from './seerr.mjs';
import sonarr from './sonarr.mjs';
import radarr from './radarr.mjs';
import lidarr from './lidarr.mjs';
import qbittorrent from './qbittorrent.mjs';
import sabnzbd from './sabnzbd.mjs';
import discord from './discord.mjs';
import smtp from './smtp.mjs';

const by = (...mods) => Object.fromEntries(mods.map((m) => [m.kind, m]));
export const SOURCES = by(plex, seerr);                    // where reports come from
export const ARRS = by(sonarr, radarr, lidarr);            // where files are replaced
export const CLIENTS = by(qbittorrent, sabnzbd);           // where replacements are moved to the top of the queue
export const NOTIFIERS = by(discord, smtp);                // who is told what happened
export const CLIENT_BY_IMPLEMENTATION = Object.fromEntries(Object.values(CLIENTS).map((m) => [m.implementation, m])); // how an *arr names its client

// The lists the settings are stored in, and the integrations that can appear in each.
export const LISTS = { sources: SOURCES, arrs: ARRS, clients: CLIENTS, notifications: NOTIFIERS };

// What the web UI needs to draw a card for any kind, so it hard-codes no app names.
export const kindsMeta = () => Object.fromEntries(Object.entries(LISTS).map(([list, mods]) => [list, Object.fromEntries(Object.values(mods).map((m) => [m.kind, {
  label: m.label, prefix: m.prefix, defaultUrl: m.defaultUrl, fields: m.fields, switches: m.switches ?? [], defaults: m.defaults ?? {},
}]))]));
