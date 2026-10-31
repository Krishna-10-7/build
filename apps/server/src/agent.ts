import type { Arena, Episode, Trigger } from './arena/arena.ts';
import { SCENARIOS } from './arena/arena.ts';
import type { RepoEntry } from './arena/targets.ts';
import { checkOutput, type GithubApp } from './github.ts';
import type { JiraHub } from './jira-hub.ts';

/**
 * One API behind the lobby, the CLI and the MCP server. A "project" is a floor of the building:
 * floor 1 is the ShopLite demo, every connected GitHub repository gets a floor above it.
 */

export const DEMO = 'demo';

type Snap = Omit<Episode, 'desks'> & { desks?: unknown };

export interface Floor {
  n: number;
  id: string;
  title: string;
  kind: 'demo' | 'github';
  url: string | null;
  defaultRef: string | null;
  /** Branches or scenarios offered on that floor. */
  options: { id: string; title: string }[];
  last: Summary | null;
  live: boolean;
  queued: number;
  /** Jira projects whose tickets run on this floor. */
  jira: string[];
}

export interface Summary {
  id: number;
  status: Episode['status'];
  label: string;
  conclusion: string | null;
  title: string | null;
  startedAt: number;
}

export interface CheckResult extends Summary {
  project: string;
  ticket: string;
  trigger: Trigger;
  finishedAt: number | null;
  error: string | null;
  summary: string | null;
  criteria: { id: string; verdict: string; rule: string; heals: { key: string; decision: string; rule: string }[] }[];
  fixer: { criterion: string; green: boolean; rewroteAssertion: boolean }[];
  watchUrl: string | null;
  done: boolean;
}

export function floorOf(ep: { trigger?: Trigger }): string {
  return ep.trigger?.kind === 'github' ? ep.trigger.repo : DEMO;
}

const DONE = new Set(['finished', 'failed']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AgentApi {
  constructor(private o: { arena: Arena; github: GithubApp; jira?: JiraHub; repos: RepoEntry[]; publicUrl: string | undefined; defaultTicket: string }) {}

  url(path: string): string | null {
    return this.o.publicUrl ? new URL(path, this.o.publicUrl).toString() : null;
  }

  private summary(ep: Snap): Summary {
    const done = DONE.has(ep.status);
    const out = done ? checkOutput(ep as Episode) : null;
    return { id: ep.id, status: ep.status, label: ep.label, conclusion: out?.conclusion ?? null, title: out?.title ?? null, startedAt: ep.startedAt };
  }

  /** The building, bottom to top. */
  async floors(): Promise<Floor[]> {
    const history = this.o.arena.history(200) as Snap[];
    const live = this.o.arena.episode;
    const of = (id: string) => {
      const mine = history.filter((e) => floorOf(e) === id);
      return {
        last: mine.find((e) => e.status !== 'queued') ?? mine[0] ?? null,
        live: Boolean(live && this.o.arena.busy && floorOf(live) === id),
        queued: mine.filter((e) => e.status === 'queued').length,
      };
    };
    const demoRefs = this.o.repos[0]?.refs ?? [];
    const jira = (floor: string) => (this.o.jira?.links() ?? []).filter((l) => l.floor === floor).map((l) => l.project);
    const floors: Floor[] = [];
    const d = of(DEMO);
    floors.push({
      n: 1,
      id: DEMO,
      title: 'ShopLite demo',
      kind: 'demo',
      url: null,
      defaultRef: null,
      options: [...SCENARIOS.map((s) => ({ id: `scenario:${s.id}`, title: s.title })), ...demoRefs.map((r) => ({ id: `branch:${r}`, title: `Branch ${r}` }))],
      last: d.last ? this.summary(d.last) : null,
      live: d.live,
      queued: d.queued,
      jira: jira(DEMO),
    });
    const repos = await this.o.github.connected().catch(() => []);
    [...repos].sort((a, b) => a.repo.localeCompare(b.repo)).forEach((r, i) => {
      const f = of(r.repo);
      floors.push({ n: i + 2, id: r.repo, title: r.repo, kind: 'github', url: r.url, defaultRef: r.defaultBranch, options: [], last: f.last ? this.summary(f.last) : null, live: f.live, queued: f.queued, jira: jira(r.repo) });
    });
    return floors;
  }

  /**
   * Queues a check. Demo: a scenario id or a branch of the demo repository. A connected repository:
   * the latest commit of a branch (its default branch when none is given).
   */
  async run(input: { project: string; ref?: string; scenario?: string; ticket?: string }): Promise<CheckResult> {
    const ticket = input.ticket?.trim().toUpperCase() || undefined;
    // A ticket of a linked Jira project: fetch its latest criteria first.
    if (ticket && this.o.jira?.links().some((l) => l.project === ticket.split('-')[0])) await this.o.jira.prepare(ticket);
    if (input.project === DEMO) {
      let ep: Episode;
      if (input.ref) {
        const repo = this.o.repos[0];
        if (!repo) throw new Error('the demo floor has no repository branches configured');
        ep = this.o.arena.start({ ticket: ticket ?? this.o.defaultTicket, stepDelayMs: 300, target: { kind: 'repo', id: repo.id, ref: input.ref } });
      } else {
        const sc = SCENARIOS.find((s) => s.id === (input.scenario ?? 'clean'));
        if (!sc) throw new Error(`unknown scenario; one of ${SCENARIOS.map((s) => s.id).join(', ')}`);
        ep = this.o.arena.start({ ticket: ticket ?? this.o.defaultTicket, stepDelayMs: 300, target: { kind: 'shoplite', mutations: sc.mutations } });
      }
      return this.result(ep.id)!;
    }
    const { id } = await this.o.github.runBranch(input.project, input.ref, { ticket });
    return this.result(id)!;
  }

  result(id: number): CheckResult | null {
    const r = this.o.arena.replay(id);
    if (!r) return null;
    const ep = r.episode as Snap;
    const done = DONE.has(ep.status);
    const out = done ? checkOutput(ep as Episode, this.url(`office/?episode=${ep.id}`) ?? undefined) : null;
    return {
      ...this.summary(ep),
      project: floorOf(ep),
      ticket: ep.request.ticket,
      trigger: ep.trigger ?? { kind: 'manual' },
      finishedAt: ep.finishedAt,
      error: ep.error,
      summary: out?.summary ?? null,
      criteria: (ep.results.sentinel ?? []).map((c) => ({
        id: c.criterion,
        verdict: c.verdict,
        rule: c.rule,
        heals: c.heals.map((h) => ({ key: h.key, decision: h.decision, rule: h.rule })),
      })),
      fixer: (ep.results.rival ?? []).map((f) => ({ criterion: f.criterion, green: f.green, rewroteAssertion: f.editedAssertions })),
      watchUrl: this.url(`office/?episode=${ep.id}`),
      done,
    };
  }

  /** Waits up to `seconds` for a run to finish, then returns where it is. */
  async wait(id: number, seconds: number): Promise<CheckResult | null> {
    const first = this.result(id);
    if (!first || first.done || seconds <= 0) return first;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.o.arena.bus.off('finished', on);
        resolve();
      };
      const on = (ep: Episode) => ep.id === id && finish();
      const timer = setTimeout(finish, Math.min(seconds, 120) * 1000);
      this.o.arena.bus.on('finished', on);
    });
    return this.result(id);
  }

  /** The run GitHub's push started for a commit; waits for it to appear and finish. */
  async commit(repo: string, sha: string, seconds: number): Promise<CheckResult | null> {
    const until = Date.now() + Math.min(seconds, 120) * 1000;
    const find = () =>
      (this.o.arena.history(200) as Snap[]).find((e) => e.trigger?.kind === 'github' && e.trigger.repo.toLowerCase() === repo.toLowerCase() && e.trigger.sha.startsWith(sha.toLowerCase()));
    let ep = find();
    while (!ep && Date.now() < until) {
      await sleep(2000);
      ep = find();
    }
    if (!ep) return null;
    return this.wait(ep.id, Math.max(0, (until - Date.now()) / 1000));
  }

  runs(project?: string, limit = 20): Summary[] {
    return (this.o.arena.history(200) as Snap[])
      .filter((e) => !project || floorOf(e) === project)
      .slice(0, limit)
      .map((e) => this.summary(e));
  }
}

/** Plain text an agent (or a person in a terminal) can read at a glance. */
export function describe(r: CheckResult): string {
  const head = r.done
    ? `${r.conclusion?.toUpperCase()}: ${r.title}`
    : `${r.status.toUpperCase()}: run #${r.id} is ${r.status === 'queued' ? 'waiting in the queue' : 'still running'}; ask again for the result`;
  const lines = [head, `run #${r.id} · ${r.project} · ${r.label || 'preparing'} · ticket ${r.ticket}`];
  if (r.error) lines.push(`error: ${r.error}`);
  for (const c of r.criteria) {
    const healed = c.heals.filter((h) => h.decision === 'accepted').map((h) => h.key);
    lines.push(`  ${c.id}  ${c.verdict.padEnd(12)} rule ${c.rule}${healed.length ? `  healed: ${healed.join(', ')}` : ''}`);
  }
  if (r.done && r.criteria.some((c) => c.verdict === 'REGRESSION')) {
    lines.push('A REGRESSION means the app no longer does what the ticket asks. Fix the application code; changing the test or its expected values does not count.');
  }
  if (r.watchUrl) lines.push(`watch: ${r.watchUrl}`);
  return lines.join('\n');
}
