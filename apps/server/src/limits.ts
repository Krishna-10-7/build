import { llmConfigFromEnv, type LlmConfig } from '@sentinelqa/core';
import { unseal } from './secrets.ts';
import type { Tenancy } from './tenancy.ts';

/**
 * Fair use on a shared VM. Every person gets a daily number of runs and of Fixer runs on the shared
 * LLM key; with their own key the Fixer has no daily cap. The operator and the shared demo have none.
 */
export const LIMITS = {
  runsPerDay: Number(process.env.QUOTA_RUNS_PER_DAY ?? 25),
  llmRunsPerDay: Number(process.env.QUOTA_LLM_RUNS_PER_DAY ?? 15),
  queuedPerUser: Number(process.env.QUOTA_QUEUED ?? 3),
};

export class LimitError extends Error {
  statusCode = 429;
}

export class Limits {
  constructor(private tenancy: Tenancy) {}

  /** Throws when `owner` may not start another run now. `queued` is how many of theirs are waiting. */
  admit(owner: number | null, queued: number) {
    if (owner == null) return;
    const u = this.tenancy.user(owner);
    if (!u || u.disabled) throw Object.assign(new Error('this account is disabled'), { statusCode: 403 });
    if (u.role === 'operator') return;
    if (queued >= LIMITS.queuedPerUser) throw new LimitError(`you already have ${queued} runs waiting; the limit is ${LIMITS.queuedPerUser}`);
    const used = this.tenancy.usage(owner).runs;
    if (used >= LIMITS.runsPerDay) throw new LimitError(`daily limit reached: ${used} of ${LIMITS.runsPerDay} runs today`);
  }

  counted(owner: number | null) {
    if (owner != null) this.tenancy.count(owner, 'run');
  }

  /** The LLM the Fixer may use for `owner`'s run, or why it sits this one out. */
  llmFor(owner: number | null): { llm: LlmConfig | null; note?: string; shared: boolean } {
    const base = llmConfigFromEnv();
    const rival = base ? { ...base, model: process.env.RIVAL_MODEL || base.model } : null;
    if (owner == null) return { llm: rival, shared: true };
    const u = this.tenancy.user(owner);
    if (u?.llm_key && rival) {
      try {
        return { llm: { ...rival, apiKey: unseal(u.llm_key) }, shared: false };
      } catch {
        return { llm: null, note: 'your saved LLM key could not be read; save it again', shared: false };
      }
    }
    if (u?.role === 'operator') return { llm: rival, shared: true };
    const used = this.tenancy.usage(owner).llm_runs;
    if (used >= LIMITS.llmRunsPerDay) return { llm: null, note: `the shared LLM key is used up for you today (${used}/${LIMITS.llmRunsPerDay}); add your own key in Agent access`, shared: true };
    return { llm: rival, shared: true };
  }

  /** Called when the Fixer actually ran on the shared key. */
  usedSharedLlm(owner: number | null) {
    if (owner != null) this.tenancy.count(owner, 'llm');
  }
}
