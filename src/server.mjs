// The web UI and its API: login, the settings and status endpoints, and the reverse-proxy handling.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { getConfig, publicConfig, lockedKeys, saveConfig, envFile, hasFileConfig } from './config.mjs';
import { runCheck } from './checks.mjs';
import { kindsMeta } from './integrations/index.mjs';
import { status, health, todayCount, currentHealth, readJson, changesFile, requestHistoric, requestRetry } from './engine.mjs';
import { VERSION, log } from './util.mjs';

// BASE_URL is the path the app is served under behind a reverse proxy: "/reportarr", or the full public URL
// "https://media.example.com/reportarr", which also lets that host save settings (Origin check below).
export function parseBase(value = process.env.BASE_URL) {
  if (!value) return { prefix: '', host: '' };
  let host = '', p = value.trim();
  if (/^https?:\/\//i.test(p)) { try { const u = new URL(p); host = u.host; p = u.pathname; } catch { log('BASE_URL ignored: not a valid URL'); return { prefix: '', host: '' }; } }
  p = '/' + p.replace(/^\/+|\/+$/g, '');
  if (p === '/') return { prefix: '', host };
  if (!/^\/[\w.~\-/]+$/.test(p)) { log('BASE_URL ignored: the path may only contain letters, digits and . _ ~ - /'); return { prefix: '', host }; }
  return { prefix: p, host };
}

// Behind a reverse proxy the Host header is often the internal one, so the browser's Origin is also accepted when it
// matches X-Forwarded-Host or the host in BASE_URL.
const sameOrigin = (req, baseHost) => {
  let host; try { host = new URL(req.headers.origin).host; } catch { return false; }
  const fwd = (req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  return [req.headers.host, fwd, baseHost].filter(Boolean).includes(host);
};

// Without a password, a page on any website could reach the UI through DNS rebinding (its own domain pointed at this
// server's address) and read every key. So, with no login, only accept addresses such a page can't use: an IP, localhost,
// a LAN name (no dot, or .local/.lan/.home.arpa/.internal), or the host in BASE_URL.
export const localHost = (req, baseHost) => {
  let h; try { h = new URL(`http://${req.headers.host ?? ''}`).hostname; } catch { return false; }
  return /^[\d.]+$|^\[[\da-f:.]+\]$|^[^.]+$|\.(local|lan|home\.arpa|internal)$/i.test(h) || (!!baseHost && h === new URL(`http://${baseHost}`).hostname);
};

const sha = (v) => crypto.createHash('sha256').update(v).digest();
const MAX_BODY = 1_000_000;

export function serve() {
  const { prefix, host: baseHost } = parseBase();
  const html = fs.readFileSync(new URL('../ui.html', import.meta.url), 'utf8').replace('"__BASE_URL__"', JSON.stringify(prefix ? prefix + '/' : ''));
  const pass = process.env.UI_PASSWORD;
  // no UI_PASSWORD means no login at all: the page just loads (a username on its own is not enough to turn auth on)
  if (!pass) log('UI_PASSWORD not set: the web UI is open to anyone who can reach it' + (process.env.UI_USERNAME ? ' (UI_USERNAME is ignored without a password)' : ''));
  const body = (req) => new Promise((res, rej) => {
    let d = '', big = false;
    req.on('data', (x) => { if (big) return; d += x; if (d.length > MAX_BODY) { big = true; d = ''; rej(new Error('request too large')); } });
    req.on('end', () => res(d));
  });
  const user = process.env.UI_USERNAME; // optional: unset accepts any username
  const authed = (req) => {
    if (!pass) return true;
    const [u, ...p] = Buffer.from((req.headers.authorization ?? '').slice(6), 'base64').toString().split(':');
    const passOk = crypto.timingSafeEqual(sha(p.join(':')), sha(pass));
    const userOk = !user || crypto.timingSafeEqual(sha(u), sha(user)); // evaluate both so timing doesn't reveal which was wrong
    return passOk && userOk;
  };
  return http.createServer(async (req, res) => {
    const send = (code, type, data) => { res.writeHead(code, { 'Content-Type': type }); res.end(data); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    if (!pass && !localHost(req, baseHost)) return send(403, 'text/plain', 'Refused: without UI_PASSWORD Reportarr only answers on an IP address or a LAN name. Set UI_PASSWORD, or put this address in BASE_URL.');
    if (!authed(req)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Reportarr"');
      return send(401, 'text/plain', 'auth required');
    }
    try {
      const url = new URL(req.url, 'http://x');
      // /reportarr -> /reportarr/ so the page's relative URLs resolve; a proxy that strips the prefix never sends this
      if (prefix && url.pathname === prefix) { res.writeHead(308, { Location: prefix + '/' + url.search }); return res.end(); }
      // Route on the /api/... suffix, so it works under any prefix whether or not the proxy strips it.
      const route = url.pathname.match(/\/api\/(state|env|config|historic|test|retry)$/)?.[0].slice(5) ?? '';
      if (route === 'state') {
        const c = getConfig();
        return send(200, 'application/json', JSON.stringify({
          config: publicConfig(), locked: lockedKeys(), kinds: kindsMeta(), status, version: VERSION, uiConfigured: hasFileConfig(), authEnabled: !!pass,
          today: todayCount(c), health: currentHealth(c), pollSeconds: c.pollSeconds,
          changes: readJson(changesFile(), []).reverse(),
        }));
      }
      if (route === 'env') {
        res.setHeader('Content-Disposition', 'attachment; filename="reportarr.env"');
        res.setHeader('Cache-Control', 'no-store');
        return send(200, 'text/plain; charset=utf-8', envFile());
      }
      if (req.method === 'POST' && ['config', 'historic', 'test', 'retry'].includes(route)) {
        // A cross-site page can send text/plain without a preflight, so insist on JSON and a same-origin request.
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(415, 'application/json', '{"error":"content-type must be application/json"}');
        if (req.headers.origin && !sameOrigin(req, baseHost)) return send(403, 'application/json', '{"error":"cross-origin request refused"}');
        if (route === 'test') {
          const req2 = JSON.parse(await body(req)), result = await runCheck(getConfig(), req2);
          const prefix2 = { source: 'source', arr: 'arr', client: 'client', notification: 'notification' }[req2.target];
          if (prefix2 && req2.name) health[`${prefix2}:${req2.name}`] = { ok: result.ok, message: result.message, at: new Date().toISOString() }; // so the status page shows it too
          return send(200, 'application/json', JSON.stringify(result));
        }
        if (route === 'historic') { requestHistoric(); return send(202, 'application/json', '{}'); }
        if (route === 'retry') { requestRetry(String(JSON.parse(await body(req)).id)); return send(202, 'application/json', '{}'); }
        saveConfig(JSON.parse(await body(req)));
        return send(200, 'application/json', '{}');
      }
      send(200, 'text/html', html);
    } catch (err) { send(400, 'application/json', JSON.stringify({ error: err.message })); }
  }).listen(+(process.env.UI_PORT ?? 8080), function () { log('web UI on :' + this.address().port); });
}
