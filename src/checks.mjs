// The Test buttons. Each integration knows how to test itself (check) and how to read the values on its card (checkArgs);
// this only finds the right one. Results never contain keys or passwords.
import { LISTS } from './integrations/index.mjs';
import { fail, why } from './util.mjs';

const TARGETS = { source: 'sources', arr: 'arrs', client: 'clients', notification: 'notifications' }; // what the UI calls a card -> the list it is in

// req is what the UI sends for one card: the values currently in the form. Blank secrets fall back to the saved ones by name.
export async function runCheck(c, req = {}) {
  const list = TARGETS[req.target], mod = list && Object.hasOwn(LISTS[list], req.kind) && LISTS[list][req.kind];
  if (!mod) return fail('Unknown test');
  const stored = req.name ? c[list].find((x) => x.name === req.name) : undefined;
  try { return await mod.check(mod.checkArgs(req, stored)); } catch (e) { return fail(`${mod.kind}: ${why(e)}`); }
}
