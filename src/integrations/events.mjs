// What every notification channel (Discord, email) shares: the events it can be told about and how they are set.
// Each event is a switch on the channel's card (onReplaced ...), on unless turned off.
export const EVENTS = [
  { name: 'onReplaced', event: 'replaced', label: 'Replacements', hint: 'When a file is deleted and searched again' },
  { name: 'onFailed', event: 'failed', label: 'Failures', hint: 'When a report or connection fails' },
  { name: 'onResolved', event: 'resolved', label: 'Resolved', hint: 'When the new file is in Plex' },
  { name: 'onCap', event: 'cap', label: 'Hourly limit reached', hint: 'When MAX_PER_HOUR is hit' },
];
export const eventSwitches = EVENTS.map(({ name, label, hint }) => ({ name, label, hint }));
export const wants = (channel, event) => channel[EVENTS.find((x) => x.event === event).name] !== false;
// the on/off flags to store for a card
export const flagsOf = (s) => Object.fromEntries(EVENTS.map((x) => [x.name, s[x.name] !== false]));
// FOO_EVENTS=replaced,failed turns on only those; unset or blank leaves every event on
export const eventFlags = (v) => (v ? Object.fromEntries(EVENTS.map((x) => [x.name, String(v).split(',').map((s) => s.trim().toLowerCase()).includes(x.event)])) : {});
export const eventsLine = (s) => EVENTS.filter((x) => s[x.name] !== false).map((x) => x.event).join(',');

// The numbers n for which PREFIX_n_KEY is set in the environment, in order.
export const envIndexes = (e, prefix, key) => [...new Set(Object.keys(e).map((k) => k.match(new RegExp(`^${prefix}_(\\d+)_${key}$`))?.[1]).filter(Boolean))].sort((a, b) => a - b);

export const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
