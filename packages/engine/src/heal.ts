import type { Page } from 'playwright';
import { chatJson, extractJson, type Fingerprint, type LlmConfig, type LocatorEntry } from '@sentinelqa/core';
import { collectCandidates, describeCandidate, locatorFor, type Candidate } from './locate.ts';
import { THRESHOLDS, explainChange, scoreCandidate } from './score.ts';
import type { UseKind } from './ground.ts';

const CLICKABLE = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem']);
const FILLABLE = new Set(['textbox', 'spinbutton', 'combobox', 'searchbox']);

/** A candidate must be usable the way the step uses the key. */
function usable(kind: UseKind, fp: Fingerprint): boolean {
  if (kind === 'click') return CLICKABLE.has(fp.role) || fp.tag === 'button' || fp.tag === 'a';
  if (kind === 'fill') return FILLABLE.has(fp.role);
  return true;
}

export interface Ranked {
  candidate: Candidate;
  score: number;
}

export async function rankCandidates(page: Page, base: Fingerprint, kind: UseKind): Promise<Ranked[]> {
  const cands = await collectCandidates(page);
  return cands
    .filter((c) => usable(kind, c.fingerprint))
    .map((c) => ({ candidate: c, score: scoreCandidate(base, c.fingerprint).total }))
    .sort((a, b) => b.score - a.score);
}

/** auto: may be accepted if every gate passes. review: a person must approve. */
export type Tier = 'auto' | 'review';

export interface HealProposal {
  key: string;
  entry: LocatorEntry;
  layer: 'L1' | 'L2';
  tier: Tier;
  score: number;
  runnerUp: number | null;
  candidate: string;
  reason: string;
}

async function tieBreak(cfg: LlmConfig, key: string, base: Fingerprint, options: Ranked[]): Promise<number | null> {
  const list = options.map((o, i) => ({ option: i, ...o.candidate.fingerprint, score: o.score }));
  const res = await chatJson(cfg, [
    {
      role: 'system',
      content:
        'You help a UI test find an element that moved. Given the element as it was and some candidates now on the page, pick the candidate that is the same control for the user. Answer JSON {"option": <number or null>, "why": "<short>"}. Use null if none is clearly the same control.',
    },
    { role: 'user', content: JSON.stringify({ key, was: base, candidates: list }) },
  ]);
  const out = extractJson(res.content) as { option?: number | null };
  return typeof out.option === 'number' && out.option >= 0 && out.option < options.length ? out.option : null;
}

export interface ProposeOptions {
  /** Used only to break ties between close candidates. */
  llm?: LlmConfig | null;
}

/**
 * L1: score every usable element against the baseline fingerprint.
 * L2: when the top two are too close, ask the LLM to pick between them.
 * Returns null when nothing is a credible match.
 */
export async function proposeHeal(page: Page, key: string, base: Fingerprint, kind: UseKind, opts: ProposeOptions = {}): Promise<HealProposal | null> {
  const ranked = await rankCandidates(page, base, kind);
  const top = ranked[0];
  if (!top || top.score < THRESHOLDS.min) return null;
  const second = ranked[1]?.score ?? null;
  const tie = second !== null && top.score - second < THRESHOLDS.tieGap;

  let pick = top;
  let layer: 'L1' | 'L2' = 'L1';
  let tier: Tier = !tie && top.score >= THRESHOLDS.auto ? 'auto' : 'review';
  if (tie && opts.llm) {
    const close = ranked.filter((r) => top.score - r.score < THRESHOLDS.tieGap).slice(0, 4);
    try {
      const i = await tieBreak(opts.llm, key, base, close);
      if (i !== null) {
        pick = close[i];
        layer = 'L2';
        tier = pick.score >= THRESHOLDS.auto ? 'auto' : 'review';
      }
    } catch {
      // no tie-break available; stays a review
    }
  }

  return {
    key,
    entry: await locatorFor(page, pick.candidate),
    layer,
    tier,
    score: pick.score,
    runnerUp: pick === top ? second : top.score,
    candidate: `${describeCandidate(pick.candidate.fingerprint)}, ${pick.score.toFixed(2)}`,
    reason: explainChange(base, pick.candidate.fingerprint) + (tie ? `; close to runner-up (${second?.toFixed(2)})` : ''),
  };
}
