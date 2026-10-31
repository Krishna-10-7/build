import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ticket } from '@sentinelqa/core';
import type { Arena, Episode } from './arena/arena.ts';
import { assertPublic } from './arena/targets.ts';
import type { Auth } from './auth.ts';
import { checkOutput, type GithubApp } from './github.ts';
import { fetchIssue, jiraWhoAmI, postArenaComment, readWebhook, type JiraConfig } from './jira.ts';
import { seal, unseal } from './secrets.ts';
import type { JiraLink, JiraRow, Tenancy } from './tenancy.ts';
import { TICKET_KEY, type TicketDesk } from './tickets.ts';

/**
 * Jira, per person. Each user connects their own Jira Cloud site from the lobby and links their Jira
 * projects to their floors. A ticket reaching the ready status is imported into their ticket desk,
 * compiled and run on its floor; a push that names it checks it again; every such run is posted back
 * to the ticket. Each connection has its own webhook address and secret.
 */

const Link = z.object({ project: z.string().regex(/^[A-Z][A-Z0-9]+$/), floor: z.string().min(1) });
const KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;

interface Opts {
  tenancy: Tenancy;
  desk: TicketDesk;
  arena: Arena;
  github: GithubApp;
  auth: Auth;
  publicUrl: string | undefined;
}

export class JiraHub {
  constructor(private o: Opts) {
    o.github.ticketFor = (owner, repo, ref, message) => this.ticketForCommit(owner, repo, ref, message);
    o.arena.bus.on('finished', (ep: Episode) => void this.comment(ep));
  }

  private config(row: JiraRow | null): JiraConfig | null {
    if (!row) return null;
    return { baseUrl: row.base_url, email: row.email, token: unseal(row.token), readyStatus: row.ready_status, criteriaField: row.criteria_field ?? undefined };
  }

  links(owner: number | null | undefined): JiraLink[] {
    return owner == null ? [] : (this.o.tenancy.jira(owner)?.links ?? []);
  }

  private floorFor(owner: number, key: string): string | null {
    return this.links(owner).find((l) => l.project === key.split('-')[0])?.floor ?? null;
  }

  /** Imports a ticket from the owner's Jira into their desk and compiles it. */
  async prepare(owner: number, key: string): Promise<Ticket> {
    const cfg = this.config(this.o.tenancy.jira(owner));
    if (!cfg) throw new Error('connect Jira at the Jira kiosk first');
    return this.o.desk.save(owner, await fetchIssue(cfg, key));
  }

  /** Runs a ticket on the floor its project is linked to. */
  async runTicket(owner: number, key: string, opts: { ref?: string } = {}): Promise<{ id: number; floor: string }> {
    const floor = this.floorFor(owner, key);
    if (!floor) throw new Error(`no floor is linked to the Jira project ${key.split('-')[0]}; link it at the Jira kiosk`);
    await this.prepare(owner, key);
    if (floor === 'demo') {
      const row = this.o.tenancy.jira(owner)!;
      const ep = this.o.arena.start(
        { ticket: key, owner, stepDelayMs: 300, target: { kind: 'shoplite', mutations: [] }, notifyJira: true },
        { kind: 'jira', key, url: `${row.base_url}/browse/${key}` },
      );
      return { id: ep.id, floor };
    }
    const repo = this.o.tenancy.repo(floor);
    if (!repo || repo.owner_id !== owner) throw new Error(`${floor} is no longer one of your repositories`);
    const { id } = await this.o.github.runBranch(floor, opts.ref, { ticket: key, event: 'jira', notifyJira: true });
    return { id, floor };
  }

  private async onStatus(row: JiraRow, key: string, status: string | null) {
    if (status !== row.ready_status) return { started: false, reason: `status is ${status}` };
    if (!this.floorFor(row.owner_id, key)) return { started: false, reason: `no floor is linked to ${key.split('-')[0]}` };
    return { started: true, ...(await this.runTicket(row.owner_id, key)) };
  }

  /** A push or a manual run: the ticket named by its branch or commit, if the owner has it. */
  private async ticketForCommit(owner: number, repo: string, ref: string, message: string): Promise<{ key: string; jira: boolean } | null> {
    const key = ref.match(KEY)?.[1] ?? message.match(KEY)?.[1];
    if (!key) return null;
    if (this.floorFor(owner, key)?.toLowerCase() === repo.toLowerCase()) {
      await this.prepare(owner, key);
      return { key, jira: true };
    }
    return this.o.tenancy.ticket(owner, key) ? { key, jira: false } : null;
  }

  private async comment(ep: Episode) {
    if (!ep.request.notifyJira || ep.owner == null) return;
    const cfg = this.config(this.o.tenancy.jira(ep.owner));
    if (!cfg) return;
    const replayUrl = this.o.publicUrl ? new URL(`office/?episode=${ep.id}`, this.o.publicUrl).toString() : undefined;
    const out = checkOutput(ep, replayUrl);
    const t = ep.trigger;
    try {
      await postArenaComment(cfg, ep.request.ticket, {
        id: ep.id,
        conclusion: out.conclusion,
        title: out.title,
        where: t.kind === 'github' ? `${t.repo} @ ${t.ref} (${t.sha.slice(0, 7)})` : ep.label || 'the ShopLite demo',
        criteria: (ep.results.sentinel ?? []).map((r) => ({ criterion: r.criterion, verdict: r.verdict, rule: r.rule })),
        fixerRewrote: (ep.results.rival ?? []).filter((r) => r.editedAssertions).map((r) => r.criterion),
        replayUrl,
      });
    } catch (err) {
      console.warn(`Jira comment on ${ep.request.ticket} failed: ${(err as Error).message}`);
    }
  }

  register(app: FastifyInstance) {
    const status = (owner: number | null) => {
      const row = owner == null ? null : this.o.tenancy.jira(owner);
      return {
        configured: Boolean(row),
        site: row?.base_url ?? null,
        account: row?.account ?? null,
        readyStatus: row?.ready_status ?? 'Ready for QA',
        links: row?.links ?? [],
        canReceive: Boolean(this.o.publicUrl),
      };
    };
    app.get('/api/jira', async (req) => status(this.o.auth.caller(req)?.user?.id ?? null));

    app.post<{ Body: { baseUrl?: string; email?: string; token?: string; readyStatus?: string; criteriaField?: string } }>('/api/jira/connect', async (req, reply) => {
      const c = this.o.auth.require(req, reply, 'user');
      if (!c) return;
      const b = req.body ?? {};
      let base: URL;
      try {
        base = new URL(String(b.baseUrl ?? '').trim());
      } catch {
        return reply.status(400).send({ error: 'site must look like https://your-team.atlassian.net' });
      }
      if (base.protocol !== 'https:' && process.env.ARENA_ALLOW_PRIVATE !== '1') return reply.status(400).send({ error: 'the Jira site must use https' });
      await assertPublic(base.origin);
      const cfg = { baseUrl: base.origin, email: String(b.email ?? '').trim(), token: String(b.token ?? '').trim() };
      if (!cfg.email || !cfg.token) return reply.status(400).send({ error: 'email and API token are both needed' });
      const account = await jiraWhoAmI(cfg);
      const before = this.o.tenancy.jira(c.user!.id);
      this.o.tenancy.saveJira({
        owner_id: c.user!.id,
        base_url: cfg.baseUrl,
        email: cfg.email,
        token: seal(cfg.token),
        account,
        ready_status: b.readyStatus?.trim() || before?.ready_status || 'Ready for QA',
        criteria_field: b.criteriaField?.trim() || null,
        webhook_secret: before?.webhook_secret ?? randomBytes(24).toString('base64url'),
        links: before?.links ?? [],
      });
      return status(c.user!.id);
    });

    app.delete('/api/jira', async (req, reply) => {
      const c = this.o.auth.require(req, reply, 'user');
      if (!c) return;
      this.o.tenancy.dropJira(c.user!.id);
      return status(c.user!.id);
    });

    /** The address the person's Jira automation calls; it carries their secret. */
    app.get('/api/jira/webhook', async (req, reply) => {
      const c = this.o.auth.require(req, reply, 'user');
      if (!c) return;
      const row = this.o.tenancy.jira(c.user!.id);
      if (!row || !this.o.publicUrl) return reply.status(409).send({ error: 'connect Jira on a server with a public address first' });
      return { url: new URL(`webhooks/jira/${row.id}?secret=${encodeURIComponent(row.webhook_secret)}`, this.o.publicUrl).toString(), readyStatus: row.ready_status };
    });

    app.put<{ Body: { project?: string; floor?: string } }>('/api/jira/links', async (req, reply) => {
      const c = this.o.auth.require(req, reply, 'user');
      if (!c) return;
      const row = this.o.tenancy.jira(c.user!.id);
      if (!row) return reply.status(409).send({ error: 'connect Jira first' });
      const link = Link.parse({ project: String(req.body?.project ?? '').trim().toUpperCase(), floor: req.body?.floor });
      if (link.floor !== 'demo' && this.o.tenancy.repo(link.floor)?.owner_id !== c.user!.id) return reply.status(400).send({ error: `${link.floor} is not one of your repositories` });
      row.links = [...row.links.filter((l) => l.project !== link.project), link].sort((a, b) => a.project.localeCompare(b.project));
      this.o.tenancy.saveJira(row);
      return status(c.user!.id);
    });

    app.delete<{ Params: { project: string } }>('/api/jira/links/:project', async (req, reply) => {
      const c = this.o.auth.require(req, reply, 'user');
      if (!c) return;
      const row = this.o.tenancy.jira(c.user!.id);
      if (row) {
        row.links = row.links.filter((l) => l.project !== req.params.project);
        this.o.tenancy.saveJira(row);
      }
      return status(c.user!.id);
    });

    app.post<{ Params: { key: string }; Body: { ref?: string } }>('/api/jira/tickets/:key/run', async (req, reply) => {
      const c = this.o.auth.require(req, reply, 'run');
      if (!c?.user) return c ? reply.status(403).send({ error: 'tickets belong to people; sign in or use your own token' }) : undefined;
      if (!TICKET_KEY.test(req.params.key)) return reply.status(400).send({ error: 'ticket keys look like SHOP-42' });
      return this.runTicket(c.user.id, req.params.key, { ref: req.body?.ref });
    });

    /** Each connection's own address; the secret proves it is that person's Jira calling. */
    app.post<{ Params: { id: string }; Querystring: { secret?: string } }>('/webhooks/jira/:id', async (req, reply) => {
      const row = this.o.tenancy.jiraById(Number(req.params.id));
      if (!row || !req.query.secret || req.query.secret !== row.webhook_secret) return reply.status(401).send({ error: 'bad or missing secret' });
      const hook = readWebhook(req.body);
      if (!hook) return reply.status(400).send({ error: 'not an issue event' });
      return this.onStatus(row, hook.key, hook.status);
    });
  }
}
