import { cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compileTicket, extractCriteria, type Ticket } from '@sentinelqa/core';
import { Suite } from '@sentinelqa/engine';
import type { Store } from './db.ts';
import type { Tenancy } from './tenancy.ts';

/**
 * Tickets and their suites, per person. A user's tickets come from their Jira or are written in the
 * tower; their suites live apart from everyone else's. The shared demo tickets (SHOP-42 and friends)
 * are samples: the first time someone uses one, they get their own copy of its suite.
 */
export const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export class TicketDesk {
  constructor(
    private tenancy: Tenancy,
    private store: Store,
    private suitesDir: string,
  ) {}

  /** Where `owner`'s suites live; the shared demo's for null. */
  suitesFor(owner: number | null): string {
    return owner == null ? this.suitesDir : join(this.suitesDir, 'tenants', String(owner));
  }

  suite(owner: number | null, key: string): Suite {
    return Suite.at(this.suitesFor(owner), key);
  }

  isSample(key: string): boolean {
    return Boolean(this.store.ticket(key));
  }

  /** A ticket `owner` can run: one of theirs, or a sample. */
  find(owner: number | null, key: string): Ticket | null {
    if (owner != null) {
      const own = this.tenancy.ticket(owner, key);
      if (own) return own;
    }
    return this.store.ticket(key);
  }

  /** Makes sure `owner` has a suite for `key`, copying the sample's on first use. */
  async ensureSuite(owner: number | null, key: string) {
    if (owner == null) return;
    const mine = this.suite(owner, key);
    if (await mine.contract()) return;
    if (this.tenancy.ticket(owner, key)) return;
    const sample = join(this.suitesDir, key);
    if (existsSync(join(sample, 'contract.json'))) await cp(sample, join(this.suitesFor(owner), key), { recursive: true });
  }

  /**
   * Saves `owner`'s ticket and compiles it. When its criteria changed, the spec is regenerated and
   * the old baseline dropped: the next run records a new one on the build it checks.
   */
  async save(owner: number, t: Ticket): Promise<Ticket> {
    if (!TICKET_KEY.test(t.key)) throw new Error('ticket keys look like SHOP-42');
    if (!t.criteria.length) throw new Error(`${t.key} has no acceptance criteria (lines like "AC-1: Given ... when ... then ...")`);
    const before = this.tenancy.ticket(owner, t.key);
    this.tenancy.saveTicket(owner, t);
    const suite = this.suite(owner, t.key);
    const changed = JSON.stringify(before?.criteria ?? null) !== JSON.stringify(t.criteria);
    if (changed || !(await suite.contract())) {
      const out = await compileTicket(t, 'auto');
      await suite.saveContract(out.contract);
      await suite.generate();
      await rm(join(this.suitesFor(owner), t.key, 'baseline.json'), { force: true });
    }
    return t;
  }

  /** A ticket written in the tower instead of Jira. */
  async write(owner: number, input: { key: string; title: string; criteria: string }): Promise<Ticket> {
    const key = input.key.trim().toUpperCase();
    return this.save(owner, { key, title: input.title.trim() || key, status: 'Ready for QA', description: input.criteria, criteria: extractCriteria(input.criteria), source: 'api' });
  }

  async remove(owner: number, key: string): Promise<boolean> {
    const gone = this.tenancy.deleteTicket(owner, key);
    if (gone) await rm(join(this.suitesFor(owner), key), { recursive: true, force: true });
    return gone;
  }

  /** What a person can pick from: their tickets, then the samples. */
  async list(owner: number) {
    const mine = await Promise.all(
      this.tenancy.tickets(owner).map(async (t) => ({
        key: t.key,
        title: t.title,
        source: t.source,
        criteria: t.criteria.length,
        baselined: Boolean(await this.suite(owner, t.key).baseline()),
        sample: false,
      })),
    );
    const samples = this.store
      .tickets()
      .filter((t) => !mine.some((m) => m.key === t.key))
      .map((t) => ({ key: t.key, title: t.title, source: 'sample', criteria: t.criteria.length, baselined: false, sample: true }));
    return [...mine, ...samples];
  }
}
