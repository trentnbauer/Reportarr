// Small helpers shared by the core and the integrations.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref()); // unref: a pending wait must not keep the process alive
export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const trim = (u) => String(u ?? '').trim().replace(/\/+$/, '');

// set at image build time (git tag, or commit hash for untagged builds)
export const VERSION = (process.env.APP_VERSION ?? 'dev').replace(/^([0-9a-f]{7})[0-9a-f]{33}$/, '$1');

// The numbers n for which PREFIX_n_URL, _KEY or _NAME is set in the environment, in order: PLEX_2_URL gives 2.
export const envNumbers = (e, K) => [...new Set(Object.keys(e).map((k) => k.match(new RegExp(`^${K}_(\\d+)_(?:URL|KEY|NAME)$`))?.[1]).filter(Boolean))].sort((a, b) => a - b);

// Connection checks (the Test buttons): a short timeout, readable failures, and never a secret in a message.
export const TIMEOUT_MS = 10_000;
export const get = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
export const why = (e) => (e.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000}s` : (e.cause?.code ?? e.message));
export const refused = (status, what) => (status === 401 || status === 403 ? `${what} was refused (HTTP ${status})` : `HTTP ${status}`);
export const pass = (message) => ({ ok: true, message });
export const fail = (message) => ({ ok: false, message });
const WORDS = { url: 'a URL', token: 'a token', key: 'an API key', apiKey: 'an API key' };
export const need = (o, ...keys) => keys.filter((k) => !o[k]).map((k) => WORDS[k]);
