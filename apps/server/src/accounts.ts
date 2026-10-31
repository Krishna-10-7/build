import type { FastifyInstance } from 'fastify';
import type { Auth, Scope } from './auth.ts';
import type { Store } from './db.ts';
import type { GithubApp } from './github.ts';
import { LIMITS } from './limits.ts';
import { seal } from './secrets.ts';
import type { Tenancy } from './tenancy.ts';
import type { TicketDesk } from './tickets.ts';

/** A person's own corner: who they are, their usage, LLM key, API tokens and tickets; and the operator's user list. */
export function registerAccounts(app: FastifyInstance, o: { auth: Auth; store: Store; tenancy: Tenancy; desk: TicketDesk; github: GithubApp; devLogin: boolean }) {
  const { auth, store, tenancy, desk } = o;

  app.get('/api/me', async (req) => {
    const c = auth.caller(req);
    const u = c?.user;
    return {
      user: u ? { id: u.id, login: u.login, name: u.name, avatar: u.avatar, role: u.role } : null,
      operator: Boolean(c?.operator),
      mode: c?.via ?? 'anonymous',
      signIn: o.github.canSignIn ? 'auth/github/login' : o.devLogin ? 'auth/dev' : null,
      installUrl: o.github.installUrl,
      usage: u ? tenancy.usage(u.id) : null,
      limits: LIMITS,
      ownLlmKey: Boolean(u?.llm_key),
    };
  });

  /** Their own LLM key: the Fixer then runs on it, with no daily cap. */
  app.put<{ Body: { key?: string | null } }>('/api/me/llm-key', async (req, reply) => {
    const c = auth.require(req, reply, 'user');
    if (!c) return;
    const key = req.body?.key?.trim() || null;
    if (key && !/^[\w-]{20,200}$/.test(key)) return reply.status(400).send({ error: 'that does not look like an API key' });
    tenancy.setLlmKey(c.user!.id, key ? seal(key) : null);
    return { ownLlmKey: Boolean(key) };
  });

  // ---------- API tokens: each person's own ----------

  app.get('/api/tokens', async (req, reply) => {
    const c = auth.require(req, reply, 'user');
    if (!c) return;
    return store.tokens(c.user!.id);
  });

  app.post<{ Body: { name?: string; scope?: string } }>('/api/tokens', async (req, reply) => {
    const c = auth.require(req, reply, 'user');
    if (!c) return;
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    const scope: Scope = req.body?.scope === 'read' ? 'read' : 'run';
    if (!name) return reply.status(400).send({ error: 'give the token a name, like "claude-code on my laptop"' });
    return { ...auth.mint(name, scope, c.user!.id), name, scope };
  });

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req, reply) => {
    const c = auth.require(req, reply, 'user');
    if (!c) return;
    const ok = store.revokeToken(Number(req.params.id), c.user!.id);
    return ok ? { ok: true } : reply.status(404).send({ error: 'no such token' });
  });

  // ---------- tickets written in the tower ----------

  app.get('/api/my/tickets', async (req, reply) => {
    const c = auth.require(req, reply, 'user');
    if (!c) return;
    return desk.list(c.user!.id);
  });

  app.post<{ Body: { key?: string; title?: string; criteria?: string } }>('/api/my/tickets', async (req, reply) => {
    const c = auth.require(req, reply, 'user');
    if (!c) return;
    const t = await desk.write(c.user!.id, { key: req.body?.key ?? '', title: req.body?.title ?? '', criteria: req.body?.criteria ?? '' });
    return { key: t.key, title: t.title, criteria: t.criteria.length };
  });

  app.delete<{ Params: { key: string } }>('/api/my/tickets/:key', async (req, reply) => {
    const c = auth.require(req, reply, 'user');
    if (!c) return;
    return (await desk.remove(c.user!.id, req.params.key)) ? { ok: true } : reply.status(404).send({ error: 'no such ticket' });
  });

  // ---------- the operator's view of everyone ----------

  app.get('/api/users', async (req, reply) => {
    if (!auth.require(req, reply, 'operator')) return;
    return tenancy.users().map(({ llm_key, ...u }) => ({ ...u, ownLlmKey: Boolean(llm_key) }));
  });

  app.post<{ Params: { id: string; action: string } }>('/api/users/:id/:action', async (req, reply) => {
    if (!auth.require(req, reply, 'operator')) return;
    if (req.params.action !== 'disable' && req.params.action !== 'enable') return reply.status(404).send({ error: 'unknown action' });
    tenancy.setDisabled(Number(req.params.id), req.params.action === 'disable');
    return { ok: true };
  });
}
