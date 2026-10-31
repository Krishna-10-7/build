import { createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CriterionResult } from '@sentinelqa/core';
import type { Arena, Episode, Trigger } from './arena/arena.ts';

/**
 * GitHub App integration, the way hosting platforms do it: the operator creates the app in one
 * click from a manifest, installs it on repositories, and every push to them runs the arena on
 * that commit and reports back as a "SentinelQA" check on the commit.
 */

/** GitHub Enterprise (or a test double) can be set with GITHUB_API_URL. */
const api = () => process.env.GITHUB_API_URL ?? 'https://api.github.com';

const Creds = z.object({
  id: z.number(),
  slug: z.string(),
  owner: z.string(),
  htmlUrl: z.string(),
  pem: z.string(),
  webhookSecret: z.string(),
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
  file: string;
  /** Where GitHub reaches this server, e.g. https://r2-d2.xyz/sentinel/ */
  publicUrl: string | undefined;
  defaultTicket: string;
  /** Sends 401 or 403 and returns false unless the caller may. */
  allow: (req: FastifyRequest, reply: FastifyReply, scope: 'run' | 'operator') => boolean;
}

export class GithubApp {
  private creds: Creds | null = null;
  private states = new Map<string, number>();
  private tokens = new Map<number, { token: string; until: number }>();
  private installationOf = new Map<string, number>();
  private repoCache: { at: number; repos: ConnectedRepo[] } | null = null;

  constructor(private opts: Opts) {
    if (existsSync(opts.file)) this.creds = Creds.parse(JSON.parse(readFileSync(opts.file, 'utf8')));
    opts.arena.githubToken = (repo) => this.tokenForRepo(repo);
    opts.arena.bus.on('started', (ep: Episode) => void this.report(ep).catch(() => {}));
    opts.arena.bus.on('finished', (ep: Episode) => void this.report(ep).catch(() => {}));
  }

  get configured() {
    return Boolean(this.creds);
  }

  // ---------- GitHub API ----------

  private jwt(): string {
    const c = this.creds!;
    const now = Math.floor(Date.now() / 1000);
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: c.id })}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(c.pem).toString('base64url')}`;
  }

  private async call<T>(method: string, path: string, auth: 'app' | number | null, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'sentinelqa' };
    if (auth === 'app') headers.authorization = `Bearer ${this.jwt()}`;
    else if (typeof auth === 'number') headers.authorization = `token ${await this.installationToken(auth)}`;
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

  private async installationFor(repo: string): Promise<number> {
    const hit = this.installationOf.get(repo);
    if (hit) return hit;
    const inst = await this.call<{ id: number }>('GET', `/repos/${repo}/installation`, 'app');
    this.installationOf.set(repo, inst.id);
    return inst.id;
  }

  private async tokenForRepo(repo: string): Promise<string | null> {
    if (!this.creds) return null;
    return this.installationToken(await this.installationFor(repo));
  }

  /** Only repositories of the account that owns the app; the app is private, so GitHub enforces it too. */
  private allowed(owner: string) {
    return Boolean(this.creds) && owner.toLowerCase() === this.creds!.owner.toLowerCase();
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

  // ---------- runs ----------

  private replayUrl(id: number) {
    return this.opts.publicUrl ? new URL(`office/?episode=${id}`, this.opts.publicUrl).toString() : undefined;
  }

  /** Queues an episode for one commit and opens a check run on it. */
  async runCommit(t: { repo: string; ref: string; sha: string; message: string; author: string; url: string; event: 'push' | 'manual' }, installation: number, isPrivate: boolean) {
    this.installationOf.set(t.repo, installation);
    const cfg = await this.repoConfig(t.repo, t.sha, installation);
    if (t.event === 'push' && cfg.branches && !cfg.branches.includes(t.ref)) return null;
    const trigger: GithubTrigger = { kind: 'github', ...t };
    const ep = this.opts.arena.start(
      {
        ticket: cfg.ticket ?? this.opts.defaultTicket,
        stepDelayMs: 300,
        target: { kind: 'github', repo: t.repo, ref: t.ref, sha: t.sha, private: isPrivate, install:  cfg.install ?? 'npm install --no-audit --no-fund', start: cfg.start ?? 'npm start' },
      },
      trigger,
    );
    try {
      const check = await this.call<{ id: number }>('POST', `/repos/${t.repo}/check-runs`, installation, {
        name: 'SentinelQA',
        head_sha: t.sha,
        status: ep.status === 'queued' ? 'queued' : 'in_progress',
        external_id: String(ep.id),
        details_url: this.replayUrl(ep.id),
        output: { title: 'Waiting for the arena', summary: `Episode #${ep.id} on ticket ${ep.request.ticket}.` },
      });
      trigger.check = { installation, id: check.id };
    } catch (err) {
      console.warn(`check run for ${t.repo}@${t.sha.slice(0, 7)} not created: ${(err as Error).message}`);
    }
    return ep;
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

  // ---------- connected repositories ----------

  async connected(): Promise<ConnectedRepo[]> {
    if (!this.creds) return [];
    if (this.repoCache && Date.now() - this.repoCache.at < 30_000) return this.repoCache.repos;
    const installs = await this.call<{ id: number; account: { login: string } }[]>('GET', '/app/installations', 'app');
    const repos: ConnectedRepo[] = [];
    for (const inst of installs.filter((i) => this.allowed(i.account.login))) {
      const list = await this.call<{ repositories: { full_name: string; default_branch: string; private: boolean; html_url: string }[] }>('GET', '/installation/repositories?per_page=100', inst.id);
      for (const r of list.repositories) {
        this.installationOf.set(r.full_name, inst.id);
        repos.push({ repo: r.full_name, defaultBranch: r.default_branch, private: r.private, url: r.html_url });
      }
    }
    this.repoCache = { at: Date.now(), repos };
    return repos;
  }

  /** Runs the latest commit of a branch of a connected repository (its default branch when none is given). */
  async runBranch(repo: string, ref?: string): Promise<{ id: number }> {
    const r = (await this.connected()).find((x) => x.repo.toLowerCase() === repo.toLowerCase());
    if (!r) throw Object.assign(new Error(`${repo || 'that repository'} is not connected`), { statusCode: 404 });
    const branch = ref || r.defaultBranch;
    if (!/^[\w][\w./-]*$/.test(branch)) throw new Error('bad branch name');
    const inst = await this.installationFor(r.repo);
    const commit = await this.call<{ sha: string; html_url: string; commit: { message: string; author: { name: string } } }>('GET', `/repos/${r.repo}/commits/${encodeURIComponent(branch)}`, inst);
    const ep = await this.runCommit({ repo: r.repo, ref: branch, sha: commit.sha, message: commit.commit.message.split('\n')[0], author: commit.commit.author.name, url: commit.html_url, event: 'manual' }, inst, r.private);
    return { id: ep!.id };
  }

  // ---------- routes ----------

  register(app: FastifyInstance) {
    app.get('/api/github', async () => {
      const c = this.creds;
      let repos: ConnectedRepo[] = [];
      let error: string | null = null;
      if (c) repos = await this.connected().catch((err) => ((error = (err as Error).message), []));
      return {
        configured: Boolean(c),
        canSetup: Boolean(this.opts.publicUrl),
        app: c ? { slug: c.slug, owner: c.owner, url: c.htmlUrl, installUrl: `https://github.com/apps/${c.slug}/installations/new` } : null,
        webhookUrl: this.opts.publicUrl ? new URL('api/github/webhook', this.opts.publicUrl).toString() : null,
        repos,
        error,
      };
    });

    /** Step 1 of the one-click setup: the browser posts this manifest to GitHub. */
    app.post('/api/github/manifest', async (req, reply) => {
      if (!this.opts.allow(req, reply, 'operator')) return;
      const base = this.opts.publicUrl;
      if (!base) return reply.status(400).send({ error: 'PUBLIC_URL is not set, so GitHub cannot reach this server' });
      if (this.creds) return reply.status(409).send({ error: 'a GitHub App is already set up' });
      const state = randomBytes(16).toString('hex');
      this.states.set(state, Date.now() + 15 * 60_000);
      const u = (p: string) => new URL(p, base).toString();
      return {
        action: `https://github.com/settings/apps/new?state=${state}`,
        manifest: {
          name: `SentinelQA ${new URL(base).hostname}`,
          url: base,
          hook_attributes: { url: u('api/github/webhook'), active: true },
          redirect_url: u('api/github/created'),
          setup_url: u('console/#/github'),
          setup_on_update: true,
          public: false,
          default_permissions: { checks: 'write', contents: 'read', metadata: 'read' },
          default_events: ['push'],
        },
      };
    });

    /** Step 2: GitHub sends the browser back with a one-time code for the new app's credentials. */
    app.get<{ Querystring: { code?: string; state?: string } }>('/api/github/created', async (req, reply) => {
      const { code, state } = req.query;
      const until = state ? this.states.get(state) : undefined;
      if (!code || !until || until < Date.now()) return reply.status(400).send({ error: 'this setup link expired; start again from the dashboard' });
      this.states.delete(state!);
      if (!/^[\w-]+$/.test(code)) return reply.status(400).send({ error: 'bad code' });
      const made = await this.call<{ id: number; slug: string; owner: { login: string }; html_url: string; pem: string; webhook_secret: string }>('POST', `/app-manifests/${code}/conversions`, null);
      this.creds = { id: made.id, slug: made.slug, owner: made.owner.login, htmlUrl: made.html_url, pem: made.pem, webhookSecret: made.webhook_secret };
      writeFileSync(this.opts.file, JSON.stringify(this.creds, null, 2), { mode: 0o600 });
      return reply.redirect(`https://github.com/apps/${made.slug}/installations/new`);
    });

    /** Run the arena on the latest commit of a connected repository's branch. */
    app.post<{ Body: { repo?: string; ref?: string } }>('/api/github/run', async (req, reply) => {
      if (!this.opts.allow(req, reply, 'run')) return;
      return this.runBranch(req.body?.repo ?? '', req.body?.ref);
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
        if (event === 'installation' || event === 'installation_repositories') {
          this.repoCache = null;
          return { ok: true };
        }
        if (event !== 'push') return { ok: true, ignored: event };
        if (p.deleted || !String(p.ref).startsWith('refs/heads/') || /^0+$/.test(p.after)) return { ok: true, ignored: 'not a branch update' };
        if (!this.allowed(p.repository.owner.login ?? p.repository.owner.name)) return reply.status(403).send({ error: 'repository owner is not allowed' });
        const ep = await this.runCommit(
          {
            repo: p.repository.full_name,
            ref: String(p.ref).slice('refs/heads/'.length),
            sha: p.after,
            message: String(p.head_commit?.message ?? '').split('\n')[0],
            author: p.head_commit?.author?.name ?? p.pusher?.name ?? '',
            url: p.head_commit?.url ?? p.compare ?? '',
            event: 'push',
          },
          p.installation.id,
          Boolean(p.repository.private),
        );
        return ep ? { ok: true, episode: ep.id } : { ok: true, ignored: 'branch not listed in sentinelqa.json' };
      });
    });
  }
}

export interface ConnectedRepo {
  repo: string;
  defaultBranch: string;
  private: boolean;
  url: string;
}

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** What the commit shows: SentinelQA's verdicts decide; the Fixer's claim is listed beside them. */
export function checkOutput(ep: Pick<Episode, 'id' | 'status' | 'error' | 'results' | 'request'>, replayUrl?: string) {
  const watch = replayUrl ? `\n\n[Replay this run in the office](${replayUrl})` : '';
  const s = ep.results.sentinel;
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
