import { chromium, type Browser, type BrowserContext } from 'playwright';
import { DOM_SCRIPT } from './dom.ts';

export interface ContextOptions {
  baseURL: string;
  /** ShopLite mutation flags, sent as a cookie so parallel contexts can differ. */
  mutations?: string[];
}

let shared: Promise<Browser> | null = null;

export function browser(): Promise<Browser> {
  if (!shared) {
    shared = chromium.launch({
      channel: process.env.PW_CHANNEL || undefined,
      headless: process.env.HEADED !== '1',
    });
  }
  return shared;
}

export async function closeBrowser(): Promise<void> {
  if (!shared) return;
  const b = await shared;
  shared = null;
  await b.close();
}

export async function newContext(opts: ContextOptions): Promise<BrowserContext> {
  const ctx = await (await browser()).newContext({ baseURL: opts.baseURL, viewport: { width: 1280, height: 800 } });
  ctx.setDefaultTimeout(Number(process.env.ACTION_TIMEOUT_MS ?? 2500));
  ctx.setDefaultNavigationTimeout(10_000);
  await ctx.addInitScript({ content: DOM_SCRIPT });
  if (opts.mutations?.length) {
    const host = new URL(opts.baseURL).hostname;
    await ctx.addCookies([{ name: 'sl_mut', value: opts.mutations.join(','), domain: host, path: '/' }]);
  }
  return ctx;
}
