import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ticket } from '@sentinelqa/core';
import type { Arena, Episode } from './arena/arena.ts';
import { assertPublic } from './arena/targets.ts';
import type { Store } from './db.ts';
import { checkOutput, type GithubApp } from './github.ts';
import { fetchIssue, jiraConfigFromEnv, jiraWhoAmI, postArenaComment, readWebhook, type JiraConfig } from './jira.ts';
import type { SentinelService } from './service.ts';

/**
 * Jira, connected from the lobby the way GitHub is. A Jira project is linked to a floor (the demo or
 * a connected repository). When one of its tickets reaches the ready status, SentinelQA imports it,
 * compiles its acceptance criteria and runs it on that floor; a push whose branch or commit names the
 * ticket checks it again. Every such run is posted back to the ticket as a comment.
 */

const Link = z.object({ project: z.string().regex(/^[A-Z][A-Z0-9]+$/), floor: z.string().min(1) });
type Link = z.infer<typeof Link>;

const Connection = z.object({
  baseUrl: z.string().url(),
  email: z.string().email(),
  token: z.string().min(8),
  account: z.string(),
  readyStatus: z.string().default('Ready for QA'),
  criteriaField: z.string().optional(),
  webhookSecret: z.string(),
  links: z.array(Link).default([]),
});
type Connection = z.infer<typeof Connection>;

const KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;

interface Opts {
  file: string;
  svc: SentinelService;
  store: Store;
  arena: Arena;
  github: GithubApp;
  suitesDir: string;
  publicUrl: string | undefined;
  allow: (req: FastifyRequest, reply: FastifyReply, scope: 'run' | 'operator') => boolean;
}

export class JiraHub {
  private conn: Connection | null = null;

  constructor(private o: Opts) {
    if (existsSync(o.file)) this.conn = Connection.parse(JSON.parse(readFileSync(o.file, 'utf8')));
    this.apply();
    o.github.ticketFor = (repo, ref, message) => this.ticketForCommit(repo, ref, message);
    o.arena.bus.on('finished', (ep: Episode) => void this.comment(ep));
  }

  /** The connection made in the lobby wins; the .env settings are the fallback. */
  config(): JiraConfig | null {
    if (this.conn) return { baseUrl: this.conn.baseUrl, email: this.conn.email, token: this.conn.token, readyStatus: this.conn.readyStatus, criteriaField: this.conn.criteriaField };
    return jiraConfigFromEnv();
  }

  links(): Link[] {
    return this.conn?.links ?? [];
  }

  private apply() {
    this.o.svc.cfg.jira = this.config();
  }

  private save() {
    writeFileSync(this.o.file, JSON.stringify(this.conn, null, 2), { mode: 0o600 });
    this.apply();
  }

  private secret(): string | null {
    return this.conn?.webhookSecret ?? process.env.JIRA_WEBHOOK_SECRET ?? null;
  }

  private floorFor(key: string): string | null {
    const project = key.split('-')[0];
    return this.links().find((l) => l.project === project)?.floor ?? null;
  }

  private browseUrl(key: string) {
    const c = this.config();
    return c ? `${c.baseUrl}/browse/${key}` : '';
  }

  /**
   * Imports the ticket and makes sure it has a contract and a spec. When its criteria changed, the
   * old baseline no longer fits and is dropped, so the next run records a new one.
   */
  async prepare(key: string): Promise<Ticket> {
    const cfg = this.config();
    if (!cfg) throw new Error('Jira is not connected');
    const before = this.o.store.ticket(key);
    const t = await fetchIssue(cfg, key);
    this.o.svc.receive(t);
    if (!t.criteria.length) throw new Error(`${key} has no acceptance criteria (lines like "AC-1: Given ... when ... then ...")`);
    const changed = JSON.stringify(before?.criteria ?? null) !== JSON.stringify(t.criteria);
    const suite = this.o.svc.suite(key);
    if (changed || !(await suite.contract())) {
      await this.o.svc.compile(key);
      await this.o.svc.generate(key);
      await unlink(join(this.o.suitesDir, key, 'baseline.json')).catch(() => {});
    }
    return t;
  }

  /** Runs one ticket on its floor: the latest commit of the repository's default branch, or the demo. */
  async runTicket(key: string, opts: { ref?: string } = {}): Promise<{ id: number; floor: string }> {
    await this.prepare(key);
    const floor = this.floorFor(key);
    if (!floor) throw new Error(`no floor is linked to the Jira project ${key.split('-')[0]}; link it at the Jira kiosk`);
    if (floor === 'demo') {
      const ep = this.o.arena.start(
        { ticket: key, stepDelayMs: 300, target: { kind: 'shoplite', mutations: [] }, notifyJira: true },
        { kind: 'jira', key, url: this.browseUrl(key) },
      );
      return { id: ep.id, floor };
    }
    const { id } = await this.o.github.runBranch(floor, opts.ref, { ticket: key, event: 'jira' });
    return { id, floor };
  }

  /** Jira says a ticket moved. Only the ready status starts anything. */
  async onStatus(key: string, status: string | null) {
    const cfg = this.config();
    if (!cfg || status !== cfg.readyStatus) return { started: false, reason: `status is ${status}` };
    // Tickets of unlinked projects keep the original flow: the dashboard pipeline on ShopLite.
    if (!this.floorFor(key)) return this.o.svc.onJiraStatus(key, status);
    const run = await this.runTicket(key);
    return { started: true, ...run };
  }

  /** A push or a manual run on a repository: the ticket named by its branch or commit message, if linked here. */
  private async ticketForCommit(repo: string, ref: string, message: string): Promise<string | null> {
    if (!this.config()) return null;
    const key = ref.match(KEY)?.[1] ?? message.match(KEY)?.[1];
    if (!key || this.floorFor(key)?.toLowerCase() !== repo.toLowerCase()) return null;
    await this.prepare(key);
    return key;
  }

  private async comment(ep: Episode) {
    const cfg = this.config();
    if (!cfg || !ep.request.notifyJira) return;
    const replayUrl = this.o.publicUrl ? new URL(`office/?episode=${ep.id}`, this.o.publicUrl).toString() : undefined;
    const out = checkOutput(ep, replayUrl);
    const t = ep.trigger;
    const where = t.kind === 'github' ? `${t.repo} @ ${t.ref} (${t.sha.slice(0, 7)})` : ep.label || 'the ShopLite demo';
    try {
      await postArenaComment(cfg, ep.request.ticket, {
        id: ep.id,
        conclusion: out.conclusion,
        title: out.title,
        where,
        criteria: (ep.results.sentinel ?? []).map((r) => ({ criterion: r.criterion, verdict: r.verdict, rule: r.rule })),
        fixerRewrote: (ep.results.rival ?? []).filter((r) => r.editedAssertions).map((r) => r.criterion),
        replayUrl,
      });
    } catch (err) {
      console.warn(`Jira comment on ${ep.request.ticket} failed: ${(err as Error).message}`);
    }
  }

  register(app: FastifyInstance) {
    const status = () => {
      const c = this.config();
      return {
        configured: Boolean(c),
        from: this.conn ? 'lobby' : c ? 'env' : null,
        site: c?.baseUrl ?? null,
        account: this.conn?.account ?? null,
        readyStatus: c?.readyStatus ?? 'Ready for QA',
        links: this.links(),
        canReceive: Boolean(this.o.publicUrl),
      };
    };
    app.get('/api/jira', async () => status());

    /** The operator types the site, their email and an API token; the server checks them before keeping them. */
    app.post<{ Body: { baseUrl?: string; email?: string; token?: string; readyStatus?: string; criteriaField?: string } }>('/api/jira/connect', async (req, reply) => {
      if (!this.o.allow(req, reply, 'operator')) return;
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
      this.conn = Connection.parse({
        ...cfg,
        account,
        readyStatus: b.readyStatus?.trim() || this.conn?.readyStatus || 'Ready for QA',
        criteriaField: b.criteriaField?.trim() || undefined,
        webhookSecret: this.conn?.webhookSecret ?? randomBytes(24).toString('base64url'),
        links: this.conn?.links ?? [],
      });
      this.save();
      return status();
    });

    app.delete('/api/jira', async (req, reply) => {
      if (!this.o.allow(req, reply, 'operator')) return;
      this.conn = null;
      rmSync(this.o.file, { force: true });
      this.apply();
      return status();
    });

    /** The address Jira's automation rule calls; it carries the secret, so only the operator sees it. */
    app.get('/api/jira/webhook', async (req, reply) => {
      if (!this.o.allow(req, reply, 'operator')) return;
      const secret = this.secret();
      if (!this.o.publicUrl || !secret) return reply.status(409).send({ error: 'connect Jira on a server with a public address first' });
      return { url: new URL(`webhooks/jira?secret=${encodeURIComponent(secret)}`, this.o.publicUrl).toString(), readyStatus: this.config()?.readyStatus };
    });

    app.put<{ Body: { project?: string; floor?: string } }>('/api/jira/links', async (req, reply) => {
      if (!this.o.allow(req, reply, 'operator')) return;
      if (!this.conn) return reply.status(409).send({ error: 'connect Jira in the lobby first' });
      const link = Link.parse({ project: String(req.body?.project ?? '').trim().toUpperCase(), floor: req.body?.floor });
      if (link.floor !== 'demo' && !(await this.o.github.connected()).some((r) => r.repo === link.floor)) return reply.status(400).send({ error: `${link.floor} is not a connected repository` });
      this.conn.links = [...this.conn.links.filter((l) => l.project !== link.project), link].sort((a, b) => a.project.localeCompare(b.project));
      this.save();
      return status();
    });

    app.delete<{ Params: { project: string } }>('/api/jira/links/:project', async (req, reply) => {
      if (!this.o.allow(req, reply, 'operator')) return;
      if (this.conn) {
        this.conn.links = this.conn.links.filter((l) => l.project !== req.params.project);
        this.save();
      }
      return status();
    });

    /** Run one ticket on its floor now, without waiting for Jira. */
    app.post<{ Params: { key: string }; Body: { ref?: string } }>('/api/jira/tickets/:key/run', async (req, reply) => {
      if (!this.o.allow(req, reply, 'run')) return;
      if (!KEY.test(req.params.key)) return reply.status(400).send({ error: 'ticket keys look like SHOP-42' });
      return this.runTicket(req.params.key, { ref: req.body?.ref });
    });

    app.post<{ Params: { key: string } }>('/api/jira/import/:key', async (req, reply) => {
      if (!this.o.allow(req, reply, 'run')) return;
      return this.prepare(req.params.key);
    });

    /** Jira automation ("Send web request") or a system webhook on issue updates. */
    app.post<{ Querystring: { secret?: string } }>('/webhooks/jira', async (req, reply) => {
      const secret = this.secret();
      if (!secret || req.query.secret !== secret) return reply.status(401).send({ error: 'bad or missing secret' });
      const hook = readWebhook(req.body);
      if (!hook) return reply.status(400).send({ error: 'not an issue event' });
      return this.onStatus(hook.key, hook.status);
    });
  }
}
