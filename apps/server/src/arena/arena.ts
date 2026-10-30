import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { z } from 'zod';
import { llmConfigFromEnv, type CriterionResult } from '@sentinelqa/core';
import { Suite, recordBaseline, type SuiteData } from '@sentinelqa/engine';
import { MUTATIONS } from '../../../shoplite/src/mutations.ts';
import type { AgentChannel, AgentStatus, Tone } from './channel.ts';
import { runRival, type RivalCriterionResult } from './rival.ts';
import { runSentinel } from './sentinel.ts';
import { TargetSpec, loadRepoRegistry, resolveTarget, type RepoEntry } from './targets.ts';

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

/** Ready-made scenarios on ShopLite; truth is what the change really is. */
export const SCENARIOS = [
  { id: 'redesign', title: 'Redesign: test ids renamed, "Add to cart" now "Add to bag"', mutations: ['D1', 'D4'] },
  { id: 'qty-bug', title: 'Bug: cart total ignores quantity', mutations: ['R5'] },
  { id: 'lookalike', title: 'Bug: Add to cart and Add to wishlist swapped', mutations: ['R4'] },
  { id: 'decoy', title: 'Redesign with a similar decoy button', mutations: ['D12'] },
  { id: 'order-500', title: 'Bug: order API returns 500', mutations: ['R6'] },
  { id: 'clean', title: 'Release with no changes', mutations: [] as string[] },
].map((s) => {
  const kinds = s.mutations.map((m) => MUTATIONS.find((x) => x.id === m)?.kind);
  return { ...s, truth: kinds.includes('regression') ? 'regression' : kinds.length ? 'drift' : 'no change' };
});

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
  status: 'preparing' | 'running' | 'finished' | 'failed';
  request: EpisodeRequest;
  label: string;
  truth: string | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  desks: Record<AgentId, DeskState>;
  results: { rival: RivalCriterionResult[] | null; sentinel: CriterionResult[] | null };
}

const MAX_LOG = 400;

export class Arena {
  readonly bus = new EventEmitter();
  private current: Episode | null = null;
  private nextId = 1;

  constructor(private cfg: { suitesDir: string; workDir: string; shopliteUrl: string; repos: RepoEntry[] }) {
    this.bus.setMaxListeners(100);
  }

  /** Registry entries without their commands, for the controls. */
  get repos() {
    return this.cfg.repos.map((r) => ({ id: r.id, title: r.title, refs: r.refs }));
  }

  get episode(): Episode | null {
    return this.current;
  }

  /** Snapshot for a viewer that just connected; frames are sent separately. */
  snapshot() {
    if (!this.current) return null;
    const { desks, ...rest } = this.current;
    return { ...rest, desks: Object.fromEntries(Object.entries(desks).map(([k, d]) => [k, { status: d.status, headline: d.headline, log: d.log }])) };
  }

  latestFrames(): Partial<Record<AgentId, string>> {
    const out: Partial<Record<AgentId, string>> = {};
    for (const id of ['rival', 'sentinel'] as AgentId[]) {
      const f = this.current?.desks[id].frame;
      if (f) out[id] = f;
    }
    return out;
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
        this.bus.emit('frame', { agent, data });
      },
    };
  }

  private publish(ep: Episode) {
    this.bus.emit('msg', { t: 'episode', episode: this.snapshot() });
  }

  start(input: unknown): Episode {
    if (this.current && (this.current.status === 'preparing' || this.current.status === 'running')) {
      throw new Error('an episode is already running');
    }
    const request = EpisodeRequest.parse(input);
    const blank = (headline: string): DeskState => ({ status: 'idle', headline, log: [], frame: null });
    const truth =
      request.target.kind === 'shoplite' ? (request.target.mutations.some((m) => MUTATIONS.find((x) => x.id === m)?.kind === 'regression') ? 'regression' : request.target.mutations.length ? 'drift' : 'no change') : null;
    const ep: Episode = {
      id: this.nextId++,
      status: 'preparing',
      request,
      label: '',
      truth,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      desks: { rival: blank('getting ready'), sentinel: blank('getting ready') },
      results: { rival: null, sentinel: null },
    };
    this.current = ep;
    this.publish(ep);
    this.run(ep).catch((err) => {
      ep.status = 'failed';
      ep.error = (err as Error).message;
      ep.finishedAt = Date.now();
      for (const id of ['rival', 'sentinel'] as AgentId[]) if (ep.desks[id].status !== 'done' && ep.desks[id].status !== 'alert') this.channel(ep, id).state('idle', 'stopped');
      this.publish(ep);
    });
    return ep;
  }

  private async run(ep: Episode) {
    const { request } = ep;
    const rival = this.channel(ep, 'rival');
    const sentinel = this.channel(ep, 'sentinel');
    const suite = Suite.at(this.cfg.suitesDir, request.ticket);
    const contract = await suite.contract();
    if (!contract) throw new Error(`${request.ticket} has no contract yet; compile it in the dashboard first`);

    sentinel.state('working', 'preparing the build under test');
    const target = await resolveTarget(request.target, { shopliteUrl: this.cfg.shopliteUrl, workDir: this.cfg.workDir, repos: this.cfg.repos, log: (l) => sentinel.log(l, 'dim') });
    ep.label = target.label;
    try {
      let baseline = await suite.baseline();
      if (!baseline) {
        if (request.target.kind !== 'shoplite') throw new Error(`${request.ticket} has no baseline; record one on the known-good build first`);
        sentinel.log('no baseline yet: recording one on the known-good build', 'warn');
        const rec = await recordBaseline(contract, await suite.locators(), { baseURL: this.cfg.shopliteUrl });
        if (rec.runs.some((r) => !r.ok)) throw new Error(`baseline failed: ${rec.problems.join('; ')}`);
        await suite.saveLocators(rec.locators);
        await suite.saveBaseline(rec.baseline);
        baseline = rec.baseline;
      }
      const data: SuiteData = { contract, baseline, locators: await suite.locators(), specGate: await suite.verifySpec() };
      ep.status = 'running';
      this.publish(ep);

      const llm = llmConfigFromEnv();
      const rivalLlm = llm ? { ...llm, model: process.env.RIVAL_MODEL || llm.model } : null;
      const both = await Promise.allSettled([
        rivalLlm
          ? runRival(contract, data.locators, target, rivalLlm, rival, { stepDelayMs: request.stepDelayMs })
          : Promise.reject(new Error('no LLM configured (LLM_API_KEY)')),
        runSentinel(data, target, llm, sentinel, { stepDelayMs: request.stepDelayMs }),
      ]);
      if (both[0].status === 'fulfilled') ep.results.rival = both[0].value;
      else (rival.log(`stopped: ${both[0].reason?.message ?? both[0].reason}`, 'bad'), rival.state('idle', 'stopped'));
      if (both[1].status === 'fulfilled') ep.results.sentinel = both[1].value;
      else (sentinel.log(`stopped: ${both[1].reason?.message ?? both[1].reason}`, 'bad'), sentinel.state('idle', 'stopped'));
      ep.status = 'finished';
    } finally {
      await target.dispose();
      ep.finishedAt = Date.now();
      this.publish(ep);
    }
  }
}

export function arenaFromEnv(root: string, suitesDir: string, shopliteUrl: string): Arena {
  return new Arena({ suitesDir, workDir: join(root, 'data/arena/repos'), shopliteUrl, repos: loadRepoRegistry(process.env.ARENA_REPOS_FILE) });
}
