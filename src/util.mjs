// Small helpers shared by the core and the integrations.
import fs from 'node:fs';

// write to a temp file and rename over the old one, so a crash mid-write never leaves a half-written file
export const writeFileAtomic = (f, data, opts) => { fs.writeFileSync(f + '.tmp', data, opts); fs.renameSync(f + '.tmp', f); };
// Every comment Reportarr posts in another app ends with this, so people can tell a program wrote it.
export const SIGN_OFF = 'Reportarr (automated system)';
export const signed = (message) => `${message}\n\n— ${SIGN_OFF}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref()); // unref: a pending wait must not keep the process alive
export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const trim = (u) => String(u ?? '').trim().replace(/\/+$/, '');

// set at image build time (git tag, or commit hash for untagged builds)
export const VERSION = (process.env.APP_VERSION ?? 'dev').replace(/^([0-9a-f]{7})[0-9a-f]{33}$/, '$1');

// The numbers n for which PREFIX_n_URL, _KEY or _NAME is set in the environment, in order: PLEX_2_URL gives 2.
export const envNumbers = (e, K) => [...new Set(Object.keys(e).map((k) => k.match(new RegExp(`^${K}_(\\d+)_(?:URL|KEY|NAME)$`))?.[1]).filter(Boolean))].sort((a, b) => a - b);

// Connection checks (the Test buttons): a short timeout, readable failures, and never a secret in a message.
export const TIMEOUT_MS = 10_000;
export const get = (url, opts = {}, ms = TIMEOUT_MS) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
// the real work (listing a whole library can be slow): longer, but a server that never answers still can't stall the poll loop
export const WORK_TIMEOUT_MS = 60_000;
export const work = (url, opts) => get(url, opts, WORK_TIMEOUT_MS);
export const why = (e) => (e.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000}s` : (e.cause?.code ?? e.message));
export const refused = (status, what) => (status === 401 || status === 403 ? `${what} was refused (HTTP ${status})` : `HTTP ${status}`);
export const pass = (message) => ({ ok: true, message });
export const fail = (message) => ({ ok: false, message });
const WORDS = { url: 'a URL', token: 'a token', key: 'an API key', apiKey: 'an API key' };
export const need = (o, ...keys) => keys.filter((k) => !o[k]).map((k) => WORDS[k]);
