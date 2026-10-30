import { describeLocator, worstVerdict, type CriterionResult, type LlmConfig } from '@sentinelqa/core';
import { checkCriterion, startScreencast, type SuiteData } from '@sentinelqa/engine';
import type { AgentChannel, Target } from './channel.ts';

/** SentinelQA at its desk: the same suite, with the gates and policies deciding every repair. */
export async function runSentinel(data: SuiteData, target: Target, llm: LlmConfig | null, ch: AgentChannel, opts: { stepDelayMs?: number } = {}): Promise<CriterionResult[]> {
  const results: CriterionResult[] = [];
  ch.log(`spec ${data.specGate.ok ? 'locked' : 'CHANGED'}: ${data.specGate.detail}`, data.specGate.ok ? 'dim' : 'bad');
  for (const c of data.contract.criteria.filter((x) => x.testable)) {
    ch.state('working', `${c.id} · checking`);
    ch.log(`$ sentinelqa check ${data.contract.ticket} ${c.id}`, 'cmd');
    const { result } = await checkCriterion(data, c, {
      baseURL: target.baseURL,
      mutations: target.mutations,
      mode: 'sentinel',
      llm,
      retryOnFail: true,
      stepDelayMs: opts.stepDelayMs,
      onPage: async (page) => void (await startScreencast(page, (f) => ch.frame(f), { fps: 6 })),
      onStep: ({ step }) => ch.log(`  ${step.do === 'goto' ? `goto ${step.url}` : `${step.do} ${step.key}`}`, 'dim'),
    });
    for (const h of result.heals) {
      ch.log(`  ${h.key}: locator broke → ${h.layer} best match ${h.candidate}`, 'info');
      ch.log(`    ${h.from ? describeLocator(h.from) : '—'} → ${h.to ? describeLocator(h.to) : '—'}`, 'dim');
      ch.log(`    ${h.gates.spec.ok ? '✓' : '✕'} spec      ${h.gates.spec.detail}`, h.gates.spec.ok ? 'ok' : 'bad');
      ch.log(`    ${h.gates.effect.ok ? '✓' : '✕'} effect    ${h.gates.effect.detail}`, h.gates.effect.ok ? 'ok' : 'bad');
      ch.log(`    ${h.gates.criteria.ok ? '✓' : '✕'} criteria  ${h.gates.criteria.detail}`, h.gates.criteria.ok ? 'ok' : 'bad');
      ch.log(`    → ${h.decision} (${h.rule})`, h.decision === 'accepted' ? 'ok' : h.decision === 'refused' ? 'bad' : 'warn');
    }
    const tone = result.verdict === 'PASS' || result.verdict === 'HEALED' ? 'ok' : result.verdict === 'REGRESSION' ? 'bad' : 'warn';
    ch.log(`${result.verdict} ${c.id} (${result.rule}) ${result.reason}`, tone);
    results.push(result);
  }
  const worst = worstVerdict(results.map((r) => r.verdict));
  const regressions = results.filter((r) => r.verdict === 'REGRESSION').map((r) => r.criterion);
  const headline =
    worst === 'REGRESSION' ? `REGRESSION caught · ${regressions.join(', ')}` : worst === 'NEEDS_REVIEW' ? 'repair waiting for review' : worst === 'HEALED' ? `${results.filter((r) => r.verdict === 'HEALED').length} healed, all checks pass` : `${worst.toLowerCase()} · all checks pass`;
  ch.log(`done: ${headline}`, worst === 'REGRESSION' ? 'bad' : 'ok');
  ch.state(worst === 'REGRESSION' || worst === 'ERROR' ? 'alert' : 'done', headline);
  return results;
}
