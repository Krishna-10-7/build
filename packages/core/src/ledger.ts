import { z } from 'zod';
import { LocatorEntry } from './locators.ts';

export const Verdict = z.enum(['PASS', 'HEALED', 'NEEDS_REVIEW', 'REGRESSION', 'FLAKY', 'ERROR']);
export type Verdict = z.infer<typeof Verdict>;

export const GateResult = z.object({
  ok: z.boolean(),
  detail: z.string(),
});
export type GateResult = z.infer<typeof GateResult>;

/** One entry in the heal ledger: every repair attempt is written down, accepted or not. */
export const HealRecord = z.object({
  key: z.string(),
  criterion: z.string(),
  step: z.number(),
  layer: z.enum(['L1', 'L2']),
  score: z.number(),
  runnerUp: z.number().nullable(),
  from: LocatorEntry,
  to: LocatorEntry.nullable(),
  candidate: z.string(),
  reason: z.string(),
  gates: z.object({
    spec: GateResult,
    effect: GateResult,
    criteria: GateResult,
  }),
  decision: z.enum(['accepted', 'review', 'refused']),
  /** Policy rule that made the decision, e.g. "heal@1 H2". */
  rule: z.string(),
});
export type HealRecord = z.infer<typeof HealRecord>;

export const ExpectResult = z.object({
  id: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
export type ExpectResult = z.infer<typeof ExpectResult>;

export const CriterionResult = z.object({
  ticket: z.string(),
  criterion: z.string(),
  title: z.string(),
  verdict: Verdict,
  /** Policy rule that chose the verdict, e.g. "verdict@1 V3". */
  rule: z.string(),
  reason: z.string(),
  durationMs: z.number(),
  attempts: z.number(),
  expects: z.array(ExpectResult),
  heals: z.array(HealRecord),
  screenshots: z.array(z.string()),
});
export type CriterionResult = z.infer<typeof CriterionResult>;

export const VERDICT_RANK: Record<Verdict, number> = {
  PASS: 0,
  HEALED: 1,
  FLAKY: 2,
  NEEDS_REVIEW: 3,
  REGRESSION: 4,
  ERROR: 5,
};

/** The verdict for a whole run is the worst criterion verdict. */
export function worstVerdict(verdicts: Verdict[]): Verdict {
  return verdicts.reduce<Verdict>((w, v) => (VERDICT_RANK[v] > VERDICT_RANK[w] ? v : w), 'PASS');
}
