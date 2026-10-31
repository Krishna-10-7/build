import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from './db.ts';

/**
 * Who may do what. The presenter token (ARENA_TOKEN) is the operator: it mints API tokens and
 * connects GitHub. API tokens are for agents and the CLI, like a kaggle.json: "read" sees projects
 * and results, "run" may also queue checks. Without ARENA_TOKEN (local development) all is open.
 */
export type Scope = 'read' | 'run';
export type Caller = { kind: 'operator' } | { kind: 'token'; id: number; name: string; scope: Scope };

const PREFIX = 'sqa_';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Auth {
  constructor(private store: Store) {}

  private presented(req: FastifyRequest): string | null {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) return h.slice(7).trim();
    const t = req.headers['x-arena-token'];
    return typeof t === 'string' && t ? t : null;
  }

  caller(req: FastifyRequest): Caller | null {
    const operator = process.env.ARENA_TOKEN;
    if (!operator) return { kind: 'operator' };
    const t = this.presented(req);
    if (!t) return null;
    if (same(t, operator)) return { kind: 'operator' };
    if (!t.startsWith(PREFIX)) return null;
    const row = this.store.tokenByHash(sha256(t));
    if (!row) return null;
    this.store.touchToken(row.id);
    return { kind: 'token', id: row.id, name: row.name, scope: row.scope as Scope };
  }

  static allows(c: Caller | null, scope: Scope | 'operator'): boolean {
    if (!c) return false;
    if (c.kind === 'operator') return true;
    return scope === 'read' || (scope === 'run' && c.scope === 'run');
  }

  /** Sends 401 or 403 and returns false when the caller may not. */
  require(req: FastifyRequest, reply: FastifyReply, scope: Scope | 'operator'): boolean {
    const c = this.caller(req);
    if (Auth.allows(c, scope)) return true;
    if (!c) void reply.status(401).header('www-authenticate', 'Bearer realm="sentinelqa"').send({ error: scope === 'operator' ? 'presenter token required' : 'API token required (Authorization: Bearer sqa_...)' });
    else void reply.status(403).send({ error: scope === 'operator' ? 'only the presenter token can do this' : `this token is ${(c as { scope: Scope }).scope}-only` });
    return false;
  }

  mint(name: string, scope: Scope) {
    const token = PREFIX + randomBytes(24).toString('base64url');
    const id = this.store.addToken(name, scope, sha256(token), `${token.slice(0, 8)}…${token.slice(-4)}`);
    return { id, token };
  }
}
