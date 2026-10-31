import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { z } from 'zod';
import { llmConfigFromEnv, type CriterionResult, type LlmConfig } from '@sentinelqa/core';
import { Suite, recordBaseline, type SuiteData } from '@sentinelqa/engine';
import { MUTATIONS } from '../../../shoplite/src/mutations.ts';
import type { Store } from '../db.ts';
import type { AgentChannel, AgentStatus, Tone } from './channel.ts';
import { runRival, type RivalCriterionResult } from './rival.ts';
import { runSentinel } from './sentinel.ts';
import { TargetSpec, loadRepoRegistry, resolveTarget, type AnyTarget, type RepoEntry } from './targets.ts';

export type AgentId = 'rival' | 'sentinel';

export const DESKS: Record<AgentId, { name: string; role: string }> = {
  rival: { name: 'Fixer', role: 'Typical AI test-fixer: edits the test until it passes' },
  sentinel: { name: 'Sentinel', role: 'SentinelQA: repairs locators, never what the test checks' },
};

export const EpisodeRequest = z.object({
  ticket: z.string().default('SHOP-42'),
  target: TargetSpec,
  /** Pause after each step so people can follow along. */
  stepDelayMs: z.number().int().min(0).max(3000).default(700),
});
export type EpisodeRequest = z.infer<typeof EpisodeRequest>;
/** What the arena runs: a request from the controls, or a commit from the GitHub App. */
export type ArenaRequest = Omit<EpisodeRequest, 'target'> & {
  target: AnyTarget;
  /** No baseline yet: record it on this build first (a ticket that just reached QA). */
  baselineOnTarget?: boolean;
  /** Post the verdicts back to the Jira ticket. */
  notifyJira?: boolean;
  /** The person this run belongs to; null or missing for the shared demo. */
  owner?: number | null;
};

/** Fair use, set by the server: who may queue, and which LLM key the Fixer uses for whom. */
export interface ArenaLimits {
  admit(owner: number | null, queued: number): void;
  counted(owner: number | null): void;
  llmFor(owner: number | null): { llm: LlmConfig | null; note?: string; shared: boolean };
  usedSharedLlm(owner: number | null): void;
}

/** Each person's suites live apart; the server says where, and copies a sample suite on first use. */
export interface ArenaSuites {
  dirFor(owner: number | null): string;
  ensure(owner: number | null, ticket: string): Promise<void>;
}

/** Why an episode ran. */
export type Trigger =
  | { kind: 'manual' }
  | { kind: 'github'; event: 'push' | 'manual' | 'jira'; repo: string; ref: string; sha: string; message: string; author: string; url: string }
  | { kind: 'jira'; key: string; url: string };

/** Ready-made scenarios on ShopLite; truth is what the change really is. */
export const SCENARIOS = [
  { id: 'redesign', title: 'Redesign: test ids renamed, "Add to cart" now "Add to bag"', mutations: ['D1', 'D4'] },
  { id: 'qty-bug', title: 'Bug: cart total ignores quantity', mutations: ['R5'] },
  { id: 'lookalike', title: 'Bug: Add to cart and Add to wishlist swapped', mutations: ['R4'] },
  { id: 'decoy', title: 'Redesign with a similar decoy button', mutations: ['D12'] },
  { id: 'order-500', title: 'Bug: order API returns 500', mutations: ['R6'] },
  { id: 'clean', title: 'Release with no changes', mutations: [] as string[] },
].map((s) => ({ ...s, truth: truthOfMutations(s.mutations) }));

function truthOfMutations(mutations: string[]): string {
  const kinds = mutations.map((m) => MUTATIONS.find((x) => x.id === m)?.kind);
  return kinds.includes('regression') ? 'regression' : kinds.length ? 'drift' : 'no change';
}

interface LogLine {
  at: number;
  text: string;
  tone: Tone;
}

interface DeskState {
  status: AgentStatus;
  headline: string;
  log: LogLine[];
  frame: string | null;
}

export interface Episode {
  id: number;
  /** Who it belongs to; null for the shared demo, which everyone sees. */
  owner: number | null;
  /** The ticket's criteria at run time, for the board on the wall. */
  criteria?: { id: string; text: string }[];
  status: 'queued' | 'preparing' | 'running' | 'finished' | 'failed';
  request: ArenaRequest;
  trigger: Trigger;
  label: string;
  truth: string | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  /** Set when the run stopped because the ticket's criteria fail on this build: a red result, not a broken run. */
  criteriaFailed?: boolean;
  desks: Record<AgentId, DeskState>;
  results: { rival: RivalCriterionResult[] | null; sentinel: CriterionResult[] | null };
}

const MAX_LOG = 400;
const MAX_QUEUE = 30;
const AGENTS: AgentId[] = ['rival', 'sentinel'];

export class Arena {
  readonly bus = new EventEmitter();
  private current: Episode | null = null;
  private queue: Episode[] = [];
  private nextId: number;
  /** When each owner last got the arena, for taking turns. */
  private lastTurn = new Map<string, number>();
  /** Set by the GitHub App once it is configured. */
  githubToken?: (repo: string) => Promise<string | null>;

  constructor(
    private cfg: { suitesDir: string; workDir: string; shopliteUrl: string; repos: RepoEntry[]; store: Store; githubPort?: number; limits?: ArenaLimits; suites?: ArenaSuites },
  ) {
    this.bus.setMaxListeners(100);
    // A restart keeps the last episode on screen; anything it cut short is marked failed.
    for (const row of cfg.store.episodes<Episode>(MAX_QUEUE + 2)) {
      if (row.status === 'finished' || row.status === 'failed') continue;
      const saved = cfg.store.episode<Episode>(row.id)!;
      cfg.store.saveEpisode({ ...saved.episode, status: 'failed', error: 'server restarted', finishedAt: saved.episode.finishedAt ?? Date.now() }, saved.frames);
    }
    const last = cfg.store.lastEpisodeId();
    this.nextId = last + 1;
    const saved = last ? cfg.store.episode<Episode>(last) : null;
    if (saved) {
      this.current = saved.episode;
      for (const id of AGENTS) this.current.desks[id].frame = saved.frames[id] ?? null;
    }
  }

  /** Registry entries without their commands, for the controls. */
  get repos() {
    return this.cfg.repos.map((r) => ({ id: r.id, title: r.title, refs: r.refs }));
  }

  get episode(): Episode | null {
    return this.current;
  }

  get busy(): boolean {
    return Boolean(this.current && (this.current.status === 'preparing' || this.current.status === 'running'));
  }

  private view(ep: Episode, withLogs = true) {
    const { desks, ...rest } = ep;
    return {
      ...rest,
      desks: Object.fromEntries(Object.entries(desks).map(([k, d]) => [k, { status: d.status, headline: d.headline, log: withLogs ? d.log : [] }])),
    };
  }

  /** Snapshot for a viewer that just connected; frames are sent separately. */
  snapshot() {
    if (!this.current) return null;
    return { ...this.view(this.current), queue: this.queue.map((q) => ({ id: q.id, label: q.label, trigger: q.trigger })) };
  }

  latestFrames(): Partial<Record<AgentId, string>> {
    const out: Partial<Record<AgentId, string>> = {};
    for (const id of AGENTS) {
      const f = this.current?.desks[id].frame;
      if (f) out[id] = f;
    }
    return out;
  }

  /** Who an episode belongs to (null: the shared demo); undefined when there is no such episode. */
  ownerOf(id: number): number | null | undefined {
    if (this.current?.id === id) return this.current.owner ?? null;
    const q = this.queue.find((e) => e.id === id);
    if (q) return q.owner ?? null;
    const saved = this.cfg.store.episode<Episode>(id);
    return saved ? (saved.episode.owner ?? null) : undefined;
  }

  /** One episode with its logs and last frames, for a replay. */
  replay(id: number) {
    if (this.current?.id === id) return { episode: this.view(this.current), frames: this.latestFrames() };
    const queued = this.queue.find((q) => q.id === id);
    if (queued) return { episode: this.view(queued), frames: {} };
    return this.cfg.store.episode<Episode>(id);
  }

  /**
   * Newest first: waiting episodes, then the saved ones (the current one is saved too). `viewer`:
   * undefined for everything, null for the shared demo only, or a person's id for theirs and the demo.
   */
  history(limit = 50, viewer?: number | null) {
    const sees = (e: { owner?: number | null }) => viewer === undefined || (e.owner ?? null) === null || e.owner === viewer;
    const queued = new Set(this.queue.map((q) => q.id));
    return [
      ...[...this.queue].reverse().filter(sees).map((q) => this.view(q, false)),
      ...this.cfg.store.episodes<Episode>(limit, viewer).filter((e) => !queued.has(e.id)),
    ];
  }

  queuedFor(owner: number | null): number {
    return this.queue.filter((q) => (q.owner ?? null) === owner).length;
  }

  private save(ep: Episode) {
    const frames = Object.fromEntries(AGENTS.flatMap((id) => (ep.desks[id].frame ? [[id, ep.desks[id].frame]] : [])));
    this.cfg.store.saveEpisode(this.view(ep), frames);
  }

  private channel(ep: Episode, agent: AgentId): AgentChannel {
    const desk = ep.desks[agent];
    return {
      log: (text, tone = 'info') => {
        const line = { at: Date.now(), text, tone };
        desk.log.push(line);
        if (desk.log.length > MAX_LOG) desk.log.splice(0, desk.log.length - MAX_LOG);
        this.bus.emit('msg', { t: 'log', episode: ep.id, agent, ...line });
      },
      state: (status, headline) => {
        desk.status = status;
        desk.headline = headline;
        this.bus.emit('msg', { t: 'state', episode: ep.id, agent, status, headline });
      },
      frame: (data) => {
        desk.frame = data;
        this.bus.emit('frame', { episode: ep.id, agent, data });
      },
    };
  }

  private publish() {
    this.bus.emit('msg', { t: 'episode', episode: this.snapshot() });
  }

  private truthOf(t: AnyTarget): string | null {
    if (t.kind === 'shoplite') return truthOfMutations(t.mutations);
    if (t.kind === 'repo') return this.cfg.repos.find((r) => r.id === t.id)?.truth[t.ref] ?? null;
    // A real push has no answer key: the verdict is the result.
    return null;
  }

  /** Runs now when the arena is free, otherwise waits its turn. */
  start(request: ArenaRequest, trigger: Trigger = { kind: 'manual' }): Episode {
    if (this.queue.length >= MAX_QUEUE) throw Object.assign(new Error(`the building is busy: ${MAX_QUEUE} runs are waiting`), { statusCode: 429 });
    const owner = request.owner ?? null;
    this.cfg.limits?.admit(owner, this.queuedFor(owner));
    const blank = (): DeskState => ({ status: 'idle', headline: 'waiting in the queue', log: [], frame: null });
    const t = request.target;
    const ep: Episode = {
      id: this.nextId++,
      owner,
      status: 'queued',
      request,
      trigger,
      label: t.kind === 'github' ? `${t.repo} @ ${t.ref} (${t.sha.slice(0, 7)})` : '',
      truth: this.truthOf(t),
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      desks: { rival: blank(), sentinel: blank() },
      results: { rival: null, sentinel: null },
    };
    this.save(ep);
    this.queue.push(ep);
    this.cfg.limits?.counted(owner);
    this.pump();
    if (ep.status === 'queued') this.publish();
    return ep;
  }

  /** Next turn goes to whoever waited longest since their last one, so one busy person cannot hog the arena. */
  private pump() {
    if (this.busy || !this.queue.length) return;
    const turn = (e: Episode) => this.lastTurn.get(String(e.owner ?? 'demo')) ?? 0;
    let pick = 0;
    for (let i = 1; i < this.queue.length; i++) if (turn(this.queue[i]) < turn(this.queue[pick])) pick = i;
    const [ep] = this.queue.splice(pick, 1);
    this.lastTurn.set(String(ep.owner ?? 'demo'), Date.now());
    ep.status = 'preparing';
    ep.startedAt = Date.now();
    for (const id of AGENTS) Object.assign(ep.desks[id], { status: 'idle', headline: 'getting ready' });
    this.current = ep;
    this.save(ep);
    this.publish();
    this.bus.emit('started', ep);
    this.run(ep)
      .catch((err) => {
        ep.status = 'failed';
        ep.error = (err as Error).message;
        for (const id of AGENTS) if (ep.desks[id].status !== 'done' && ep.desks[id].status !== 'alert') this.channel(ep, id).state('idle', 'stopped');
      })
      .finally(() => {
        ep.finishedAt = Date.now();
        this.save(ep);
        this.publish();
        this.bus.emit('finished', ep);
        this.pump();
      });
  }

  private async run(ep: Episode) {
    const { request } = ep;
    const rival = this.channel(ep, 'rival');
    const sentinel = this.channel(ep, 'sentinel');
    const owner = ep.owner ?? null;
    await this.cfg.suites?.ensure(owner, request.ticket);
    const suite = Suite.at(this.cfg.suites?.dirFor(owner) ?? this.cfg.suitesDir, request.ticket);
    const contract = await suite.contract();
    if (!contract) throw new Error(`${request.ticket} has no compiled criteria yet; add the ticket at the Jira kiosk first`);
    ep.criteria = contract.criteria.map((c) => ({ id: c.id, text: c.text }));

    sentinel.state('working', 'preparing the build under test');
    const target = await resolveTarget(request.target, {
      shopliteUrl: this.cfg.shopliteUrl,
      workDir: this.cfg.workDir,
      repos: this.cfg.repos,
      log: (l) => sentinel.log(l, 'dim'),
      githubToken: this.githubToken,
      githubPort: this.cfg.githubPort,
    });
    ep.label = target.label;
    try {
      let baseline = await suite.baseline();
      if (!baseline) {
        const here = request.target.kind !== 'shoplite' && request.baselineOnTarget;
        if (request.target.kind !== 'shoplite' && !here) throw new Error(`${request.ticket} has no baseline; record one on the known-good build first`);
        sentinel.log(here ? 'no baseline yet: recording it on this build, the one the ticket was accepted on' : 'no baseline yet: recording one on the known-good build', 'warn');
        const rec = await recordBaseline(contract, await suite.locators(), { baseURL: here ? target.baseURL : this.cfg.shopliteUrl });
        if (rec.runs.some((r) => !r.ok)) {
          if (here) ep.criteriaFailed = true;
          throw new Error(here ? `the ticket's criteria do not hold on this build, so there is no baseline to record: ${rec.problems.join('; ')}` : `baseline failed: ${rec.problems.join('; ')}`);
        }
        await suite.saveLocators(rec.locators);
        await suite.saveBaseline(rec.baseline);
        baseline = rec.baseline;
      }
      const data: SuiteData = { contract, baseline, locators: await suite.locators(), specGate: await suite.verifySpec() };
      ep.status = 'running';
      this.publish();

      const llm = llmConfigFromEnv();
      const fallback = llm ? { llm: { ...llm, model: process.env.RIVAL_MODEL || llm.model }, shared: true } : { llm: null, shared: true, note: 'no LLM configured (LLM_API_KEY)' };
      const plan: { llm: LlmConfig | null; note?: string; shared: boolean } = this.cfg.limits?.llmFor(owner) ?? fallback;
      if (plan.llm && plan.shared) this.cfg.limits?.usedSharedLlm(owner);
      const both = await Promise.allSettled([
        plan.llm
          ? runRival(contract, data.locators, target, plan.llm, rival, { stepDelayMs: request.stepDelayMs })
          : Promise.reject(new Error(plan.note ?? 'no LLM configured (LLM_API_KEY)')),
        runSentinel(data, target, llm, sentinel, { stepDelayMs: request.stepDelayMs }),
      ]);
      if (both[0].status === 'fulfilled') ep.results.rival = both[0].value;
      else (rival.log(`stopped: ${both[0].reason?.message ?? both[0].reason}`, 'bad'), rival.state('idle', 'stopped'));
      if (both[1].status === 'fulfilled') ep.results.sentinel = both[1].value;
      else (sentinel.log(`stopped: ${both[1].reason?.message ?? both[1].reason}`, 'bad'), sentinel.state('idle', 'stopped'));
      ep.status = 'finished';
    } finally {
      await target.dispose();
    }
  }
}

export function arenaFromEnv(root: string, suitesDir: string, shopliteUrl: string, store: Store, extra: { limits?: ArenaLimits; suites?: ArenaSuites } = {}): Arena {
  return new Arena({
    ...extra,
    suitesDir,
    workDir: resolve(root, process.env.ARENA_WORK_DIR ?? 'data/arena/repos'),
    shopliteUrl,
    repos: loadRepoRegistry(process.env.ARENA_REPOS_FILE),
    store,
    githubPort: Number(process.env.GITHUB_BUILD_PORT ?? 8472),
  });
}
