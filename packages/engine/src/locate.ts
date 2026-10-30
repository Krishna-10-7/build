import type { Locator, Page } from 'playwright';
import type { Fingerprint, LocatorEntry } from '@sentinelqa/core';

export function toLocator(page: Page, e: LocatorEntry): Locator {
  switch (e.strategy) {
    case 'testid':
      return page.getByTestId(e.value);
    case 'role':
      return page.getByRole(e.role as Parameters<Page['getByRole']>[0], { name: e.name, exact: true });
    case 'label':
      return page.getByLabel(e.name, { exact: true });
    case 'id':
      return page.locator(`[id="${e.value}"]`);
    case 'css':
      return page.locator(e.selector);
  }
}

export type Resolution =
  | { status: 'found'; locator: Locator }
  | { status: 'missing' }
  | { status: 'ambiguous'; count: number };

/** A key resolves only when its locator matches exactly one visible element. */
export async function resolve(page: Page, e: LocatorEntry): Promise<Resolution> {
  const loc = toLocator(page, e);
  const all = await loc.all();
  const shown: Locator[] = [];
  for (const l of all) if (await l.isVisible()) shown.push(l);
  if (shown.length === 1) return { status: 'found', locator: shown[0] };
  if (shown.length === 0) return { status: 'missing' };
  return { status: 'ambiguous', count: shown.length };
}

export async function fingerprintOf(loc: Locator): Promise<Fingerprint> {
  return loc.evaluate((el) => (window as any).__sq.fingerprint(el)) as Promise<Fingerprint>;
}

export interface Candidate {
  idx: number;
  fingerprint: Fingerprint;
  css: string;
}

export async function collectCandidates(page: Page): Promise<Candidate[]> {
  return page.evaluate('window.__sq.collect()') as Promise<Candidate[]>;
}

const ROLE_STRATEGY_ROLES = new Set(['button', 'link', 'textbox', 'spinbutton', 'checkbox', 'radio', 'combobox', 'heading', 'tab', 'menuitem']);

/** Locator strategies to try for an element, most robust first. */
function strategies(c: Candidate): LocatorEntry[] {
  const fp = c.fingerprint;
  const out: LocatorEntry[] = [];
  if (fp.testid) out.push({ strategy: 'testid', value: fp.testid });
  if (fp.name && ROLE_STRATEGY_ROLES.has(fp.role)) out.push({ strategy: 'role', role: fp.role, name: fp.name });
  if (fp.id) out.push({ strategy: 'id', value: fp.id });
  out.push({ strategy: 'css', selector: c.css });
  return out;
}

/**
 * Picks the most robust locator that matches this candidate and nothing else.
 * Must be called right after collectCandidates, while the data-sq-idx marks are on the page.
 */
export async function locatorFor(page: Page, c: Candidate): Promise<LocatorEntry> {
  for (const e of strategies(c)) {
    const r = await resolve(page, e);
    if (r.status !== 'found') continue;
    const idx = await r.locator.getAttribute('data-sq-idx');
    if (idx === String(c.idx)) return e;
  }
  return { strategy: 'css', selector: c.css };
}

export function describeCandidate(fp: Fingerprint): string {
  const label = fp.name || fp.text || fp.placeholder || fp.testid || fp.id || fp.tag;
  return `${fp.role} '${label}'`;
}
