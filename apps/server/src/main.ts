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
import { jiraConfigFromEnv, readWebhook } from './jira.ts';
import { DESKS, EpisodeRequest, SCENARIOS, arenaFromEnv } from './arena/arena.ts';
import { GithubApp } from './github.ts';
import { Auth, type Scope } from './auth.ts';
import { AgentApi, describe, floorOf } from './agent.ts';
import { registerMcp } from './mcp.ts';
import { loadRepoRegistry } from './arena/targets.ts';

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
const store = new Store(resolve(root, process.env.DB_FILE ?? 'data/sentinel.db'));
const svc = new SentinelService(store, cfg);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

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
const arena = arenaFromEnv(root, cfg.suitesDir, cfg.targetUrl, store);
type Viewer = { send(data: string): void; bufferedAmount: number; on(ev: 'close', fn: () => void): void };
const viewers = new Set<Viewer>();
arena.bus.on('msg', (msg) => {
  const data = JSON.stringify(msg);
  for (const v of viewers) v.send(data);
});
arena.bus.on('frame', (f) => {
  const data = JSON.stringify({ t: 'frame', ...f });
  // A slow viewer skips frames instead of piling them up.
  for (const v of viewers) if (v.bufferedAmount < 512 * 1024) v.send(data);
});
app.get('/arena/ws', { websocket: true }, (socket) => {
  const v = socket as unknown as Viewer;
  viewers.add(v);
  v.send(JSON.stringify({ t: 'hello', episode: arena.snapshot() }));
  for (const [agent, data] of Object.entries(arena.latestFrames())) v.send(JSON.stringify({ t: 'frame', agent, data }));
  v.on('close', () => viewers.delete(v));
});

app.get('/api/arena', async () => {
  const llm = llmConfigFromEnv();
  return {
    episode: arena.snapshot(),
    desks: DESKS,
    scenarios: SCENARIOS,
    repos: arena.repos,
    github: github.configured,
    model: llm ? process.env.RIVAL_MODEL || llm.model : null,
    needsToken: Boolean(process.env.ARENA_TOKEN),
    tickets: store.tickets().map((t) => ({ key: t.key, title: t.title, stage: t.stage })),
  };
});

/** Anyone can watch; starting an episode (browsers, LLM calls, repo checkouts) needs the presenter token or a "run" API token. */
const auth = new Auth(store);
const allow = (req: FastifyRequest, reply: FastifyReply, scope: Scope | 'operator') => auth.require(req, reply, scope);

app.post('/api/arena/episodes', async (req, reply) => {
  if (!allow(req, reply, 'run')) return;
  const ep = arena.start(EpisodeRequest.parse(req.body));
  return { id: ep.id, status: ep.status };
});

app.get<{ Querystring: { floor?: string; limit?: string } }>('/api/arena/episodes', async (req) => {
  const all = arena.history(200);
  const mine = req.query.floor ? all.filter((e) => floorOf(e) === req.query.floor) : all;
  return mine.slice(0, Number(req.query.limit ?? 50));
});

app.get<{ Params: { id: string } }>('/api/arena/episodes/:id', async (req, reply) => arena.replay(Number(req.params.id)) ?? reply.status(404).send({ error: 'no such episode' }));

const github = new GithubApp({
  arena,
  file: resolve(root, process.env.GITHUB_APP_FILE ?? 'data/github-app.json'),
  publicUrl: cfg.publicUrl,
  defaultTicket: process.env.GITHUB_DEFAULT_TICKET ?? 'SHOP-42',
  allow,
});
github.register(app);

// ---------- agents: API tokens, REST for the CLI, and MCP ----------
const defaultTicket = process.env.GITHUB_DEFAULT_TICKET ?? 'SHOP-42';
const agent = new AgentApi({ arena, github, repos: loadRepoRegistry(process.env.ARENA_REPOS_FILE), publicUrl: cfg.publicUrl, defaultTicket });
const selfUrl = () => cfg.publicUrl ?? `http://localhost:${port}/`;

/** Everything the lobby shows: floors, what is running, GitHub, and how agents connect. */
app.get('/api/building', async () => {
  const live = arena.episode;
  return {
    floors: await agent.floors(),
    live: live && arena.busy ? { id: live.id, floor: floorOf(live), label: live.label, status: live.status } : null,
    github: { configured: github.configured, canSetup: Boolean(cfg.publicUrl) },
    agents: { mcp: new URL('mcp', selfUrl()).toString(), cli: new URL('cli/sentinelqa.mjs', selfUrl()).toString(), guide: new URL('agents.md', selfUrl()).toString() },
    needsToken: Boolean(process.env.ARENA_TOKEN),
  };
});

app.get('/api/tokens', async (req, reply) => (allow(req, reply, 'operator') ? store.tokens() : undefined));
app.post<{ Body: { name?: string; scope?: string } }>('/api/tokens', async (req, reply) => {
  if (!allow(req, reply, 'operator')) return;
  const name = String(req.body?.name ?? '').trim().slice(0, 60);
  const scope = req.body?.scope === 'read' ? 'read' : 'run';
  if (!name) return reply.status(400).send({ error: 'give the token a name, like "claude-code on my laptop"' });
  return { ...auth.mint(name, scope), name, scope };
});
app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req, reply) => {
  if (!allow(req, reply, 'operator')) return;
  return store.revokeToken(Number(req.params.id)) ? { ok: true } : reply.status(404).send({ error: 'no such token' });
});

app.get('/api/agent/projects', async (req, reply) => (allow(req, reply, 'read') ? agent.floors() : undefined));
app.post<{ Body: { project?: string; ref?: string; scenario?: string } }>('/api/agent/checks', async (req, reply) => {
  if (!allow(req, reply, 'run')) return;
  return agent.run({ project: req.body?.project ?? 'demo', ref: req.body?.ref, scenario: req.body?.scenario });
});
app.get<{ Params: { id: string }; Querystring: { wait?: string; format?: string } }>('/api/agent/checks/:id', async (req, reply) => {
  if (!allow(req, reply, 'read')) return;
  const r = await agent.wait(Number(req.params.id), Number(req.query.wait ?? 0));
  if (!r) return reply.status(404).send({ error: 'no such run' });
  return req.query.format === 'text' ? reply.type('text/plain').send(describe(r)) : r;
});
app.get<{ Params: { owner: string; repo: string; sha: string }; Querystring: { wait?: string } }>('/api/agent/commits/:owner/:repo/:sha', async (req, reply) => {
  if (!allow(req, reply, 'read')) return;
  const r = await agent.commit(`${req.params.owner}/${req.params.repo}`, req.params.sha, Number(req.query.wait ?? 0));
  return r ?? reply.status(404).send({ error: 'no run for that commit yet' });
});
app.get<{ Querystring: { project?: string; limit?: string } }>('/api/agent/runs', async (req, reply) => (allow(req, reply, 'read') ? agent.runs(req.query.project, Number(req.query.limit ?? 20)) : undefined));

registerMcp(app, agent, auth, defaultTicket, cfg.suitesDir);

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

app.get('/api/tickets', async () => store.tickets());

app.post<{ Body: { key: string; title: string; description?: string; criteria?: string } }>('/api/tickets', async (req) => {
  const { key, title } = req.body;
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key ?? '')) throw new Error('key must look like SHOP-42');
  const text = req.body.criteria ?? req.body.description ?? '';
  const criteria = extractCriteria(text);
  if (!criteria.length) throw new Error('no acceptance criteria found; use lines like "AC-1: Given ..."');
  svc.receive({ key, title, status: 'Ready for QA', description: req.body.description ?? text, criteria, source: 'api' });
  return store.ticket(key);
});

app.get<{ Params: { key: string } }>('/api/tickets/:key', async (req, reply) => {
  const d = await svc.ticketDetail(req.params.key);
  return d ?? reply.status(404).send({ error: 'not found' });
});

app.post<{ Params: { key: string }; Body: { mode?: 'auto' | 'llm' | 'parser' } }>('/api/tickets/:key/compile', async (req) => {
  const out = await svc.compile(req.params.key, req.body?.mode ?? 'auto');
  return { source: out.source, model: out.model, cached: out.cached, warnings: out.warnings, contract: out.contract };
});

app.put<{ Params: { key: string }; Body: unknown }>('/api/tickets/:key/contract', async (req) => {
  const contract = Contract.parse({ ...(req.body as object), ticket: req.params.key, source: 'manual' });
  await svc.saveContract(req.params.key, contract);
  return contract;
});

app.post<{ Params: { key: string } }>('/api/tickets/:key/generate', async (req) => svc.generate(req.params.key));

app.post<{ Params: { key: string } }>('/api/tickets/:key/baseline', async (req) => ({ runId: svc.baseline(req.params.key) }));

app.post<{ Params: { key: string }; Body: { mutations?: string[]; mode?: HealMode } }>('/api/tickets/:key/runs', async (req) => ({
  runId: svc.check(req.params.key, { mutations: req.body?.mutations, mode: req.body?.mode }),
}));

app.post<{ Params: { key: string }; Body: { mutations?: string[] } }>('/api/tickets/:key/pipeline', async (req) => svc.pipeline(req.params.key, { mutations: req.body?.mutations }));

app.get<{ Querystring: { ticket?: string } }>('/api/runs', async (req) => store.runs(req.query.ticket));

app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
  const run = store.run(Number(req.params.id));
  if (!run) return reply.status(404).send({ error: 'not found' });
  return { run, results: store.results(run.id), heals: store.heals({ runId: run.id }) };
});

app.get<{ Querystring: { status?: 'pending' } }>('/api/heals', async (req) => store.heals({ status: req.query.status }));
app.post<{ Params: { id: string } }>('/api/heals/:id/approve', async (req) => (await svc.reviewHeal(Number(req.params.id), true), { ok: true }));
app.post<{ Params: { id: string } }>('/api/heals/:id/reject', async (req) => (await svc.reviewHeal(Number(req.params.id), false), { ok: true }));

app.post<{ Params: { key: string } }>('/api/jira/import/:key', async (req) => svc.importFromJira(req.params.key));

/** Jira automation or a system webhook on "issue updated". Protected by a shared secret in the URL. */
app.post<{ Querystring: { secret?: string } }>('/webhooks/jira', async (req, reply) => {
  const secret = process.env.JIRA_WEBHOOK_SECRET;
  if (!secret || req.query.secret !== secret) return reply.status(401).send({ error: 'bad or missing secret' });
  const hook = readWebhook(req.body);
  if (!hook) return reply.status(400).send({ error: 'not an issue event' });
  return svc.onJiraStatus(hook.key, hook.status);
});

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

const port = Number(process.env.SENTINEL_PORT ?? 4200);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await closeBrowser();
    process.exit(0);
  });
}
