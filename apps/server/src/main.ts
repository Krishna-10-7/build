import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { Contract, extractCriteria, llmConfigFromEnv, loadEnv, policies } from '@sentinelqa/core';
import { closeBrowser, type HealMode } from '@sentinelqa/engine';
import { Store } from './db.ts';
import { StageError, STAGES, TRANSITIONS } from './pipeline.ts';
import { SentinelService } from './service.ts';
import { jiraConfigFromEnv } from './jira.ts';
import { JiraHub } from './jira-hub.ts';
import { DESKS, EpisodeRequest, SCENARIOS, arenaFromEnv } from './arena/arena.ts';
import { cleanupSandboxes, loadRepoRegistry } from './arena/targets.ts';
import { GithubApp } from './github.ts';
import { Auth, canSee, viewerOf, type Caller, type Need } from './auth.ts';
import { AgentApi, describe, floorOf } from './agent.ts';
import { registerMcp } from './mcp.ts';
import { registerAccounts } from './accounts.ts';
import { Tenancy } from './tenancy.ts';
import { TicketDesk } from './tickets.ts';
import { Limits } from './limits.ts';
import { initSecrets } from './secrets.ts';

const root = resolve(import.meta.dirname, '../../..');
process.chdir(root);
loadEnv(resolve(root, '.env'));

const cfg = {
  ticketsDir: resolve(root, process.env.TICKETS_DIR ?? 'tickets'),
  suitesDir: resolve(root, process.env.SUITES_DIR ?? 'data/suites'),
  artifactsDir: resolve(root, process.env.ARTIFACTS_DIR ?? 'data/artifacts'),
  targetUrl: process.env.TARGET_URL ?? 'http://localhost:4100',
  baselineUrl: process.env.BASELINE_URL ?? process.env.TARGET_URL ?? 'http://localhost:4100',
  workers: Number(process.env.WORKERS ?? 2),
  jira: jiraConfigFromEnv(),
  publicUrl: process.env.PUBLIC_URL,
};
const dbFile = resolve(root, process.env.DB_FILE ?? 'data/sentinel.db');
initSecrets(process.env.SECRET_FILE ?? resolve(dbFile, '../secret.key'));
const store = new Store(dbFile);
const tenancy = new Tenancy(store.db);
const desk = new TicketDesk(tenancy, store, cfg.suitesDir);
const limits = new Limits(tenancy);
const auth = new Auth(store, tenancy);
const svc = new SentinelService(store, cfg);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

const allow = (req: FastifyRequest, reply: FastifyReply, need: Need) => auth.require(req, reply, need);

await app.register(fastifyWebsocket);
await app.register(fastifyStatic, { root: cfg.artifactsDir, prefix: '/artifacts/', decorateReply: false });
// The building: the lobby at /, one office floor per project at /office/, the console at /console/.
const building = resolve(root, 'apps/office/dist');
if (existsSync(building)) await app.register(fastifyStatic, { root: building, prefix: '/' });
const dashboard = resolve(root, 'apps/dashboard/dist');
if (existsSync(dashboard)) await app.register(fastifyStatic, { root: dashboard, prefix: '/console/', decorateReply: false });
app.get('/console', async (_req, reply) => reply.redirect('console/'));
app.get('/office', async (req, reply) => reply.redirect(`office/${req.url.slice('/office'.length)}`));

app.setErrorHandler((err: Error, _req, reply) => {
  const status = err instanceof StageError ? 409 : (err as { statusCode?: number }).statusCode ?? 400;
  reply.status(status).send({ error: err.message });
});

// The control room's own pipeline (the shared demo tickets): anyone watches, only the operator changes it.
const sockets = new Set<{ send(data: string): void }>();
svc.bus.on('event', (e) => {
  const msg = JSON.stringify(e);
  for (const s of sockets) s.send(msg);
});
app.get('/ws', { websocket: true }, (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

// Arena: the rival test-fixer and SentinelQA work the same ticket side by side, streamed live.
const arena = arenaFromEnv(root, cfg.suitesDir, cfg.targetUrl, store, {
  limits,
  suites: { dirFor: (owner) => desk.suitesFor(owner), ensure: (owner, ticket) => desk.ensureSuite(owner, ticket) },
});

/** What a viewer may know about the arena right now: the current run if it is theirs (or the demo), and how busy it is. */
function snapshotFor(c: Caller | null) {
  const snap = arena.snapshot();
  const waiting = snap?.queue.length ?? 0;
  if (!snap) return { episode: null, busy: false, waiting };
  const visible = canSee(c, snap.owner);
  return {
    episode: visible ? { ...snap, queue: snap.queue.filter((q) => canSee(c, arena.ownerOf(q.id))) } : null,
    busy: arena.busy,
    waiting,
  };
}

// Each viewer only receives what belongs to them or to the shared demo.
type Viewer = { send(data: string): void; bufferedAmount: number; on(ev: 'close', fn: () => void): void; caller: Caller | null };
const viewers = new Set<Viewer>();
arena.bus.on('msg', (msg: { t: string; episode?: number }) => {
  if (msg.t === 'episode') {
    for (const v of viewers) v.send(JSON.stringify({ t: 'episode', ...snapshotFor(v.caller) }));
    return;
  }
  const owner = arena.ownerOf(msg.episode!);
  const data = JSON.stringify(msg);
  for (const v of viewers) if (canSee(v.caller, owner)) v.send(data);
});
arena.bus.on('frame', (f: { episode: number }) => {
  const owner = arena.ownerOf(f.episode);
  const data = JSON.stringify({ t: 'frame', ...f });
  // A slow viewer skips frames instead of piling them up.
  for (const v of viewers) if (v.bufferedAmount < 512 * 1024 && canSee(v.caller, owner)) v.send(data);
});
app.get('/arena/ws', { websocket: true }, (socket, req) => {
  const v = socket as unknown as Viewer;
  v.caller = auth.caller(req);
  viewers.add(v);
  const snap = snapshotFor(v.caller);
  v.send(JSON.stringify({ t: 'hello', ...snap }));
  if (snap.episode) for (const [agent, data] of Object.entries(arena.latestFrames())) v.send(JSON.stringify({ t: 'frame', episode: snap.episode.id, agent, data }));
  v.on('close', () => viewers.delete(v));
});

app.get('/api/arena', async (req) => {
  const c = auth.caller(req);
  const llm = llmConfigFromEnv();
  const own = c?.user ? tenancy.tickets(c.user.id).map((t) => ({ key: t.key, title: t.title, stage: 'yours' })) : [];
  return {
    ...snapshotFor(c),
    desks: DESKS,
    scenarios: SCENARIOS,
    repos: arena.repos,
    github: github.configured,
    model: llm ? process.env.RIVAL_MODEL || llm.model : null,
    signedIn: Boolean(c && (c.user || c.operator)),
    needsToken: false,
    tickets: [...own, ...store.tickets().filter((t) => !own.some((o) => o.key === t.key)).map((t) => ({ key: t.key, title: t.title, stage: t.stage }))],
  };
});

app.post('/api/arena/episodes', async (req, reply) => {
  const c = allow(req, reply, 'run');
  if (!c) return;
  const r = EpisodeRequest.parse(req.body);
  const owner = c.user?.id ?? null;
  if (owner != null && !desk.find(owner, r.ticket)) return reply.status(400).send({ error: `${r.ticket} is not one of your tickets or a sample` });
  const ep = arena.start({ ...r, owner });
  return { id: ep.id, status: ep.status };
});

app.get<{ Querystring: { floor?: string; limit?: string } }>('/api/arena/episodes', async (req) => {
  const all = arena.history(200, viewerOf(auth.caller(req)));
  const mine = req.query.floor ? all.filter((e) => floorOf(e) === req.query.floor) : all;
  return mine.slice(0, Number(req.query.limit ?? 50));
});

app.get<{ Params: { id: string } }>('/api/arena/episodes/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const owner = arena.ownerOf(id);
  if (owner === undefined || !canSee(auth.caller(req), owner)) return reply.status(404).send({ error: 'no such episode' });
  return arena.replay(id);
});

const github = new GithubApp({
  arena,
  tenancy,
  desk,
  auth,
  file: resolve(root, process.env.GITHUB_APP_FILE ?? 'data/github-app.json'),
  publicUrl: cfg.publicUrl,
  operators: (process.env.OPERATOR_GITHUB_LOGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
});
github.register(app);

// Jira: each person connects their own site in the lobby and links their projects to their floors.
const jira = new JiraHub({ tenancy, desk, arena, github, auth, publicUrl: cfg.publicUrl });
jira.register(app);

registerAccounts(app, { auth, store, tenancy, desk, github, devLogin: process.env.DEV_LOGIN === '1' });

// ---------- agents: REST for the CLI, and MCP ----------
const defaultTicket = process.env.GITHUB_DEFAULT_TICKET ?? 'SHOP-42';
const agent = new AgentApi({ arena, github, jira, desk, repos: loadRepoRegistry(process.env.ARENA_REPOS_FILE), publicUrl: cfg.publicUrl, defaultTicket });
const selfUrl = () => cfg.publicUrl ?? `http://localhost:${port}/`;

/** Everything the lobby shows to this visitor: their floors, what is running, their connections, how agents connect. */
app.get('/api/building', async (req) => {
  const c = auth.caller(req);
  const live = arena.episode;
  const seen = live && arena.busy && canSee(c, live.owner);
  return {
    floors: await agent.floors(c),
    live: seen ? { id: live!.id, floor: floorOf(live!), label: live!.label, status: live!.status } : null,
    busy: arena.busy,
    github: { configured: github.configured, canSetup: Boolean(cfg.publicUrl), canSignIn: github.canSignIn, installUrl: github.installUrl },
    jira: { configured: Boolean(c?.user && tenancy.jira(c.user.id)), links: jira.links(c?.user?.id) },
    agents: { mcp: new URL('mcp', selfUrl()).toString(), cli: new URL('cli/sentinelqa.mjs', selfUrl()).toString(), guide: new URL('agents.md', selfUrl()).toString() },
  };
});

app.get('/api/agent/projects', async (req, reply) => {
  const c = allow(req, reply, 'read');
  return c ? agent.floors(c) : undefined;
});
app.post<{ Body: { project?: string; ref?: string; scenario?: string; ticket?: string } }>('/api/agent/checks', async (req, reply) => {
  const c = allow(req, reply, 'run');
  if (!c) return;
  return agent.run(c, { project: req.body?.project ?? 'demo', ref: req.body?.ref, scenario: req.body?.scenario, ticket: req.body?.ticket });
});
app.get<{ Params: { id: string }; Querystring: { wait?: string; format?: string } }>('/api/agent/checks/:id', async (req, reply) => {
  const c = allow(req, reply, 'read');
  if (!c) return;
  const r = await agent.wait(c, Number(req.params.id), Number(req.query.wait ?? 0));
  if (!r) return reply.status(404).send({ error: 'no such run' });
  return req.query.format === 'text' ? reply.type('text/plain').send(describe(r)) : r;
});
app.get<{ Params: { owner: string; repo: string; sha: string }; Querystring: { wait?: string } }>('/api/agent/commits/:owner/:repo/:sha', async (req, reply) => {
  const c = allow(req, reply, 'read');
  if (!c) return;
  const r = await agent.commit(c, `${req.params.owner}/${req.params.repo}`, req.params.sha, Number(req.query.wait ?? 0));
  return r ?? reply.status(404).send({ error: 'no run for that commit yet' });
});
app.get<{ Querystring: { project?: string; limit?: string } }>('/api/agent/runs', async (req, reply) => {
  const c = allow(req, reply, 'read');
  return c ? agent.runs(c, req.query.project, Number(req.query.limit ?? 20)) : undefined;
});

registerMcp(app, agent, auth, defaultTicket, desk);

/** The CLI is one dependency-free file; it comes pointed at this server. */
app.get('/cli/sentinelqa.mjs', async (_req, reply) => {
  const src = await readFile(resolve(root, 'apps/cli/sentinelqa.mjs'), 'utf8');
  return reply.type('text/javascript; charset=utf-8').send(src.replaceAll('__SENTINELQA_URL__', selfUrl()));
});
app.get('/agents.md', async (_req, reply) => {
  const src = await readFile(resolve(root, 'apps/cli/AGENTS.md'), 'utf8');
  return reply.type('text/markdown; charset=utf-8').send(src.replaceAll('__SENTINELQA_URL__', selfUrl()));
});

app.get('/api/health', async () => ({ ok: true, queued: svc.queued, target: cfg.targetUrl, jira: Boolean(cfg.jira) }));

// ---------- the control room's demo pipeline ----------

app.get('/api/tickets', async () => store.tickets());

app.post<{ Body: { key: string; title: string; description?: string; criteria?: string } }>('/api/tickets', async (req, reply) => {
  if (!allow(req, reply, 'operator')) return;
  const { key, title } = req.body;
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key ?? '')) throw new Error('key must look like SHOP-42');
  const text = req.body.criteria ?? req.body.description ?? '';
  const criteria = extractCriteria(text);
  if (!criteria.length) throw new Error('no acceptance criteria found; use lines like "AC-1: Given ..."');
  svc.receive({ key, title, status: 'Ready for QA', description: req.body.description ?? text, criteria, source: 'api' });
  return store.ticket(key);
});

/** A demo ticket, or (signed in) one of the visitor's own, with its compiled criteria. */
app.get<{ Params: { key: string } }>('/api/tickets/:key', async (req, reply) => {
  const c = auth.caller(req);
  if (c?.user) {
    const own = tenancy.ticket(c.user.id, req.params.key);
    if (own) return { ticket: { ...own, stage: 'yours' }, contract: await desk.suite(c.user.id, own.key).contract() };
  }
  const d = await svc.ticketDetail(req.params.key);
  return d ?? reply.status(404).send({ error: 'not found' });
});

app.post<{ Params: { key: string }; Body: { mode?: 'auto' | 'llm' | 'parser' } }>('/api/tickets/:key/compile', async (req, reply) => {
  if (!allow(req, reply, 'operator')) return;
  const out = await svc.compile(req.params.key, req.body?.mode ?? 'auto');
  return { source: out.source, model: out.model, cached: out.cached, warnings: out.warnings, contract: out.contract };
});

app.put<{ Params: { key: string }; Body: unknown }>('/api/tickets/:key/contract', async (req, reply) => {
  if (!allow(req, reply, 'operator')) return;
  const contract = Contract.parse({ ...(req.body as object), ticket: req.params.key, source: 'manual' });
  await svc.saveContract(req.params.key, contract);
  return contract;
});

app.post<{ Params: { key: string } }>('/api/tickets/:key/generate', async (req, reply) => (allow(req, reply, 'operator') ? svc.generate(req.params.key) : undefined));

app.post<{ Params: { key: string } }>('/api/tickets/:key/baseline', async (req, reply) => (allow(req, reply, 'operator') ? { runId: svc.baseline(req.params.key) } : undefined));

app.post<{ Params: { key: string }; Body: { mutations?: string[]; mode?: HealMode } }>('/api/tickets/:key/runs', async (req, reply) =>
  allow(req, reply, 'operator') ? { runId: svc.check(req.params.key, { mutations: req.body?.mutations, mode: req.body?.mode }) } : undefined,
);

app.post<{ Params: { key: string }; Body: { mutations?: string[] } }>('/api/tickets/:key/pipeline', async (req, reply) =>
  allow(req, reply, 'operator') ? svc.pipeline(req.params.key, { mutations: req.body?.mutations }) : undefined,
);

app.get<{ Querystring: { ticket?: string } }>('/api/runs', async (req) => store.runs(req.query.ticket));

app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
  const run = store.run(Number(req.params.id));
  if (!run) return reply.status(404).send({ error: 'not found' });
  return { run, results: store.results(run.id), heals: store.heals({ runId: run.id }) };
});

app.get<{ Querystring: { status?: 'pending' } }>('/api/heals', async (req) => store.heals({ status: req.query.status }));
app.post<{ Params: { id: string } }>('/api/heals/:id/approve', async (req, reply) => (allow(req, reply, 'operator') ? (await svc.reviewHeal(Number(req.params.id), true), { ok: true }) : undefined));
app.post<{ Params: { id: string } }>('/api/heals/:id/reject', async (req, reply) => (allow(req, reply, 'operator') ? (await svc.reviewHeal(Number(req.params.id), false), { ok: true }) : undefined));

app.get<{ Querystring: { ticket?: string } }>('/api/events', async (req) => store.events(req.query.ticket));

/** The rules behind every decision, so a reviewer can read them next to the ledger. */
app.get('/api/policies', async () => {
  const p = policies();
  return {
    heal: { ...p.heal.policy, sha256: p.heal.sha256 },
    verdict: { ...p.verdict.policy, sha256: p.verdict.sha256 },
    pipeline: { stages: STAGES, transitions: TRANSITIONS },
  };
});

/** Latest benchmark report written by npm run bench. */
app.get('/api/bench', async (_req, reply) => {
  try {
    return JSON.parse(await readFile(resolve(root, 'bench/results/latest.json'), 'utf8'));
  } catch {
    return reply.status(404).send({ error: 'no benchmark yet; run npm run bench' });
  }
});

app.get('/api/mutations', async () => {
  const res = await fetch(new URL('/api/mutations', cfg.targetUrl)).catch(() => null);
  return res?.ok ? (await res.json()).all : [];
});

const added = await svc.syncTicketFiles();
app.log.info(`${added} new tickets from ${cfg.ticketsDir}`);
await cleanupSandboxes();

const port = Number(process.env.SENTINEL_PORT ?? 4200);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await closeBrowser();
    process.exit(0);
  });
}
