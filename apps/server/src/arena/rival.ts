import { z } from 'zod';
import { Criterion, LocatorEntry, chatJson, describeLocator, extractJson, type Contract, type LlmConfig, type LocatorMap } from '@sentinelqa/core';
import { collectCandidates, generateSpec, runCriterion, startScreencast, type CriterionRun } from '@sentinelqa/engine';
import { lineDiff, type AgentChannel, type Target } from './channel.ts';

/**
 * The usual way AI agents maintain UI tests: when a test fails, show a model the
 * error, the page and the test, apply whatever edit it returns, and rerun until
 * green. Nothing stops it from changing what the test checks, which is exactly
 * how a real regression can be "fixed" away.
 */

const SYSTEM = `You are a test maintenance agent for Playwright UI tests.
A test failed after the app under test was updated. Update the test so that it passes against the current app.
Prefer fixing element locators. If the app's behaviour or texts changed on purpose, update the steps or expected values to match.
Reply with JSON only:
{
  "explanation": "<one or two sentences>",
  "locators": { "<key>": { "strategy": "testid", "value": "..." } | { "strategy": "role", "role": "button", "name": "..." } | { "strategy": "id", "value": "..." } | { "strategy": "css", "selector": "..." } },
  "steps": [ ...the full list of steps, same format as given... ],
  "expect": [ ...the full list of expectations, same format as given... ]
}
Include "locators" only for keys you change. Always return the full "steps" and "expect" lists.`;

const Fix = z.object({
  explanation: z.string().default(''),
  locators: z.record(z.string(), LocatorEntry).optional(),
  steps: z.array(z.unknown()),
  expect: z.array(z.unknown()),
});

export interface RivalCriterionResult {
  criterion: string;
  green: boolean;
  attempts: number;
  editedAssertions: boolean;
  editedSteps: boolean;
  editedLocators: string[];
  lastError?: string;
}

interface PageSnapshot {
  url: string;
  elements: string[];
}

async function snapshot(run: { page: import('playwright').Page }): Promise<PageSnapshot> {
  const cands = await collectCandidates(run.page).catch(() => []);
  const seen = new Set<string>();
  const elements: string[] = [];
  for (const c of cands) {
    const f = c.fingerprint;
    if (f.role === 'generic' && !f.testid && !f.id) continue;
    const line = [f.role, f.name && `"${f.name.slice(0, 50)}"`, f.testid && `testid=${f.testid}`, f.id && `id=${f.id}`, f.placeholder && `placeholder="${f.placeholder}"`].filter(Boolean).join(' ');
    if (seen.has(line)) continue;
    seen.add(line);
    elements.push(line);
    if (elements.length >= 45) break;
  }
  return { url: new URL(run.page.url()).pathname, elements };
}

function specFor(ticket: string, title: string, c: Criterion): string {
  const src = generateSpec({ ticket, title, source: 'manual', criteria: [c] } as Contract);
  const start = src.indexOf('  test(');
  return src.slice(start, src.lastIndexOf('});')).trimEnd();
}

export async function runRival(
  contract: Contract,
  locatorsIn: LocatorMap,
  target: Target,
  llm: LlmConfig,
  ch: AgentChannel,
  opts: { maxAttempts?: number; stepDelayMs?: number } = {},
): Promise<RivalCriterionResult[]> {
  const locators: LocatorMap = { ...locatorsIn };
  const results: RivalCriterionResult[] = [];
  const maxAttempts = opts.maxAttempts ?? 3;

  for (const original of contract.criteria.filter((c) => c.testable)) {
    let c: Criterion = structuredClone(original);
    const res: RivalCriterionResult = { criterion: c.id, green: false, attempts: 0, editedAssertions: false, editedSteps: false, editedLocators: [] };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      res.attempts = attempt;
      ch.state('working', `${c.id} · run ${attempt}`);
      ch.log(`$ npx playwright test -g "${contract.ticket} ${c.id}"`, 'cmd');
      let snap: PageSnapshot | null = null;
      const run: CriterionRun = await runCriterion(c, locators, {
        baseURL: target.baseURL,
        mutations: target.mutations,
        stepDelayMs: opts.stepDelayMs,
        onPage: async (page) => void (await startScreencast(page, (f) => ch.frame(f), { fps: 6 })),
        onStep: ({ step }) => ch.log(`  ${step.do === 'goto' ? `goto ${step.url}` : `${step.do} ${step.key}`}`, 'dim'),
        onFinish: async (page, r) => {
          if (!r.ok) snap = await snapshot({ page });
        },
      });
      if (run.ok) {
        res.green = true;
        ch.log(`✓ ${c.id} passed`, 'ok');
        break;
      }
      res.lastError = run.failure?.detail;
      ch.log(`✕ ${c.id} failed: ${run.failure?.detail}`, 'bad');
      if (attempt === maxAttempts) break;

      ch.state('thinking', `${c.id} · asking ${llm.model} for a fix`);
      ch.log(`🤖 asking ${llm.model} to fix the test…`, 'info');
      const keys = new Set([...c.steps, ...c.expect].flatMap((s) => ('key' in s ? [s.key] : [])));
      const prompt = {
        failure: run.failure?.detail,
        page: snap ?? { url: 'unknown', elements: [] },
        test: { id: c.id, criterion: c.text, steps: c.steps, expect: c.expect },
        locators: Object.fromEntries([...keys].map((k) => [k, locators[k]])),
      };
      let fix: z.infer<typeof Fix>;
      try {
        const reply = await chatJson(llm, [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify(prompt) },
        ]);
        fix = Fix.parse(extractJson(reply.content));
      } catch (err) {
        ch.log(`model error: ${(err as Error).message.slice(0, 200)}`, 'warn');
        continue;
      }
      const next = Criterion.safeParse({ ...c, steps: fix.steps, expect: fix.expect });
      if (!next.success) {
        ch.log(`model returned an invalid test: ${next.error.issues[0]?.message}`, 'warn');
        continue;
      }
      ch.log(`↳ ${fix.explanation}`, 'info');
      const before = specFor(contract.ticket, contract.title, c);
      if (JSON.stringify(next.data.expect) !== JSON.stringify(c.expect)) res.editedAssertions = true;
      if (JSON.stringify(next.data.steps) !== JSON.stringify(c.steps)) res.editedSteps = true;
      c = next.data;
      for (const [k, e] of Object.entries(fix.locators ?? {})) {
        if (JSON.stringify(locators[k]) === JSON.stringify(e)) continue;
        ch.log(`  locators.json ${k}: ${locators[k] ? describeLocator(locators[k]) : '—'} → ${describeLocator(e)}`, 'warn');
        locators[k] = e;
        if (!res.editedLocators.includes(k)) res.editedLocators.push(k);
      }
      const diff = lineDiff(before, specFor(contract.ticket, contract.title, c)).filter((d) => d.tone !== 'dim');
      for (const d of diff) ch.log(d.text, d.tone);
    }
    results.push(res);
    if (res.editedAssertions) ch.log(`⚠ ${c.id}: the expected result was rewritten to match the app`, 'warn');
  }
  const green = results.filter((r) => r.green).length;
  const rewrote = results.filter((r) => r.editedAssertions).length;
  ch.log(`done: ${green}/${results.length} green${rewrote ? `, ${rewrote} assertion${rewrote > 1 ? 's' : ''} rewritten` : ''}`, green === results.length ? 'ok' : 'bad');
  ch.state('done', `${green}/${results.length} green${rewrote ? ` · ${rewrote} assertion${rewrote > 1 ? 's' : ''} rewritten` : ''}`);
  return results;
}
