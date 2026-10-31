import type Database from 'better-sqlite3';
import type { Ticket } from '@sentinelqa/core';

/**
 * Everything that belongs to one person: their account, sessions, repositories (floors), tickets,
 * Jira connection and daily usage. A user is a tenant; the ShopLite demo belongs to no one and is
 * shared by everybody.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  avatar TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  disabled INTEGER NOT NULL DEFAULT 0,
  llm_key TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
  repo TEXT PRIMARY KEY COLLATE NOCASE,
  owner_id INTEGER NOT NULL,
  installation INTEGER NOT NULL,
  default_branch TEXT NOT NULL,
  private INTEGER NOT NULL,
  url TEXT NOT NULL,
  default_ticket TEXT,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_tickets (
  owner_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);
CREATE TABLE IF NOT EXISTS jira_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  email TEXT NOT NULL,
  token TEXT NOT NULL,
  account TEXT NOT NULL,
  ready_status TEXT NOT NULL,
  criteria_field TEXT,
  webhook_secret TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS usage (
  owner_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  llm_runs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, day)
);
`;

export interface User {
  id: number;
  github_id: number;
  login: string;
  name: string | null;
  avatar: string | null;
  role: 'user' | 'operator';
  disabled: number;
  llm_key: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface RepoRow {
  repo: string;
  owner_id: number;
  installation: number;
  default_branch: string;
  private: number;
  url: string;
  default_ticket: string | null;
  added_at: string;
}

export interface JiraLink {
  project: string;
  floor: string;
}

export interface JiraRow {
  id: number;
  owner_id: number;
  base_url: string;
  email: string;
  /** Sealed. */
  token: string;
  account: string;
  ready_status: string;
  criteria_field: string | null;
  webhook_secret: string;
  links: JiraLink[];
}

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

export class Tenancy {
  constructor(private db: Database.Database) {
    db.exec(SCHEMA);
  }

  // ---------- users and sessions ----------

  upsertUser(u: { github_id: number; login: string; name: string | null; avatar: string | null }, operator: boolean): User {
    this.db
      .prepare(
        `INSERT INTO users (github_id, login, name, avatar, role, created_at, last_seen_at) VALUES (@github_id, @login, @name, @avatar, @role, @at, @at)
         ON CONFLICT(github_id) DO UPDATE SET login = @login, name = @name, avatar = @avatar, last_seen_at = @at, role = CASE WHEN @role = 'operator' THEN 'operator' ELSE role END`,
      )
      .run({ ...u, role: operator ? 'operator' : 'user', at: now() });
    return this.userByGithub(u.github_id)!;
  }

  user(id: number): User | null {
    return (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User) ?? null;
  }

  userByGithub(githubId: number): User | null {
    return (this.db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as User) ?? null;
  }

  users(): (User & { repos: number; runs_today: number })[] {
    return this.db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM repos r WHERE r.owner_id = u.id) AS repos,
                COALESCE((SELECT runs FROM usage g WHERE g.owner_id = u.id AND g.day = ?), 0) AS runs_today
         FROM users u ORDER BY u.id`,
      )
      .all(today()) as any[];
  }

  setDisabled(id: number, disabled: boolean) {
    this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
    if (disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }

  setLlmKey(id: number, sealed: string | null) {
    this.db.prepare('UPDATE users SET llm_key = ? WHERE id = ?').run(sealed, id);
  }

  addSession(hash: string, user: number, days: number) {
    const t = Date.now();
    this.db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hash, user, t, t + days * 86_400_000);
  }

  sessionUser(hash: string): User | null {
    const row = this.db.prepare('SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?').get(hash, Date.now()) as { user_id: number } | undefined;
    const u = row ? this.user(row.user_id) : null;
    return u && !u.disabled ? u : null;
  }

  dropSession(hash: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(hash);
  }

  // ---------- repositories: one owner each ----------

  /** Gives a repository to a user unless someone else already has it. Returns the owner. */
  claimRepo(r: { repo: string; installation: number; defaultBranch: string; private: boolean; url: string }, owner: number): number {
    this.db
      .prepare(
        `INSERT INTO repos (repo, owner_id, installation, default_branch, private, url, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET installation = excluded.installation, default_branch = excluded.default_branch, private = excluded.private, url = excluded.url
         WHERE repos.owner_id = excluded.owner_id`,
      )
      .run(r.repo, owner, r.installation, r.defaultBranch, r.private ? 1 : 0, r.url, now());
    return this.repo(r.repo)!.owner_id;
  }

  repo(name: string): RepoRow | null {
    return (this.db.prepare('SELECT * FROM repos WHERE repo = ?').get(name) as RepoRow) ?? null;
  }

  reposOf(owner: number): RepoRow[] {
    return this.db.prepare('SELECT * FROM repos WHERE owner_id = ? ORDER BY repo').all(owner) as RepoRow[];
  }

  allRepos(): RepoRow[] {
    return this.db.prepare('SELECT * FROM repos ORDER BY repo').all() as RepoRow[];
  }

  dropRepos(installation: number, names?: string[]) {
    if (!names) this.db.prepare('DELETE FROM repos WHERE installation = ?').run(installation);
    else for (const n of names) this.db.prepare('DELETE FROM repos WHERE installation = ? AND repo = ?').run(installation, n);
  }

  setDefaultTicket(repo: string, owner: number, ticket: string | null): boolean {
    return this.db.prepare('UPDATE repos SET default_ticket = ? WHERE repo = ? AND owner_id = ?').run(ticket, repo, owner).changes > 0;
  }

  // ---------- tickets ----------

  saveTicket(owner: number, t: Ticket) {
    this.db
      .prepare('INSERT INTO tenant_tickets (owner_id, key, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(owner, t.key, JSON.stringify(t), now());
  }

  ticket(owner: number, key: string): Ticket | null {
    const r = this.db.prepare('SELECT data FROM tenant_tickets WHERE owner_id = ? AND key = ?').get(owner, key) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  }

  tickets(owner: number): (Ticket & { updatedAt: string })[] {
    return (this.db.prepare('SELECT data, updated_at FROM tenant_tickets WHERE owner_id = ? ORDER BY updated_at DESC').all(owner) as any[]).map((r) => ({ ...JSON.parse(r.data), updatedAt: r.updated_at }));
  }

  deleteTicket(owner: number, key: string): boolean {
    return this.db.prepare('DELETE FROM tenant_tickets WHERE owner_id = ? AND key = ?').run(owner, key).changes > 0;
  }

  // ---------- Jira ----------

  private jiraRow(r: any): JiraRow | null {
    return r ? { ...r, links: JSON.parse(r.links) } : null;
  }

  jira(owner: number): JiraRow | null {
    return this.jiraRow(this.db.prepare('SELECT * FROM jira_connections WHERE owner_id = ?').get(owner));
  }

  jiraById(id: number): JiraRow | null {
    return this.jiraRow(this.db.prepare('SELECT * FROM jira_connections WHERE id = ?').get(id));
  }

  saveJira(j: Omit<JiraRow, 'id'>) {
    this.db
      .prepare(
        `INSERT INTO jira_connections (owner_id, base_url, email, token, account, ready_status, criteria_field, webhook_secret, links)
         VALUES (@owner_id, @base_url, @email, @token, @account, @ready_status, @criteria_field, @webhook_secret, @links)
         ON CONFLICT(owner_id) DO UPDATE SET base_url = @base_url, email = @email, token = @token, account = @account, ready_status = @ready_status,
           criteria_field = @criteria_field, webhook_secret = @webhook_secret, links = @links`,
      )
      .run({ ...j, links: JSON.stringify(j.links) });
  }

  dropJira(owner: number) {
    this.db.prepare('DELETE FROM jira_connections WHERE owner_id = ?').run(owner);
  }

  // ---------- usage ----------

  usage(owner: number): { runs: number; llm_runs: number } {
    return (this.db.prepare('SELECT runs, llm_runs FROM usage WHERE owner_id = ? AND day = ?').get(owner, today()) as any) ?? { runs: 0, llm_runs: 0 };
  }

  /** One more run, or one more Fixer run on the shared LLM key. */
  count(owner: number, what: 'run' | 'llm') {
    const [runs, llm] = what === 'run' ? [1, 0] : [0, 1];
    this.db
      .prepare('INSERT INTO usage (owner_id, day, runs, llm_runs) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, day) DO UPDATE SET runs = runs + excluded.runs, llm_runs = llm_runs + excluded.llm_runs')
      .run(owner, today(), runs, llm);
  }
}
