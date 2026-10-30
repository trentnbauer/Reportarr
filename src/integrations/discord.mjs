// Discord: a notification channel. Posts to a channel webhook (Server Settings, Integrations, Webhooks).
import { get, pass, fail, refused, SIGN_OFF } from '../util.mjs';
import { eventSwitches, flagsOf, eventFlags, eventsLine, envIndexes, clip } from './events.mjs';

// Only Discord's own webhook addresses are accepted, so the settings page cannot be used to make Reportarr post anywhere else.
export const HOOK = /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;
const COLORS = { replaced: 0xe5a00d, failed: 0xf97066, resolved: 0x4ade80, cap: 0xe5a00d, test: 0x9aa0a6 };
const entry = (name, webhook, username, events) => ({ name, kind: 'discord', webhook: webhook ?? '', username: username ?? '', ...eventFlags(events) });

const discord = {
  kind: 'discord', label: 'Discord', prefix: 'discord',
  fields: [
    { name: 'webhook', label: 'Webhook URL', type: 'password', set: 'webhookSet', hint: 'Server Settings, Integrations, Webhooks' },
    { name: 'username', label: 'Bot name', hint: 'Optional; defaults to Reportarr' },
  ],
  switches: eventSwitches,
  defaults: { webhook: '', username: '' },

  // DISCORD_WEBHOOK (+ DISCORD_NAME, DISCORD_USERNAME, DISCORD_EVENTS) is one channel; DISCORD_2_WEBHOOK / _NAME / _USERNAME / _EVENTS are more
  fromEnv(e) {
    const out = [];
    if (e.DISCORD_WEBHOOK) out.push(entry(e.DISCORD_NAME || 'discord', e.DISCORD_WEBHOOK, e.DISCORD_USERNAME, e.DISCORD_EVENTS));
    for (const n of envIndexes(e, 'DISCORD', 'WEBHOOK')) out.push(entry(e[`DISCORD_${n}_NAME`] || `discord-${n}`, e[`DISCORD_${n}_WEBHOOK`], e[`DISCORD_${n}_USERNAME`], e[`DISCORD_${n}_EVENTS`]));
    return out;
  },
  envLines: (s, n) => [[`DISCORD_${n}_NAME`, s.name], [`DISCORD_${n}_WEBHOOK`, s.webhook], [`DISCORD_${n}_USERNAME`, s.username], [`DISCORD_${n}_EVENTS`, eventsLine(s)]],
  validate: (x) => (x.webhook && !HOOK.test(x.webhook) ? 'the webhook must be a Discord webhook URL (https://discord.com/api/webhooks/...)' : ''),
  normalize: (s, old) => ({ name: s.name, kind: 'discord', webhook: s.webhook || old?.webhook || '', username: String(s.username ?? '').trim(), ...flagsOf(s) }),
  isConfigured: (s) => !!s.webhook, // the address was checked when it was saved (the environment is trusted)

  // msg is { event, title, lines }; an embed keeps a batch of replacements in one tidy message and cannot ping anyone
  async send(ch, msg) {
    const r = await get(ch.webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: ch.username || 'Reportarr', allowed_mentions: { parse: [] },
        embeds: [{ title: clip(msg.title, 250), description: clip(msg.lines.join('\n'), 3500), color: COLORS[msg.event] ?? COLORS.test, footer: { text: SIGN_OFF }, timestamp: new Date().toISOString() }],
      }),
    });
    if (!r.ok) throw new Error(`Discord ${refused(r.status, 'the webhook')}`);
  },

  checkArgs: (req, stored) => ({ webhook: req.webhook || stored?.webhook || '', username: req.username }),
  async check(ch) {
    if (!ch.webhook) return fail('Set a webhook URL first');
    if (!HOOK.test(ch.webhook)) return fail('That is not a Discord webhook URL (https://discord.com/api/webhooks/...)');
    await discord.send(ch, { event: 'test', title: 'Test message', lines: ['Reportarr can post to this channel.'] });
    return pass('Test message posted');
  },
};
export default discord;
