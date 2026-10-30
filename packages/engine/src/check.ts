import { policies, type Baseline, type Contract, type Criterion, type CriterionResult, type GateResult, type HealRecord, type LlmConfig, type LocatorMap, type Verdict } from '@sentinelqa/core';
import { compareEffects } from './effects.ts';
import { proposeHeal, type HealProposal } from './heal.ts';
import { runCriterion, type CriterionRun, type RunConfig } from './runner.ts';
import type { UseKind } from './ground.ts';
import type { Suite } from './suite.ts';

/**
 * none       no healing; broken locators fail
 * plain      take the best L1 match above 0.55, no gates (how most self-healing tools behave)
 * no-effect  SentinelQA without gate 2, for the ablation in the benchmark
 * sentinel   all three gates
 */
export type HealMode = 'none' | 'plain' | 'no-effect' | 'sentinel';

export interface CheckOptions extends RunConfig {
  mode: HealMode;
  llm?: LlmConfig | null;
  /** Run a failing criterion once more without healing to tell flaky from broken. */
  retryOnFail?: boolean;
}

export interface SuiteData {
  contract: Contract;
  locators: LocatorMap;
  baseline: Baseline;
  specGate: GateResult;
}

export interface CriterionCheck {
  result: CriterionResult;
  /** Heals that passed every gate; safe to write to locators.json. */
  accepted: LocatorMap;
  /** Heals waiting for a person. */
  review: LocatorMap;
}

interface Attempt {
  proposal: HealProposal;
  kind: UseKind;
  step: number;
}

function effectGate(c: Criterion, a: Attempt, run: CriterionRun, baseline: Baseline): GateResult & { unverifiable?: boolean } {
  if (a.kind !== 'click') return { ok: true, detail: `${a.kind === 'fill' ? 'input' : 'read-only'} step; verified by the criterion checks` };
  const expected = baseline.effects[`${c.id}#${a.step}`];
  if (!expected) return { ok: false, unverifiable: true, detail: 'no baseline effect recorded for this step' };
  const observed = run.effects[a.step];
  if (!observed) return { ok: false, detail: 'the healed step did not complete' };
  const cmp = compareEffects(expected, observed);
  return { ok: cmp.match, unverifiable: cmp.unverifiable, detail: cmp.detail };
}

/** Steps that passed with their own locator but now do something else. */
function behaviourDrift(c: Criterion, run: CriterionRun, baseline: Baseline, skip: Set<number>): string[] {
  const out: string[] = [];
  for (const [i, observed] of Object.entries(run.effects)) {
    if (skip.has(Number(i))) continue;
    const expected = baseline.effects[`${c.id}#${i}`];
    if (!expected) continue;
    const cmp = compareEffects(expected, observed);
    if (!cmp.match && !cmp.unverifiable) out.push(`step ${Number(i) + 1} (${c.steps[Number(i)].do}): ${cmp.detail}`);
  }
  return out;
}

export async function checkCriterion(data: SuiteData, c: Criterion, opts: CheckOptions): Promise<CriterionCheck> {
  const attempts = new Map<string, Attempt>();
  const misses: string[] = [];

  const run = await runCriterion(c, data.locators, opts, {
    onUnresolved: async (u) => {
      if (opts.mode === 'none') return null;
      const base = data.baseline.fingerprints[u.key];
      if (!base) {
        misses.push(`${u.key}: no baseline fingerprint`);
        return null;
      }
      const proposal = await proposeHeal(u.page, u.key, base, u.kind, { llm: opts.mode === 'sentinel' ? opts.llm : null });
      if (!proposal) {
        misses.push(`${u.key}: ${u.resolution.status}, no candidate scored above the minimum`);
        return null;
      }
      attempts.set(u.key, { proposal, kind: u.kind, step: u.step });
      return proposal.entry;
    },
  });

  const accepted: LocatorMap = {};
  const review: LocatorMap = {};
  const heals: HealRecord[] = [];
  const { heal: healPolicy, verdict: verdictPolicy } = policies();
  const criteriaGate: GateResult = run.ok
    ? { ok: true, detail: `all ${run.expects.length} checks pass` }
    : { ok: false, detail: run.failure?.detail ?? 'failed' };

  // Gate 1 (spec), gate 2 (effect) and gate 3 (criteria) become facts; the heal policy decides.
  for (const [key, a] of attempts) {
    const effect: GateResult & { unverifiable?: boolean } =
      opts.mode === 'sentinel' ? effectGate(c, a, run, data.baseline) : { ok: true, detail: `not checked (${opts.mode} mode)` };
    const d = healPolicy.evaluate({
      mode: opts.mode,
      tier: a.proposal.tier,
      kind: a.kind,
      specOk: data.specGate.ok,
      effectOk: effect.ok,
      effectUnverifiable: Boolean(effect.unverifiable),
      criteriaOk: criteriaGate.ok,
    });
    const decision = d.decision as HealRecord['decision'];
    if (decision === 'accepted') accepted[key] = a.proposal.entry;
    if (decision === 'review') review[key] = a.proposal.entry;
    heals.push({
      key,
      criterion: c.id,
      step: a.step,
      layer: a.proposal.layer,
      score: a.proposal.score,
      runnerUp: a.proposal.runnerUp,
      from: data.locators[key],
      to: a.proposal.entry,
      candidate: a.proposal.candidate,
      reason: a.proposal.reason,
      gates: { spec: data.specGate, effect: { ok: effect.ok, detail: effect.detail }, criteria: criteriaGate },
      decision,
      rule: `${d.policy} ${d.rule}`,
    });
  }

  const drift = run.ok && opts.mode === 'sentinel' ? behaviourDrift(c, run, data.baseline, new Set(heals.map((h) => h.step))) : [];
  let attemptsMade = 1;
  let retriedOk = false;
  if (!run.ok && !attempts.size && opts.retryOnFail && run.failure?.kind !== 'navigation' && run.failure?.kind !== 'crash') {
    attemptsMade++;
    retriedOk = (await runCriterion(c, data.locators, { ...opts, artifactsDir: undefined })).ok;
  }

  const refused = heals.filter((h) => h.decision === 'refused');
  const pending = heals.filter((h) => h.decision === 'review');
  const v = verdictPolicy.evaluate({
    mode: opts.mode,
    runOk: run.ok,
    failureKind: run.failure?.kind ?? 'none',
    heals: heals.length,
    refused: refused.length,
    review: pending.length,
    drift: drift.length > 0,
    retriedOk,
  });
  const verdict = v.decision as Verdict;
  const reason = explainVerdict(verdict, { run, heals, refused, pending, drift, misses });
  return {
    accepted,
    review,
    result: {
      ticket: data.contract.ticket,
      criterion: c.id,
      title: c.text,
      verdict,
      rule: `${v.policy} ${v.rule}`,
      reason,
      durationMs: run.durationMs,
      attempts: attemptsMade,
      expects: run.expects,
      heals,
      screenshots: run.screenshots,
    },
  };
}

interface Explain {
  run: CriterionRun;
  heals: HealRecord[];
  refused: HealRecord[];
  pending: HealRecord[];
  drift: string[];
  misses: string[];
}

function explainVerdict(verdict: Verdict, x: Explain): string {
  const failed = x.run.failure?.detail ?? 'failed';
  switch (verdict) {
    case 'PASS':
      return `all ${x.run.expects.length} checks pass`;
    case 'HEALED':
      return x.heals.map((h) => `${h.key}: ${h.reason}`).join(' | ');
    case 'FLAKY':
      return `failed once (${failed}), passed on retry`;
    case 'ERROR':
      return failed;
    case 'NEEDS_REVIEW': {
      const r = x.pending[0];
      return r ? `proposed ${r.key} -> ${r.candidate}; needs approval (${r.gates.effect.detail})` : `checks pass but behaviour changed: ${x.drift.join('; ')}`;
    }
    case 'REGRESSION': {
      const h = x.refused[0];
      if (h) {
        const why = !h.gates.spec.ok ? h.gates.spec.detail : !h.gates.effect.ok ? h.gates.effect.detail : h.gates.criteria.detail;
        return `look-alike for ${h.key} found (${h.candidate}) but heal refused: ${why}`;
      }
      return x.misses.length ? `${failed} (${x.misses.join('; ')})` : failed;
    }
  }
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return out;
}

export interface SuiteCheck {
  results: CriterionResult[];
  accepted: LocatorMap;
  review: LocatorMap;
}

/** Runs every testable criterion of a suite. With `commit`, accepted heals are written to locators.json. */
export async function checkSuite(suite: Suite, opts: CheckOptions & { concurrency?: number; commit?: boolean }): Promise<SuiteCheck> {
  const contract = await suite.contract();
  const baseline = await suite.baseline();
  if (!contract || !baseline) throw new Error(`${suite.ticket} needs a contract and a baseline first`);
  const data: SuiteData = { contract, baseline, locators: await suite.locators(), specGate: await suite.verifySpec() };
  const criteria = contract.criteria.filter((c) => c.testable);
  const checks = await pool(criteria, opts.concurrency ?? Number(process.env.WORKERS ?? 2), (c) => checkCriterion(data, c, opts));
  const accepted: LocatorMap = Object.assign({}, ...checks.map((x) => x.accepted));
  const review: LocatorMap = Object.assign({}, ...checks.map((x) => x.review));
  if (opts.commit && opts.mode === 'sentinel' && Object.keys(accepted).length) {
    await suite.saveLocators({ ...data.locators, ...accepted });
  }
  return { results: checks.map((x) => x.result), accepted, review };
}
