import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { Contract, extractCriteria, loadEnv, policies } from '@sentinelqa/core';
import { closeBrowser, type HealMode } from '@sentinelqa/engine';
import { Store } from './db.ts';
import { StageError, STAGES, TRANSITIONS } from './pipeline.ts';
import { SentinelService } from './service.ts';
import { jiraConfigFromEnv, readWebhook } from './jira.ts';

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
const dashboard = resolve(root, 'apps/dashboard/dist');
if (existsSync(dashboard)) await app.register(fastifyStatic, { root: dashboard, prefix: '/' });

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
