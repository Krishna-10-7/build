import type { Baseline, Contract, LocatorMap } from '@sentinelqa/core';
import { ground } from './ground.ts';
import { runCriterion, type CriterionRun, type RunConfig } from './runner.ts';

export interface RecordOutcome {
  locators: LocatorMap;
  baseline: Baseline;
  runs: CriterionRun[];
  problems: string[];
}

/**
 * Runs the contract on the known-good app. Keys without a locator are grounded
 * from their intent; every key's fingerprint and every action's effect is kept
 * as the baseline that later heals are checked against.
 */
export async function recordBaseline(contract: Contract, existing: LocatorMap, cfg: RunConfig): Promise<RecordOutcome> {
  const locators: LocatorMap = { ...existing };
  const baseline: Baseline = {
    ticket: contract.ticket,
    recordedAt: new Date().toISOString(),
    target: cfg.baseURL,
    fingerprints: {},
    effects: {},
  };
  const runs: CriterionRun[] = [];
  const problems: string[] = [];

  for (const c of contract.criteria.filter((x) => x.testable)) {
    let run = await runCriterion(c, locators, { ...cfg, label: `baseline` }, {
      onUnresolved: async (u) => {
        if (locators[u.key]) return null; // a known locator failing on the good build is a real problem
        const g = await ground(u.page, u.intent, u.kind);
        if (!g) problems.push(`${u.criterion}: could not find "${u.intent}" for ${u.key}`);
        else if (g.score - g.runnerUp < 0.05) problems.push(`${u.criterion}: "${u.intent}" was a close call; check ${u.key} in locators.json`);
        return g?.entry ?? null;
      },
    });
    for (const [key, s] of Object.entries(run.substituted)) locators[key] = s.entry;
    // Watched elements could not be read before they were grounded; run again to capture their changes.
    if (run.ok && Object.keys(run.substituted).length) run = await runCriterion(c, locators, { ...cfg, label: 'baseline' });
    runs.push(run);
    if (!run.ok) {
      problems.push(`${c.id} does not pass on the baseline build: ${run.failure?.detail}`);
      continue;
    }
    for (const [key, fp] of Object.entries(run.fingerprints)) baseline.fingerprints[key] ??= fp;
    for (const [i, e] of Object.entries(run.effects)) baseline.effects[`${c.id}#${i}`] = e;
  }
  return { locators, baseline, runs, problems };
}
