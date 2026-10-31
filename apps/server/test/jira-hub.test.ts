import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { JiraHub } from '../src/jira-hub.ts';

const issue = {
  key: 'SHOP-5',
  fields: {
    summary: 'Cart',
    status: { name: 'Ready for QA' },
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AC-1: Given the shopper is on "/", when they click "Add", then the "badge" shows "1".' }] }] },
  },
};

test('Jira hub: secret, ready status, links, and tickets named by branches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jira-'));
  const file = join(dir, 'jira.json');
  writeFileSync(
    file,
    JSON.stringify({ baseUrl: 'https://team.atlassian.net', email: 'qa@example.com', token: 'jira-token-1', account: 'QA', webhookSecret: 's3cret', links: [{ project: 'SHOP', floor: 'o/r' }] }),
  );
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(issue), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const received: string[] = [];
  const svc = {
    cfg: { jira: null as unknown },
    receive: (t: { key: string }) => received.push(t.key),
    suite: () => ({ contract: async () => null }),
    compile: async () => calls.push('compile'),
    generate: async () => calls.push('generate'),
    onJiraStatus: async () => ({ started: true, legacy: true }),
  };
  const runs: unknown[] = [];
  const github: Record<string, unknown> = { connected: async () => [{ repo: 'o/r' }], runBranch: async (...a: unknown[]) => (runs.push(a), { id: 5 }) };
  const hub = new JiraHub({
    file,
    svc: svc as never,
    store: { ticket: () => null } as never,
    arena: { bus: new EventEmitter(), start: () => ({ id: 9 }) } as never,
    github: github as never,
    suitesDir: dir,
    publicUrl: 'https://x/sentinel/',
    allow: () => true,
  });
  const app = Fastify();
  hub.register(app);
  const hook = (secret: string, key: string, status: string) =>
    app.inject({ method: 'POST', url: `/webhooks/jira?secret=${secret}`, payload: { issue: { key, fields: { status: { name: status } } } } });
  try {
    assert.ok(svc.cfg.jira, 'the saved connection is applied to the pipeline service');
    assert.equal((await hook('wrong', 'SHOP-5', 'Ready for QA')).statusCode, 401);
    assert.deepEqual((await hook('s3cret', 'SHOP-5', 'In Progress')).json(), { started: false, reason: 'status is In Progress' });

    const started = (await hook('s3cret', 'SHOP-5', 'Ready for QA')).json();
    assert.deepEqual(started, { started: true, id: 5, floor: 'o/r' });
    assert.deepEqual(received, ['SHOP-5']);
    assert.ok(calls.includes('compile') && calls.includes('generate'));
    assert.deepEqual(runs[0], ['o/r', undefined, { ticket: 'SHOP-5', event: 'jira' }]);

    // Unlinked projects keep the original pipeline.
    assert.deepEqual((await hook('s3cret', 'OPS-1', 'Ready for QA')).json(), { started: true, legacy: true });

    // Pushes: a key in the branch (or message) of the linked repository picks that ticket.
    const ticketFor = github.ticketFor as (repo: string, ref: string, msg: string) => Promise<string | null>;
    assert.equal(await ticketFor('o/r', 'SHOP-5-cart-total', 'fix'), 'SHOP-5');
    assert.equal(await ticketFor('o/r', 'main', 'SHOP-5: fix total'), 'SHOP-5');
    assert.equal(await ticketFor('o/r', 'main', 'tidy up'), null);
    assert.equal(await ticketFor('other/repo', 'SHOP-5-x', ''), null, 'a ticket only runs on the floor its project is linked to');

    const bad = await app.inject({ method: 'PUT', url: '/api/jira/links', payload: { project: 'ops', floor: 'nobody/here' } });
    assert.equal(bad.statusCode, 400);
    const ok = await app.inject({ method: 'PUT', url: '/api/jira/links', payload: { project: 'ops', floor: 'demo' } });
    assert.deepEqual(ok.json().links.map((l: { project: string }) => l.project), ['OPS', 'SHOP']);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});
