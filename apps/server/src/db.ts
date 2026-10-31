import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CriterionResult, HealRecord, Ticket, Verdict } from '@sentinelqa/core';
import type { Stage } from './pipeline.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'received',
  source TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket TEXT NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  mutations TEXT NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  criterion TEXT NOT NULL,
  verdict TEXT NOT NULL,
  rule TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS heals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  ticket TEXT NOT NULL,
  criterion TEXT NOT NULL,
  key TEXT NOT NULL,
  decision TEXT NOT NULL,
  status TEXT NOT NULL,
  rule TEXT NOT NULL,
  data TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  ticket TEXT,
  run_id INTEGER,
  type TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  label TEXT NOT NULL,
  trigger TEXT NOT NULL,
  data TEXT NOT NULL,
  frames TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
`;

export type RunStatus = 'queued' | 'running' | 'done' | 'failed';
/** accepted: written to locators.json. pending: waiting for review. refused: blocked by a gate. */
export type HealStatus = 'accepted' | 'pending' | 'approved' | 'rejected' | 'refused';

export interface RunRow {
  id: number;
  ticket: string;
  kind: 'baseline' | 'check';
  mode: string;
  mutations: string[];
  status: RunStatus;
  verdict: Verdict | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface HealRow {
  id: number;
  run_id: number;
  ticket: string;
  criterion: string;
  key: string;
  decision: string;
  status: HealStatus;
  rule: string;
  record: HealRecord;
  reviewed_at: string | null;
}

const now = () => new Date().toISOString();

export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Columns added when the tower became multi-user.
    this.addColumn('api_tokens', 'user_id', 'INTEGER');
    this.addColumn('episodes', 'owner_id', 'INTEGER');
  }

  private addColumn(table: string, column: string, type: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  upsertTicket(t: Ticket) {
    this.db
      .prepare(
        `INSERT INTO tickets (key, title, status, source, data, updated_at) VALUES (@key, @title, @status, @source, @data, @at)
         ON CONFLICT(key) DO UPDATE SET title = @title, status = @status, source = @source, data = @data, updated_at = @at`,
      )
      .run({ key: t.key, title: t.title, status: t.status, source: t.source, data: JSON.stringify(t), at: now() });
  }

  tickets(): (Ticket & { stage: Stage; updatedAt: string })[] {
    return (this.db.prepare('SELECT * FROM tickets ORDER BY updated_at DESC').all() as any[]).map((r) => ({ ...JSON.parse(r.data), stage: r.stage, updatedAt: r.updated_at }));
  }

  ticket(key: string): (Ticket & { stage: Stage }) | null {
    const r = this.db.prepare('SELECT * FROM tickets WHERE key = ?').get(key) as any;
    return r ? { ...JSON.parse(r.data), stage: r.stage } : null;
  }

  setStage(key: string, stage: Stage) {
    this.db.prepare('UPDATE tickets SET stage = ?, updated_at = ? WHERE key = ?').run(stage, now(), key);
  }

  createRun(ticket: string, kind: RunRow['kind'], mode: string, mutations: string[]): number {
    const r = this.db
      .prepare(`INSERT INTO runs (ticket, kind, mode, mutations, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)`)
      .run(ticket, kind, mode, JSON.stringify(mutations), now());
    return Number(r.lastInsertRowid);
  }

  updateRun(id: number, patch: Partial<Pick<RunRow, 'status' | 'verdict' | 'error'>>) {
    const finished = patch.status === 'done' || patch.status === 'failed' ? now() : null;
    this.db
      .prepare(`UPDATE runs SET status = COALESCE(@status, status), verdict = COALESCE(@verdict, verdict), error = COALESCE(@error, error), finished_at = COALESCE(@finished, finished_at) WHERE id = @id`)
      .run({ id, status: patch.status ?? null, verdict: patch.verdict ?? null, error: patch.error ?? null, finished });
  }

  private runRow(r: any): RunRow {
    return { ...r, mutations: JSON.parse(r.mutations) };
  }

  runs(ticket?: string, limit = 50): RunRow[] {
    const rows = ticket
      ? this.db.prepare('SELECT * FROM runs WHERE ticket = ? ORDER BY id DESC LIMIT ?').all(ticket, limit)
      : this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => this.runRow(r));
  }

  run(id: number): RunRow | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return r ? this.runRow(r) : null;
  }

  saveResults(runId: number, ticket: string, results: CriterionResult[], healStatus: (h: HealRecord) => HealStatus) {
    const insResult = this.db.prepare('INSERT INTO results (run_id, criterion, verdict, rule, data) VALUES (?, ?, ?, ?, ?)');
    const insHeal = this.db.prepare('INSERT INTO heals (run_id, ticket, criterion, key, decision, status, rule, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const r of results) {
        insResult.run(runId, r.criterion, r.verdict, r.rule, JSON.stringify(r));
        for (const h of r.heals) insHeal.run(runId, ticket, h.criterion, h.key, h.decision, healStatus(h), h.rule, JSON.stringify(h));
      }
    })();
  }

  results(runId: number): CriterionResult[] {
    return (this.db.prepare('SELECT data FROM results WHERE run_id = ? ORDER BY criterion').all(runId) as any[]).map((r) => JSON.parse(r.data));
  }

  private healRow(r: any): HealRow {
    const { data, ...rest } = r;
    return { ...rest, record: JSON.parse(data) };
  }

  heals(filter: { runId?: number; status?: HealStatus; ticket?: string } = {}): HealRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.runId !== undefined) (where.push('run_id = ?'), args.push(filter.runId));
    if (filter.status) (where.push('status = ?'), args.push(filter.status));
    if (filter.ticket) (where.push('ticket = ?'), args.push(filter.ticket));
    const sql = `SELECT * FROM heals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`;
    return this.db.prepare(sql).all(...args).map((r) => this.healRow(r));
  }

  heal(id: number): HealRow | null {
    const r = this.db.prepare('SELECT * FROM heals WHERE id = ?').get(id);
    return r ? this.healRow(r) : null;
  }

  reviewHeal(id: number, status: 'approved' | 'rejected') {
    this.db.prepare('UPDATE heals SET status = ?, reviewed_at = ? WHERE id = ?').run(status, now(), id);
  }

  addEvent(type: string, message: string, ticket?: string, runId?: number) {
    this.db.prepare('INSERT INTO events (at, ticket, run_id, type, message) VALUES (?, ?, ?, ?, ?)').run(now(), ticket ?? null, runId ?? null, type, message);
  }

  /** Arena episodes: the whole snapshot as JSON, plus the last frame of each desk for replays. */
  saveEpisode(ep: { id: number; status: string; label: string; trigger: unknown; startedAt: number; finishedAt: number | null; owner?: number | null; [k: string]: unknown }, frames: unknown) {
    this.db
      .prepare(
        `INSERT INTO episodes (id, status, label, trigger, data, frames, started_at, finished_at, owner_id) VALUES (@id, @status, @label, @trigger, @data, @frames, @startedAt, @finishedAt, @owner)
         ON CONFLICT(id) DO UPDATE SET status = @status, label = @label, trigger = @trigger, data = @data, frames = @frames, finished_at = @finishedAt, owner_id = @owner`,
      )
      .run({ id: ep.id, status: ep.status, label: ep.label, trigger: JSON.stringify(ep.trigger), data: JSON.stringify(ep), frames: JSON.stringify(frames), startedAt: ep.startedAt, finishedAt: ep.finishedAt, owner: ep.owner ?? null });
  }

  episode<T>(id: number): { episode: T; frames: Record<string, string> } | null {
    const r = this.db.prepare('SELECT data, frames FROM episodes WHERE id = ?').get(id) as any;
    return r ? { episode: JSON.parse(r.data), frames: JSON.parse(r.frames ?? '{}') } : null;
  }

  /** Newest first, without logs and frames; only one owner's (or the shared demo's, owner null) when given. */
  episodes<T>(limit = 50, owner?: number | null): T[] {
    const rows =
      owner === undefined
        ? this.db.prepare('SELECT data FROM episodes ORDER BY id DESC LIMIT ?').all(limit)
        : owner === null
          ? this.db.prepare('SELECT data FROM episodes WHERE owner_id IS NULL ORDER BY id DESC LIMIT ?').all(limit)
          : this.db.prepare('SELECT data FROM episodes WHERE owner_id = ? OR owner_id IS NULL ORDER BY id DESC LIMIT ?').all(owner, limit);
    return (rows as any[]).map((r) => {
      const { desks, ...rest } = JSON.parse(r.data);
      return { ...rest, desks: Object.fromEntries(Object.entries(desks as Record<string, { status: string; headline: string }>).map(([k, d]) => [k, { status: d.status, headline: d.headline }])) };
    });
  }

  lastEpisodeId(): number {
    return (this.db.prepare('SELECT MAX(id) AS id FROM episodes').get() as any).id ?? 0;
  }

  /** API tokens for agents and the CLI; only a SHA-256 of each token is kept. */
  /** user: the owner; null for tokens the operator made with the presenter token. */
  addToken(name: string, scope: string, hash: string, hint: string, user: number | null = null): number {
    return Number(this.db.prepare('INSERT INTO api_tokens (name, scope, hash, hint, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(name, scope, hash, hint, now(), user).lastInsertRowid);
  }

  tokenByHash(hash: string): { id: number; name: string; scope: string; user_id: number | null } | null {
    return (this.db.prepare('SELECT id, name, scope, user_id FROM api_tokens WHERE hash = ? AND revoked_at IS NULL').get(hash) as any) ?? null;
  }

  touchToken(id: number) {
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), id);
  }

  /** One user's tokens, or every token when user is undefined (the operator's view). */
  tokens(user?: number | null): { id: number; name: string; scope: string; hint: string; created_at: string; last_used_at: string | null; user_id: number | null }[] {
    const cols = 'SELECT id, name, scope, hint, created_at, last_used_at, user_id FROM api_tokens WHERE revoked_at IS NULL';
    if (user === undefined) return this.db.prepare(`${cols} ORDER BY id DESC`).all() as any[];
    if (user === null) return this.db.prepare(`${cols} AND user_id IS NULL ORDER BY id DESC`).all() as any[];
    return this.db.prepare(`${cols} AND user_id = ? ORDER BY id DESC`).all(user) as any[];
  }

  /** Revokes a token; with a user, only one of theirs. */
  revokeToken(id: number, user?: number): boolean {
    if (user !== undefined) return this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now(), id, user).changes > 0;
    return this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id).changes > 0;
  }

  events(ticket?: string, limit = 100) {
    return ticket
      ? this.db.prepare('SELECT * FROM events WHERE ticket = ? ORDER BY id DESC LIMIT ?').all(ticket, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
  }
}
