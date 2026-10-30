import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileTicket, llmConfigFromEnv, parseTicketFile, worstVerdict, type CompileMode, type Contract, type HealRecord, type Ticket } from '@sentinelqa/core';
import { Suite, checkSuite, recordBaseline, type HealMode } from '@sentinelqa/engine';
import type { Store } from './db.ts';
import { nextActions, transition, type Action } from './pipeline.ts';
import { fetchIssue, postRunComment, type JiraConfig } from './jira.ts';

export interface Config {
  ticketsDir: string;
  suitesDir: string;
  artifactsDir: string;
  /** App under test. Check runs send mutation flags; the baseline uses none. */
  targetUrl: string;
  baselineUrl: string;
  workers: number;
  jira: JiraConfig | null;
  /** Public dashboard URL, linked from Jira comments. */
  publicUrl?: string;
}

export interface BusEvent {
  type: string;
  ticket?: string;
  runId?: number;
  message: string;
  data?: unknown;
}

/** One job at a time: browsers are the expensive part, and each job already runs criteria in parallel. */
class JobQueue {
  private tail: Promise<unknown> = Promise.resolve();
  pending = 0;

  push<T>(job: () => Promise<T>): Promise<T> {
    this.pending++;
    const next = this.tail.then(job, job).finally(() => this.pending--);
    this.tail = next.catch(() => {});
    return next;
  }
}

export class SentinelService {
  readonly bus = new EventEmitter();
  private queue = new JobQueue();

  constructor(readonly store: Store, readonly cfg: Config) {}

  private emit(e: BusEvent) {
    this.store.addEvent(e.type, e.message, e.ticket, e.runId);
    this.bus.emit('event', { ...e, at: new Date().toISOString() });
  }

  suite(key: string): Suite {
    return Suite.at(this.cfg.suitesDir, key);
  }

  /** Moves a ticket to its next stage, refusing anything out of order. */
  private advance(key: string, action: Action) {
    const t = this.store.ticket(key);
    if (!t) throw new Error(`unknown ticket ${key}`);
    const step = transition(t.stage, action);
    this.store.setStage(key, step.to);
    this.emit({ type: 'stage', ticket: key, message: `${t.stage} -> ${step.to}: ${step.why}`, data: { from: t.stage, to: step.to, action } });
  }

  private assertAllowed(key: string, action: Action) {
    const t = this.store.ticket(key);
    if (!t) throw new Error(`unknown ticket ${key}`);
    transition(t.stage, action);
  }

  async syncTicketFiles(): Promise<number> {
    let n = 0;
    for (const f of await readdir(this.cfg.ticketsDir).catch(() => [] as string[])) {
      if (!f.endsWith('.md')) continue;
      const t = parseTicketFile(await readFile(join(this.cfg.ticketsDir, f), 'utf8'));
      if (!this.store.ticket(t.key)) n++;
      this.store.upsertTicket(t);
    }
    return n;
  }

  receive(t: Ticket) {
    const known = this.store.ticket(t.key);
    this.store.upsertTicket(t);
    this.emit({ type: 'ticket', ticket: t.key, message: `${known ? 'updated' : 'received'} ${t.key}: ${t.title} (${t.criteria.length} criteria)` });
  }

  async ticketDetail(key: string) {
    const t = this.store.ticket(key);
    if (!t) return null;
    const suite = this.suite(key);
    const spec = await readFile(suite.specFile, 'utf8').catch(() => null);
    return {
      ticket: t,
      nextActions: nextActions(t.stage),
      contract: await suite.contract().catch(() => null),
      locators: await suite.locators().catch(() => ({})),
      baseline: await suite.baseline().catch(() => null),
      spec,
      specGate: spec ? await suite.verifySpec() : null,
      runs: this.store.runs(key, 20),
    };
  }

  async compile(key: string, mode: CompileMode = 'auto') {
    this.assertAllowed(key, 'compile');
    const t = this.store.ticket(key)!;
    this.emit({ type: 'compile', ticket: key, message: `compiling ${t.criteria.length} criteria (${mode === 'auto' ? (llmConfigFromEnv() ? 'LLM' : 'rule-based parser') : mode})` });
    const out = await compileTicket(t, mode);
    await this.suite(key).saveContract(out.contract);
    this.advance(key, 'compile');
    const how = out.source === 'llm' ? `LLM ${out.model}${out.cached ? ', cached' : ''}` : 'rule-based parser';
    this.emit({ type: 'compile', ticket: key, message: `contract ready via ${how}`, data: { warnings: out.warnings } });
    return out;
  }

  async saveContract(key: string, contract: Contract) {
    this.assertAllowed(key, 'edit-contract');
    await this.suite(key).saveContract({ ...contract, ticket: key, source: 'manual' });
    this.advance(key, 'edit-contract');
  }

  async generate(key: string) {
    this.assertAllowed(key, 'generate');
    const out = await this.suite(key).generate();
    this.advance(key, 'generate');
    this.emit({ type: 'generate', ticket: key, message: `spec generated, sha256 ${out.sha256.slice(0, 12)}` });
    return out;
  }

  baseline(key: string): number {
    this.assertAllowed(key, 'baseline');
    const runId = this.store.createRun(key, 'baseline', 'record', []);
    this.queue.push(async () => {
      this.store.updateRun(runId, { status: 'running' });
      this.emit({ type: 'run', ticket: key, runId, message: `recording baseline on ${this.cfg.baselineUrl}` });
      try {
        const suite = this.suite(key);
        const contract = await suite.contract();
        if (!contract) throw new Error('no contract');
        const rec = await recordBaseline(contract, await suite.locators(), {
          baseURL: this.cfg.baselineUrl,
          artifactsDir: join(this.cfg.artifactsDir, `run-${runId}`),
        });
        if (rec.runs.some((r) => !r.ok)) throw new Error(rec.problems.join('; '));
        await suite.saveLocators(rec.locators);
        await suite.saveBaseline(rec.baseline);
        this.store.updateRun(runId, { status: 'done', verdict: 'PASS' });
        this.advance(key, 'baseline');
        this.emit({ type: 'run', ticket: key, runId, message: `baseline recorded: ${Object.keys(rec.baseline.fingerprints).length} elements, ${Object.keys(rec.baseline.effects).length} step effects`, data: { problems: rec.problems } });
      } catch (err) {
        this.store.updateRun(runId, { status: 'failed', error: (err as Error).message });
        this.emit({ type: 'run', ticket: key, runId, message: `baseline failed: ${(err as Error).message}` });
      }
    });
    return runId;
  }

  check(key: string, opts: { mutations?: string[]; mode?: HealMode; commit?: boolean } = {}): number {
    this.assertAllowed(key, 'check');
    const mode = opts.mode ?? 'sentinel';
    const mutations = opts.mutations ?? [];
    const runId = this.store.createRun(key, 'check', mode, mutations);
    this.queue.push(async () => {
      this.store.updateRun(runId, { status: 'running' });
      this.emit({ type: 'run', ticket: key, runId, message: `run #${runId} started: ${mode} mode${mutations.length ? `, mutations ${mutations.join(', ')}` : ''}` });
      try {
        const out = await checkSuite(this.suite(key), {
          baseURL: this.cfg.targetUrl,
          mutations,
          mode,
          llm: llmConfigFromEnv(),
          retryOnFail: true,
          concurrency: this.cfg.workers,
          artifactsDir: join(this.cfg.artifactsDir, `run-${runId}`),
          label: `run-${runId}`,
          commit: opts.commit ?? true,
        });
        const status = (h: HealRecord) => (h.decision === 'accepted' ? 'accepted' : h.decision === 'review' ? 'pending' : 'refused');
        this.store.saveResults(runId, key, out.results, status);
        const verdict = worstVerdict(out.results.map((r) => r.verdict));
        this.store.updateRun(runId, { status: 'done', verdict });
        this.advance(key, 'check');
        for (const r of out.results) this.emit({ type: 'result', ticket: key, runId, message: `${r.criterion} ${r.verdict}: ${r.reason}`, data: r });
        this.emit({ type: 'run', ticket: key, runId, message: `run #${runId} finished: ${verdict}`, data: { verdict } });
        await this.reportToJira(key, runId, out.results);
      } catch (err) {
        this.store.updateRun(runId, { status: 'failed', error: (err as Error).message });
        this.emit({ type: 'run', ticket: key, runId, message: `run #${runId} failed: ${(err as Error).message}` });
      }
    });
    return runId;
  }

  /** Ticket in, verdicts out: compile, generate, baseline and check in order. */
  async pipeline(key: string, opts: { mutations?: string[]; compileMode?: CompileMode } = {}) {
    await this.compile(key, opts.compileMode);
    await this.generate(key);
    const baselineRun = this.baseline(key);
    await this.queue.push(async () => {});
    const b = this.store.run(baselineRun);
    if (b?.status !== 'done') throw new Error(`baseline failed: ${b?.error}`);
    return { baselineRun, checkRun: this.check(key, { mutations: opts.mutations }) };
  }

  async reviewHeal(id: number, approve: boolean) {
    const h = this.store.heal(id);
    if (!h) throw new Error(`unknown heal ${id}`);
    if (h.status !== 'pending') throw new Error(`heal ${id} is ${h.status}, not pending`);
    if (approve) {
      this.assertAllowed(h.ticket, 'approve-heal');
      const suite = this.suite(h.ticket);
      if (!h.record.to) throw new Error('heal has no proposed locator');
      await suite.saveLocators({ ...(await suite.locators()), [h.key]: h.record.to });
      this.advance(h.ticket, 'approve-heal');
    }
    this.store.reviewHeal(id, approve ? 'approved' : 'rejected');
    this.emit({ type: 'review', ticket: h.ticket, runId: h.run_id, message: `${h.key} heal ${approve ? 'approved and written to locators.json' : 'rejected'}` });
  }

  private async reportToJira(key: string, runId: number, results: import('@sentinelqa/core').CriterionResult[]) {
    if (!this.cfg.jira || this.store.ticket(key)?.source !== 'jira') return;
    try {
      await postRunComment(this.cfg.jira, key, runId, results, this.cfg.publicUrl);
      this.emit({ type: 'jira', ticket: key, runId, message: `results posted to ${key} in Jira` });
    } catch (err) {
      this.emit({ type: 'jira', ticket: key, runId, message: `could not comment on ${key}: ${(err as Error).message}` });
    }
  }

  async importFromJira(key: string) {
    if (!this.cfg.jira) throw new Error('Jira is not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)');
    const t = await fetchIssue(this.cfg.jira, key);
    this.receive(t);
    return t;
  }

  /** Webhook: a ticket that reaches the ready status runs the whole pipeline. */
  async onJiraStatus(key: string, status: string | null) {
    if (!this.cfg.jira || status !== this.cfg.jira.readyStatus) return { started: false, reason: `status is ${status}` };
    const t = await this.importFromJira(key);
    if (!t.criteria.length) {
      this.emit({ type: 'jira', ticket: key, message: `${key} reached ${status} but has no acceptance criteria` });
      return { started: false, reason: 'no acceptance criteria' };
    }
    this.pipeline(key).catch((err) => this.emit({ type: 'jira', ticket: key, message: `pipeline failed: ${(err as Error).message}` }));
    return { started: true };
  }

  get queued() {
    return this.queue.pending;
  }
}
