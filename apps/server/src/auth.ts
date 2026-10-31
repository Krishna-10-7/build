import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from './db.ts';
import type { Tenancy, User } from './tenancy.ts';

/**
 * Who is calling. Three ways in:
 *  - the presenter token (ARENA_TOKEN): the operator, for scripts and the first setup;
 *  - a session cookie from "Sign in with GitHub": a person, with an operator role if listed;
 *  - an API token (sqa_...) that a person made for their agents: their rights, narrowed to its scope.
 * Without ARENA_TOKEN (local development) an anonymous caller is the operator.
 */
export type Scope = 'read' | 'run';
export type Need = Scope | 'user' | 'operator';

export interface Caller {
  /** null for the presenter token, operator tokens and local mode. */
  user: User | null;
  operator: boolean;
  scope: Scope | 'all';
  via: 'presenter' | 'session' | 'token' | 'local';
}

export const SESSION_COOKIE = 'sqa_session';
const PREFIX = 'sqa_';
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function readCookie(req: { headers: { cookie?: string } }, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Whose data a caller sees: everything (operator), one person's, or only the shared demo. */
export function viewerOf(c: Caller | null): number | null | undefined {
  if (c?.operator) return undefined;
  return c?.user?.id ?? null;
}

/** May this caller see something that belongs to `owner` (null: the shared demo)? */
export function canSee(c: Caller | null, owner: number | null | undefined): boolean {
  if (owner == null) return true;
  return Boolean(c && (c.operator || c.user?.id === owner));
}

export class Auth {
  constructor(
    private store: Store,
    private tenancy: Tenancy,
  ) {}

  private presented(req: FastifyRequest | { headers: Record<string, unknown> }): string | null {
    const h = req.headers.authorization;
    if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
    const t = req.headers['x-arena-token'];
    return typeof t === 'string' && t ? t : null;
  }

  caller(req: FastifyRequest | { headers: Record<string, unknown> }): Caller | null {
    const operatorToken = process.env.ARENA_TOKEN;
    const t = this.presented(req);
    if (t) {
      if (operatorToken && same(t, operatorToken)) return { user: null, operator: true, scope: 'all', via: 'presenter' };
      if (t.startsWith(PREFIX)) {
        const row = this.store.tokenByHash(sha256(t));
        if (!row) return null;
        const user = row.user_id == null ? null : this.tenancy.user(row.user_id);
        if (row.user_id != null && (!user || user.disabled)) return null;
        this.store.touchToken(row.id);
        return { user, operator: user ? user.role === 'operator' : true, scope: row.scope as Scope, via: 'token' };
      }
      return null;
    }
    const sid = readCookie(req as { headers: { cookie?: string } }, SESSION_COOKIE);
    const user = sid ? this.tenancy.sessionUser(sha256(sid)) : null;
    if (user) return { user, operator: user.role === 'operator', scope: 'all', via: 'session' };
    if (!operatorToken) return { user: null, operator: true, scope: 'all', via: 'local' };
    return null;
  }

  static allows(c: Caller | null, need: Need): boolean {
    if (!c) return false;
    if (need === 'read') return true;
    if (need === 'run') return c.scope !== 'read';
    if (need === 'user') return Boolean(c.user) && c.scope === 'all';
    return c.operator && c.scope === 'all';
  }

  /** The caller when allowed; otherwise sends 401 or 403 and returns null. */
  require(req: FastifyRequest, reply: FastifyReply, need: Need): Caller | null {
    const c = this.caller(req);
    if (Auth.allows(c, need)) return c;
    if (!c) {
      void reply
        .status(401)
        .header('www-authenticate', 'Bearer realm="sentinelqa"')
        .send({ error: need === 'operator' ? 'only the operator can do this' : need === 'user' ? 'sign in with GitHub first' : 'sign in, or send an API token (Authorization: Bearer sqa_...)' });
    } else {
      const why = need === 'user' ? 'sign in with GitHub to manage your own settings' : need === 'operator' ? 'only the operator can do this' : `this token is ${c.scope}-only`;
      void reply.status(403).send({ error: why });
    }
    return null;
  }

  /** A token for `user` (null: an operator token). */
  mint(name: string, scope: Scope, user: number | null) {
    const token = PREFIX + randomBytes(24).toString('base64url');
    const id = this.store.addToken(name, scope, sha256(token), `${token.slice(0, 8)}…${token.slice(-4)}`, user);
    return { id, token };
  }

  newSession(user: number): string {
    const sid = randomBytes(32).toString('base64url');
    this.tenancy.addSession(sha256(sid), user, 14);
    return sid;
  }

  endSession(req: FastifyRequest) {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid) this.tenancy.dropSession(sha256(sid));
  }
}
