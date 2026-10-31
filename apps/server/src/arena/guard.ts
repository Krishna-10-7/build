import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Page } from 'playwright';

/**
 * A page under test may load its own origin and the public web, nothing else: no other service on
 * this machine, no private network, no cloud metadata. A hostile app could otherwise point the agents'
 * browsers at them.
 */
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./, /^::1$/, /^::$/, /^f[cd]/i, /^fe80/i, /^::ffff:(127|10|192\.168|169\.254)\./i];

export const isPrivateAddress = (a: string) => PRIVATE.some((re) => re.test(a));

const verdicts = new Map<string, Promise<boolean>>();

async function hostIsPublic(host: string): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal') return false;
  if (isIP(h)) return !isPrivateAddress(h);
  let v = verdicts.get(h);
  if (!v) {
    v = lookup(h, { all: true })
      .then((addrs) => addrs.every((a) => !isPrivateAddress(a.address)))
      .catch(() => false);
    verdicts.set(h, v);
    if (verdicts.size > 2000) verdicts.clear();
  }
  return v;
}

export async function guardPage(page: Page, baseURL: string) {
  const own = new URL(baseURL);
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (!/^https?:/.test(url) || url.startsWith(own.origin)) return route.continue();
    if (await hostIsPublic(new URL(url).hostname)) return route.continue();
    return route.abort('blockedbyclient');
  });
  // WebSockets bypass page.route, so they get the same fence.
  await page.routeWebSocket(/.*/, async (ws) => {
    const u = new URL(ws.url());
    if (u.host === own.host || (await hostIsPublic(u.hostname))) ws.connectToServer();
    else await ws.close({ code: 1008, reason: 'blocked by SentinelQA' });
  });
}
