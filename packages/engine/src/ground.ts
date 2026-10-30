import type { Page } from 'playwright';
import type { Fingerprint, LocatorEntry } from '@sentinelqa/core';
import { collectCandidates, locatorFor, type Candidate } from './locate.ts';
import { similarity, tokens } from './similarity.ts';

export type UseKind = 'click' | 'fill' | 'read';

const CLICKABLE = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem']);
const FILLABLE = new Set(['textbox', 'spinbutton', 'combobox', 'searchbox']);

/** How well an element matches a contract intent such as "Add to cart button". */
export function intentScore(intent: string, kind: UseKind, fp: Fingerprint): number {
  const fields = [fp.name, fp.text, fp.testid, fp.id, fp.placeholder, fp.attrName];
  let best = 0;
  for (const f of fields) if (f) best = Math.max(best, similarity(intent, f));
  const words = new Set(tokens(intent));
  if (words.has(fp.role)) best += 0.1;
  if (kind === 'click') best += CLICKABLE.has(fp.role) ? 0.15 : -0.3;
  if (kind === 'fill') best += FILLABLE.has(fp.role) ? 0.15 : -0.5;
  if (kind === 'read' && (CLICKABLE.has(fp.role) || FILLABLE.has(fp.role))) best -= 0.1;
  if (!fp.visible) best -= 0.5;
  return best;
}

export interface Grounding {
  entry: LocatorEntry;
  candidate: Candidate;
  score: number;
  runnerUp: number;
}

/**
 * Maps an intent to a concrete element the first time a key is used, on the
 * known-good version of the app. The result is written to locators.json.
 */
export async function ground(page: Page, intent: string, kind: UseKind): Promise<Grounding | null> {
  const cands = await collectCandidates(page);
  const ranked = cands
    .map((c) => ({ c, score: intentScore(intent, kind, c.fingerprint) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top || top.score < 0.5) return null;
  return { entry: await locatorFor(page, top.c), candidate: top.c, score: top.score, runnerUp: ranked[1]?.score ?? 0 };
}
