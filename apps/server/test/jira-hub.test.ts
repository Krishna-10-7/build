import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { JiraHub } from '../src/jira-hub.ts';
import { Auth, SESSION_COOKIE } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { initSecrets, seal } from '../src/secrets.ts';
import { Tenancy } from '../src/tenancy.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const issue = {
  key: 'SHOP-5',
  fields: {
    summary: 'Cart',
    status: { name: 'Ready for QA' },
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AC-1: Given the shopper is on "/", when they click "Add", then the "badge" shows "1".' }] }] },
  },
};

test('Jira hub: each person’s own connection, secret, links and branch-named tickets', async () => {
  initSecrets(join(mkdtempSync(join(tmpdir(), 'jira-')), 'secret.key'));
  const store = new Store(':memory:');
  const tenancy = new Tenancy(store.db);
  const auth = new Auth(store, tenancy);
  const alice = tenancy.upsertUser({ github_id: 1, login: 'alice', name: null, avatar: null }, false);
  const bob = tenancy.upsertUser({ github_id: 2, login: 'bob', name: null, avatar: null }, false);
  tenancy.claimRepo({ repo: 'alice/shop', installation: 7, defaultBranch: 'main', private: false, url: 'https://github.com/alice/shop' }, alice.id);
  tenancy.claimRepo({ repo: 'bob/site', installation: 8, defaultBranch: 'main', private: false, url: 'https://github.com/bob/site' }, bob.id);
  tenancy.saveJira({ owner_id: alice.id, base_url: 'https://team.atlassian.net', email: 'a@example.com', token: seal('jira-token-1'), account: 'Alice', ready_status: 'Ready for QA', criteria_field: null, webhook_secret: 's3cret', links: [{ project: 'SHOP', floor: 'alice/shop' }] });
  const conn = tenancy.jira(alice.id)!;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(issue), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const saved: string[] = [];
  const desk = { save: async (owner: number, t: { key: string }) => (saved.push(`${owner}:${t.key}`), t) };
  const runs: unknown[] = [];
  const github: Record<string, unknown> = { runBranch: async (...a: unknown[]) => (runs.push(a), { id: 5 }) };
  const hub = new JiraHub({ tenancy, desk: desk as never, arena: { bus: new EventEmitter(), start: () => ({ id: 9 }) } as never, github: github as never, auth, publicUrl: 'https://x/sentinel/' });
  const app = Fastify();
  hub.register(app);
  const hook = (id: number, secret: string, key: string, status: string) =>
    app.inject({ method: 'POST', url: `/webhooks/jira/${id}?secret=${secret}`, payload: { issue: { key, fields: { status: { name: status } } } } });
  const saved_ = process.env.ARENA_TOKEN;
  process.env.ARENA_TOKEN = 'operator-secret';
  try {
    assert.equal((await hook(conn.id, 'wrong', 'SHOP-5', 'Ready for QA')).statusCode, 401);
    assert.equal((await hook(conn.id + 1, 's3cret', 'SHOP-5', 'Ready for QA')).statusCode, 401, 'another connection’s address');
    assert.deepEqual((await hook(conn.id, 's3cret', 'SHOP-5', 'In Progress')).json(), { started: false, reason: 'status is In Progress' });

    assert.deepEqual((await hook(conn.id, 's3cret', 'SHOP-5', 'Ready for QA')).json(), { started: true, id: 5, floor: 'alice/shop' });
    assert.deepEqual(saved, [`${alice.id}:SHOP-5`], 'the ticket lands in Alice’s desk');
    assert.deepEqual(runs[0], ['alice/shop', undefined, { ticket: 'SHOP-5', event: 'jira', notifyJira: true }]);

    // Pushes: a key in the branch or message picks the ticket, only on the floor its project is linked to.
    const ticketFor = github.ticketFor as (owner: number, repo: string, ref: string, msg: string) => Promise<{ key: string } | null>;
    assert.equal((await ticketFor(alice.id, 'alice/shop', 'SHOP-5-cart', 'fix'))?.key, 'SHOP-5');
    assert.equal((await ticketFor(alice.id, 'alice/shop', 'main', 'SHOP-5: fix total'))?.key, 'SHOP-5');
    assert.equal(await ticketFor(alice.id, 'alice/shop', 'main', 'tidy up'), null);
    assert.equal(await ticketFor(bob.id, 'bob/site', 'SHOP-5-x', ''), null, 'Bob has no SHOP link');

    // Links only to your own floors; settings need a signed-in person.
    const sid = auth.newSession(alice.id);
    const asAlice = { cookie: `${SESSION_COOKIE}=${sid}` };
    assert.equal((await app.inject({ method: 'PUT', url: '/api/jira/links', headers: asAlice, payload: { project: 'ops', floor: 'bob/site' } })).statusCode, 400);
    const ok = await app.inject({ method: 'PUT', url: '/api/jira/links', headers: asAlice, payload: { project: 'ops', floor: 'demo' } });
    assert.deepEqual(ok.json().links.map((l: { project: string }) => l.project), ['OPS', 'SHOP']);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/jira/links', payload: { project: 'ops', floor: 'demo' } })).statusCode, 401);
    const bobView = await app.inject({ method: 'GET', url: '/api/jira', headers: { cookie: `${SESSION_COOKIE}=${auth.newSession(bob.id)}` } });
    assert.equal(bobView.json().configured, false, 'Bob does not see Alice’s Jira');
  } finally {
    globalThis.fetch = realFetch;
    if (saved_ === undefined) delete process.env.ARENA_TOKEN;
    else process.env.ARENA_TOKEN = saved_;
    await app.close();
  }
});
