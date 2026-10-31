import { createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { CriterionResult } from '@sentinelqa/core';
import type { Arena, Episode, Trigger } from './arena/arena.ts';
import { Auth, SESSION_COOKIE, type Caller } from './auth.ts';
import type { Tenancy } from './tenancy.ts';
import type { TicketDesk } from './tickets.ts';

/**
 * GitHub, for everyone. One public GitHub App, created by the operator in one click from a manifest:
 * people sign in with it, install it on their repositories, and each repository becomes a floor that
 * belongs to whoever connected it first. Every push to it runs the arena on that commit, inside the
 * sandbox, and reports back as a "SentinelQA" check on the commit.
 */

/** GitHub Enterprise (or a test double) can be set with GITHUB_API_URL and GITHUB_WEB_URL. */
const api = () => process.env.GITHUB_API_URL ?? 'https://api.github.com';
const web = () => process.env.GITHUB_WEB_URL ?? 'https://github.com';

const Creds = z.object({
  id: z.number(),
  slug: z.string(),
  owner: z.string(),
  htmlUrl: z.string(),
  pem: z.string(),
  webhookSecret: z.string(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});
type Creds = z.infer<typeof Creds>;

/** Optional sentinelqa.json at the repository root. */
const RepoConfig = z.object({
  ticket: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).optional(),
  install: z.string().max(300).optional(),
  start: z.string().max(300).optional(),
  /** Only pushes to these branches run; all branches when left out. */
  branches: z.array(z.string()).optional(),
});
type RepoConfig = z.infer<typeof RepoConfig>;

type GithubTrigger = Extract<Trigger, { kind: 'github' }> & { check?: { installation: number; id: number } };

interface Opts {
  arena: Arena;
  tenancy: Tenancy;
  desk: TicketDesk;
  auth: Auth;
  file: string;
  /** Where GitHub reaches this server, e.g. https://r2-d2.xyz/sentinel/ */
  publicUrl: string | undefined;
  /** GitHub logins that get the operator role when they sign in. */
  operators: string[];
}

export interface ConnectedRepo {
  repo: string;
  defaultBranch: string;
  private: boolean;
  url: string;
  defaultTicket: string | null;
  owner: number;
}

export class GithubApp {
  private creds: Creds | null = null;
  private states = new Map<string, { until: number; next: string }>();
  private tokens = new Map<number, { token: string; until: number }>();

  /**
   * The ticket a commit is about: a key in the branch name or commit message that the owner has
   * (from their Jira or written in the tower). Set by the Jira hub.
   */
  ticketFor?: (owner: number, repo: string, ref: string, message: string) => Promise<{ key: string; jira: boolean } | null>;

  constructor(private o: Opts) {
    if (existsSync(o.file)) this.creds = Creds.parse(JSON.parse(readFileSync(o.file, 'utf8')));
    o.arena.githubToken = (repo) => this.tokenForRepo(repo);
    o.arena.bus.on('started', (ep: Episode) => void this.report(ep).catch(() => {}));
    o.arena.bus.on('finished', (ep: Episode) => void this.report(ep).catch(() => {}));
  }

  get configured() {
    return Boolean(this.creds);
  }

  get canSignIn() {
    return Boolean(this.creds?.clientId && this.creds.clientSecret);
  }

  get installUrl(): string | null {
    return this.creds ? `${web()}/apps/${this.creds.slug}/installations/new` : null;
  }

  // ---------- GitHub API ----------

  private jwt(): string {
    const c = this.creds!;
    const now = Math.floor(Date.now() / 1000);
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: c.id })}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(c.pem).toString('base64url')}`;
  }

  /** auth: the app itself, an installation id, a person's OAuth token (string), or nobody. */
  private async call<T>(method: string, path: string, auth: 'app' | number | { user: string } | null, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'sentinelqa' };
    if (auth === 'app') headers.authorization = `Bearer ${this.jwt()}`;
    else if (typeof auth === 'number') headers.authorization = `token ${await this.installationToken(auth)}`;
    else if (auth) headers.authorization = `Bearer ${auth.user}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${api()}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]}: ${res.status} ${(data as { message?: string }).message ?? ''}`.trim());
    return data as T;
  }

  private async installationToken(installation: number): Promise<string> {
    const hit = this.tokens.get(installation);
    if (hit && hit.until > Date.now()) return hit.token;
    const t = await this.call<{ token: string; expires_at: string }>('POST', `/app/installations/${installation}/access_tokens`, 'app');
    this.tokens.set(installation, { token: t.token, until: Date.parse(t.expires_at) - 5 * 60_000 });
    return t.token;
  }

  private async tokenForRepo(repo: string): Promise<string | null> {
    const row = this.o.tenancy.repo(repo);
    return this.creds && row ? this.installationToken(row.installation) : null;
  }

  private async repoConfig(repo: string, sha: string, installation: number): Promise<RepoConfig> {
    try {
      const file = await this.call<{ content: string }>('GET', `/repos/${repo}/contents/sentinelqa.json?ref=${sha}`, installation);
      return RepoConfig.parse(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')));
    } catch (err) {
      if (/: 404/.test((err as Error).message)) return {};
      throw err;
    }
  }

  // ---------- people and their repositories ----------

  /**
   * After sign-in: who the person is, and every repository the app is installed on that they can
   * reach. Each unclaimed repository becomes theirs.
   */
  private async syncUser(token: string) {
    const me = await this.call<{ id: number; login: string; name: string | null; avatar_url: string }>('GET', '/user', { user: token });
    const operator = this.o.operators.some((l) => l.toLowerCase() === me.login.toLowerCase());
    const user = this.o.tenancy.upsertUser({ github_id: me.id, login: me.login, name: me.name, avatar: me.avatar_url }, operator);
    const installs = await this.call<{ installations: { id: number }[] }>('GET', '/user/installations?per_page=100', { user: token });
    for (const inst of installs.installations) {
      const list = await this.call<{ repositories: { full_name: string; default_branch: string; private: boolean; html_url: string }[] }>(
        'GET',
        `/user/installations/${inst.id}/repositories?per_page=100`,
        { user: token },
      );
      for (const r of list.repositories) this.o.tenancy.claimRepo({ repo: r.full_name, installation: inst.id, defaultBranch: r.default_branch, private: r.private, url: r.html_url }, user.id);
    }
    return user;
  }

  /** Repositories added through GitHub's own pages: they go to the person who added them, if known. */
  private async claimForSender(installation: number, senderGithubId: number, names: string[]) {
    const user = this.o.tenancy.userByGithub(senderGithubId);
    if (!user) return;
    for (const full of names) {
      const r = await this.call<{ full_name: string; default_branch: string; private: boolean; html_url: string }>('GET', `/repos/${full}`, installation).catch(() => null);
      if (r) this.o.tenancy.claimRepo({ repo: r.full_name, installation, defaultBranch: r.default_branch, private: r.private, url: r.html_url }, user.id);
    }
  }

  /** A caller's repositories: their own; every one for the operator. */
  reposFor(c: Caller | null): ConnectedRepo[] {
    const rows = c?.operator && !c.user ? this.o.tenancy.allRepos() : c?.user ? this.o.tenancy.reposOf(c.user.id) : [];
    return rows.map((r) => ({ repo: r.repo, defaultBranch: r.default_branch, private: Boolean(r.private), url: r.url, defaultTicket: r.default_ticket, owner: r.owner_id }));
  }

  /** The repository, if this caller may run it. */
  ownedBy(c: Caller | null, repo: string) {
    const row = this.o.tenancy.repo(repo);
    if (!row || !c) return null;
    return c.operator || c.user?.id === row.owner_id ? row : null;
  }

  // ---------- runs ----------

  private replayUrl(id: number) {
    return this.o.publicUrl ? new URL(`office/?episode=${id}`, this.o.publicUrl).toString() : undefined;
  }

  /** A check that finishes at once, for a push that will not run (no ticket, over the limit). */
  private async skipCheck(repo: string, sha: string, installation: number, title: string, summary: string) {
    await this.call('POST', `/repos/${repo}/check-runs`, installation, {
      name: 'SentinelQA',
      head_sha: sha,
      status: 'completed',
      conclusion: 'neutral',
      completed_at: new Date().toISOString(),
      output: { title, summary },
    }).catch(() => {});
  }

  /** Queues an episode for one commit of a claimed repository and opens a check run on it. */
  async runCommit(
    t: { repo: string; ref: string; sha: string; message: string; author: string; url: string; event: 'push' | 'manual' | 'jira' },
    opts: { ticket?: string; notifyJira?: boolean } = {},
  ): Promise<{ ep: Episode | null; skipped?: string }> {
    const row = this.o.tenancy.repo(t.repo);
    if (!row) return { ep: null, skipped: 'nobody has connected this repository' };
    const owner = row.owner_id;
    const cfg = await this.repoConfig(t.repo, t.sha, row.installation);
    if (t.event === 'push' && cfg.branches && !cfg.branches.includes(t.ref)) return { ep: null, skipped: 'branch not listed in sentinelqa.json' };

    const named = opts.ticket ? null : await this.ticketFor?.(owner, t.repo, t.ref, t.message).catch(() => null);
    const fromRepo = cfg.ticket && this.o.desk.find(owner, cfg.ticket) ? cfg.ticket : null;
    const ticket = opts.ticket ?? named?.key ?? row.default_ticket ?? fromRepo;
    if (!ticket) {
      const why = 'No ticket for this repository';
      await this.skipCheck(t.repo, t.sha, row.installation, why, 'Pick a default ticket for this repository on its floor in the tower, or name one in the branch (SHOP-42-fix) or the commit message.');
      return { ep: null, skipped: why };
    }
    const trigger: GithubTrigger = { kind: 'github', ...t };
    let ep: Episode;
    try {
      ep = this.o.arena.start(
        {
          ticket,
          owner,
          stepDelayMs: 300,
          target: { kind: 'github', repo: row.repo, ref: t.ref, sha: t.sha, private: Boolean(row.private), install: cfg.install ?? 'npm install --no-audit --no-fund', start: cfg.start ?? 'npm start' },
          // A ticket checked here for the first time takes its baseline from this build.
          baselineOnTarget: true,
          notifyJira: opts.notifyJira ?? Boolean(named?.jira),
        },
        trigger,
      );
    } catch (err) {
      await this.skipCheck(t.repo, t.sha, row.installation, 'Not run', (err as Error).message);
      throw err;
    }
    try {
      const check = await this.call<{ id: number }>('POST', `/repos/${row.repo}/check-runs`, row.installation, {
        name: 'SentinelQA',
        head_sha: t.sha,
        status: ep.status === 'queued' ? 'queued' : 'in_progress',
        external_id: String(ep.id),
        details_url: this.replayUrl(ep.id),
        output: { title: 'Waiting for the arena', summary: `Episode #${ep.id} on ticket ${ep.request.ticket}.` },
      });
      trigger.check = { installation: row.installation, id: check.id };
    } catch (err) {
      console.warn(`check run for ${t.repo}@${t.sha.slice(0, 7)} not created: ${(err as Error).message}`);
    }
    return { ep };
  }

  private async report(ep: Episode) {
    const trigger = ep.trigger as GithubTrigger;
    if (trigger.kind !== 'github' || !trigger.check) return;
    const path = `/repos/${trigger.repo}/check-runs/${trigger.check.id}`;
    if (ep.status === 'preparing' || ep.status === 'running') {
      await this.call('PATCH', path, trigger.check.installation, { status: 'in_progress', output: { title: 'Fixer and Sentinel are working', summary: `Watch it live: ${this.replayUrl(ep.id) ?? ''}` } });
      return;
    }
    const out = checkOutput(ep, this.replayUrl(ep.id));
    await this.call('PATCH', path, trigger.check.installation, { status: 'completed', conclusion: out.conclusion, completed_at: new Date().toISOString(), output: { title: out.title, summary: out.summary } });
  }

  /** Runs the latest commit of a branch (the default branch when none is given) of a claimed repository. */
  async runBranch(repo: string, ref?: string, opts: { ticket?: string; event?: 'manual' | 'jira'; notifyJira?: boolean } = {}): Promise<{ id: number }> {
    const row = this.o.tenancy.repo(repo);
    if (!row) throw Object.assign(new Error(`${repo || 'that repository'} is not connected`), { statusCode: 404 });
    const branch = ref || row.default_branch;
    if (!/^[\w][\w./-]*$/.test(branch)) throw new Error('bad branch name');
    const commit = await this.call<{ sha: string; html_url: string; commit: { message: string; author: { name: string } } }>('GET', `/repos/${row.repo}/commits/${encodeURIComponent(branch)}`, row.installation);
    const { ep, skipped } = await this.runCommit(
      { repo: row.repo, ref: branch, sha: commit.sha, message: commit.commit.message.split('\n')[0], author: commit.commit.author.name, url: commit.html_url, event: opts.event ?? 'manual' },
      { ticket: opts.ticket, notifyJira: opts.notifyJira },
    );
    if (!ep) throw Object.assign(new Error(skipped ?? 'not run'), { statusCode: 409 });
    return { id: ep.id };
  }

  // ---------- routes ----------

  private cookie(reply: FastifyReply, value: string, maxAge: number) {
    const base = this.o.publicUrl ? new URL(this.o.publicUrl) : null;
    const attrs = [`${SESSION_COOKIE}=${value}`, `Path=${base?.pathname ?? '/'}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (base?.protocol === 'https:') attrs.push('Secure');
    void reply.header('set-cookie', attrs.join('; '));
  }

  private home(next?: string) {
    // Only places inside this server, never another site.
    const safe = next && /^[\w./?=&%#-]*$/.test(next) && !next.startsWith('//') && !next.includes('://') ? next.replace(/^\//, '') : '';
    return this.o.publicUrl ? new URL(safe, this.o.publicUrl).toString() : `/${safe}`;
  }

  register(app: FastifyInstance) {
    app.get('/api/github', async (req) => {
      const c = this.o.auth.caller(req);
      return {
        configured: this.configured,
        canSetup: Boolean(this.o.publicUrl),
        canSignIn: this.canSignIn,
        installUrl: this.installUrl,
        app: this.creds && c?.operator ? { slug: this.creds.slug, owner: this.creds.owner, url: this.creds.htmlUrl } : null,
        repos: this.reposFor(c),
      };
    });

    /** The operator's one-time setup: the browser posts this manifest to GitHub. */
    app.post('/api/github/manifest', async (req, reply) => {
      if (!this.o.auth.require(req, reply, 'operator')) return;
      const base = this.o.publicUrl;
      if (!base) return reply.status(400).send({ error: 'PUBLIC_URL is not set, so GitHub cannot reach this server' });
      if (this.creds) return reply.status(409).send({ error: 'a GitHub App is already set up' });
      const state = randomBytes(16).toString('hex');
      this.states.set(state, { until: Date.now() + 15 * 60_000, next: '' });
      const u = (p: string) => new URL(p, base).toString();
      return {
        action: `${web()}/settings/apps/new?state=${state}`,
        manifest: {
          name: `SentinelQA ${new URL(base).hostname}`,
          url: base,
          hook_attributes: { url: u('api/github/webhook'), active: true },
          redirect_url: u('api/github/created'),
          callback_urls: [u('auth/github/callback')],
          // After installing, GitHub signs the person in here too, so their repositories become theirs.
          request_oauth_on_install: true,
          setup_on_update: true,
          public: true,
          default_permissions: { checks: 'write', contents: 'read', metadata: 'read' },
          default_events: ['push'],
        },
      };
    });

    app.get<{ Querystring: { code?: string; state?: string } }>('/api/github/created', async (req, reply) => {
      const { code, state } = req.query;
      const s = state ? this.states.get(state) : undefined;
      if (!code || !s || s.until < Date.now()) return reply.status(400).send({ error: 'this setup link expired; start again from the control room' });
      this.states.delete(state!);
      if (!/^[\w-]+$/.test(code)) return reply.status(400).send({ error: 'bad code' });
      const made = await this.call<{ id: number; slug: string; owner: { login: string }; html_url: string; pem: string; webhook_secret: string; client_id: string; client_secret: string }>(
        'POST',
        `/app-manifests/${code}/conversions`,
        null,
      );
      this.creds = { id: made.id, slug: made.slug, owner: made.owner.login, htmlUrl: made.html_url, pem: made.pem, webhookSecret: made.webhook_secret, clientId: made.client_id, clientSecret: made.client_secret };
      writeFileSync(this.o.file, JSON.stringify(this.creds, null, 2), { mode: 0o600 });
      return reply.redirect(this.home(''));
    });

    // ---------- sign in with GitHub ----------

    app.get<{ Querystring: { next?: string } }>('/auth/github/login', async (req, reply) => {
      if (!this.canSignIn) return reply.status(503).send({ error: 'sign-in is not set up yet: the operator connects GitHub first' });
      const state = randomBytes(16).toString('hex');
      this.states.set(state, { until: Date.now() + 10 * 60_000, next: req.query.next ?? '' });
      const redirect = new URL('auth/github/callback', this.o.publicUrl).toString();
      return reply.redirect(`${web()}/login/oauth/authorize?client_id=${encodeURIComponent(this.creds!.clientId!)}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`);
    });

    /** GitHub comes back here after sign-in, and after someone installs the app (then without our state). */
    app.get<{ Querystring: { code?: string; state?: string; installation_id?: string } }>('/auth/github/callback', async (req, reply) => {
      const { code, state, installation_id } = req.query;
      const s = state ? this.states.get(state) : undefined;
      if (state) this.states.delete(state);
      if (!code || !/^[\w-]+$/.test(code) || (!s && !installation_id) || (s && s.until < Date.now())) return reply.status(400).send({ error: 'this sign-in link expired; try again' });
      const res = await fetch(`${web()}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: this.creds!.clientId, client_secret: this.creds!.clientSecret, code }),
      });
      const tok = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
      if (!tok.access_token) return reply.status(400).send({ error: tok.error_description ?? 'GitHub did not sign you in' });
      const user = await this.syncUser(tok.access_token);
      if (user.disabled) return reply.status(403).send({ error: 'this account is disabled' });
      this.cookie(reply, this.o.auth.newSession(user.id), 14 * 86_400);
      return reply.redirect(this.home(s?.next || (installation_id ? '?github=installed' : '')));
    });

    app.post('/auth/logout', async (req, reply) => {
      this.o.auth.endSession(req);
      this.cookie(reply, '', 0);
      return { ok: true };
    });

    /** Local testing only (DEV_LOGIN=1): sign in as any name without GitHub. */
    app.get<{ Querystring: { login?: string; next?: string } }>('/auth/dev', async (req, reply) => {
      if (process.env.DEV_LOGIN !== '1') return reply.status(404).send({ error: 'not found' });
      const login = String(req.query.login ?? 'dev').replace(/[^\w-]/g, '').slice(0, 39) || 'dev';
      const githubId = 9_000_000_000 + [...login].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 1_000_000_000, 7);
      const user = this.o.tenancy.upsertUser({ github_id: githubId, login, name: login, avatar: null }, this.o.operators.includes(login));
      this.cookie(reply, this.o.auth.newSession(user.id), 14 * 86_400);
      return reply.redirect(this.home(req.query.next));
    });

    // ---------- a person's repositories ----------

    app.put<{ Params: { owner: string; name: string }; Body: { defaultTicket?: string | null } }>('/api/github/repos/:owner/:name', async (req, reply) => {
      const c = this.o.auth.require(req, reply, 'run');
      if (!c) return;
      const row = this.ownedBy(c, `${req.params.owner}/${req.params.name}`);
      if (!row) return reply.status(404).send({ error: 'not one of your repositories' });
      const t = req.body?.defaultTicket?.trim().toUpperCase() || null;
      if (t && !this.o.desk.find(row.owner_id, t)) return reply.status(400).send({ error: `${t} is not one of your tickets or a sample` });
      this.o.tenancy.setDefaultTicket(row.repo, row.owner_id, t);
      return { ok: true, defaultTicket: t };
    });

    app.post<{ Body: { repo?: string; ref?: string; ticket?: string } }>('/api/github/run', async (req, reply) => {
      const c = this.o.auth.require(req, reply, 'run');
      if (!c) return;
      if (!this.ownedBy(c, req.body?.repo ?? '')) return reply.status(404).send({ error: 'not one of your repositories' });
      return this.runBranch(req.body!.repo!, req.body?.ref, { ticket: req.body?.ticket?.toUpperCase() });
    });

    // The signature covers the exact bytes GitHub sent, so this route keeps the raw body.
    void app.register(async (scope) => {
      scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
      scope.post('/api/github/webhook', async (req, reply) => {
        if (!this.creds) return reply.status(503).send({ error: 'no GitHub App configured' });
        const raw = req.body as Buffer;
        if (!verifySignature(this.creds.webhookSecret, raw, req.headers['x-hub-signature-256'] as string | undefined)) return reply.status(401).send({ error: 'bad signature' });
        const event = req.headers['x-github-event'];
        const p = JSON.parse(raw.toString('utf8'));
        const inst = p.installation?.id as number | undefined;
        if (event === 'installation' && inst) {
          if (p.action === 'deleted') this.o.tenancy.dropRepos(inst);
          else if (p.action === 'created') await this.claimForSender(inst, p.sender.id, (p.repositories ?? []).map((r: { full_name: string }) => r.full_name));
          return { ok: true };
        }
        if (event === 'installation_repositories' && inst) {
          this.o.tenancy.dropRepos(inst, (p.repositories_removed ?? []).map((r: { full_name: string }) => r.full_name));
          await this.claimForSender(inst, p.sender.id, (p.repositories_added ?? []).map((r: { full_name: string }) => r.full_name));
          return { ok: true };
        }
        if (event !== 'push') return { ok: true, ignored: event };
        if (p.deleted || !String(p.ref).startsWith('refs/heads/') || /^0+$/.test(p.after)) return { ok: true, ignored: 'not a branch update' };
        const row = this.o.tenancy.repo(p.repository.full_name);
        if (!row || row.installation !== inst) return { ok: true, ignored: 'nobody has connected this repository here' };
        const { ep, skipped } = await this.runCommit({
          repo: p.repository.full_name,
          ref: String(p.ref).slice('refs/heads/'.length),
          sha: p.after,
          message: String(p.head_commit?.message ?? '').split('\n')[0],
          author: p.head_commit?.author?.name ?? p.pusher?.name ?? '',
          url: p.head_commit?.url ?? p.compare ?? '',
          event: 'push',
        }).catch((err) => ({ ep: null, skipped: (err as Error).message }));
        return ep ? { ok: true, episode: ep.id } : { ok: true, ignored: skipped };
      });
    });
  }
}

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** What the commit shows: SentinelQA's verdicts decide; the Fixer's claim is listed beside them. */
export function checkOutput(ep: Pick<Episode, 'id' | 'status' | 'error' | 'results' | 'request' | 'criteriaFailed'>, replayUrl?: string) {
  const watch = replayUrl ? `\n\n[Replay this run in the office](${replayUrl})` : '';
  const s = ep.results.sentinel;
  if (ep.criteriaFailed) return { conclusion: 'failure' as const, title: `${ep.request.ticket}: criteria fail on this build`, summary: `${ep.error ?? ''}${watch}` };
  if (ep.status !== 'finished' || !s) {
    return { conclusion: 'neutral' as const, title: 'Could not run', summary: `${ep.error ?? 'SentinelQA did not finish'}${watch}` };
  }
  const by = (v: CriterionResult['verdict']) => s.filter((r) => r.verdict === v).map((r) => r.criterion);
  const healed = s.reduce((n, r) => n + r.heals.filter((h) => h.decision === 'accepted').length, 0);
  const regressions = by('REGRESSION');
  const review = by('NEEDS_REVIEW');
  const unsure = [...by('ERROR'), ...by('FLAKY')];
  const [conclusion, title] = regressions.length
    ? (['failure', `Regression caught · ${regressions.join(', ')}`] as const)
    : review.length
      ? (['action_required', `A repair needs review · ${review.join(', ')}`] as const)
      : unsure.length
        ? (['neutral', `Inconclusive · ${unsure.join(', ')}`] as const)
        : (['success', `${s.length}/${s.length} criteria pass${healed ? ` · ${healed} locator${healed === 1 ? '' : 's'} healed` : ''}`] as const);
  const rival = new Map((ep.results.rival ?? []).map((r) => [r.criterion, r]));
  const rows = s.map((r) => {
    const f = rival.get(r.criterion);
    const fixer = !f ? '—' : !f.green ? 'red' : f.editedAssertions ? 'green, **after rewriting the assertion**' : 'green';
    return `| ${r.criterion} | **${r.verdict}** (${r.rule}) | ${fixer} |`;
  });
  const summary = [
    `Ticket **${ep.request.ticket}**, episode #${ep.id}.`,
    '',
    '| Criterion | SentinelQA | LLM test-fixer, for comparison |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
  return { conclusion, title, summary: summary + watch };
}
