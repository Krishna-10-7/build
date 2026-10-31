import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { describe, type AgentApi, type CheckResult } from '../src/agent.ts';
import { registerMcp } from '../src/mcp.ts';

const req = (token?: string) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} }) as never;

test('tokens: operator, run and read scopes, revocation', () => {
  const store = new Store(':memory:');
  const auth = new Auth(store);
  const saved = process.env.ARENA_TOKEN;
  try {
    delete process.env.ARENA_TOKEN;
    assert.equal(auth.caller(req())?.kind, 'operator', 'no presenter token configured: local development is open');

    process.env.ARENA_TOKEN = 'operator-secret';
    assert.equal(auth.caller(req()), null);
    assert.equal(auth.caller(req('operator-secret'))?.kind, 'operator');
    assert.equal(auth.caller(req('sqa_made-up')), null);

    const run = auth.mint('ci', 'run');
    const read = auth.mint('viewer', 'read');
    assert.match(run.token, /^sqa_/);
    assert.ok(Auth.allows(auth.caller(req(run.token)), 'run'));
    assert.ok(Auth.allows(auth.caller(req(read.token)), 'read'));
    assert.ok(!Auth.allows(auth.caller(req(read.token)), 'run'));
    assert.ok(!Auth.allows(auth.caller(req(run.token)), 'operator'));

    // Only a hash is stored, and the listing shows a hint.
    const rows = store.tokens();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => !JSON.stringify(r).includes(run.token) && !JSON.stringify(r).includes(read.token)));

    assert.ok(store.revokeToken(run.id));
    assert.equal(auth.caller(req(run.token)), null);
  } finally {
    if (saved === undefined) delete process.env.ARENA_TOKEN;
    else process.env.ARENA_TOKEN = saved;
  }
});

const sample: CheckResult = {
  id: 9,
  status: 'finished',
  label: 'ShopLite + R5',
  conclusion: 'failure',
  title: 'Regression caught · AC-2',
  startedAt: 0,
  project: 'demo',
  ticket: 'SHOP-42',
  trigger: { kind: 'manual' },
  finishedAt: 1,
  error: null,
  summary: null,
  criteria: [
    { id: 'AC-1', verdict: 'HEALED', rule: 'V2', heals: [{ key: 'add', decision: 'accepted', rule: 'H1' }] },
    { id: 'AC-2', verdict: 'REGRESSION', rule: 'V5', heals: [] },
  ],
  fixer: [{ criterion: 'AC-2', green: true, rewroteAssertion: true }],
  watchUrl: 'https://x/office/?episode=9',
  done: true,
};

test('results read as instructions for an agent', () => {
  const text = describe(sample);
  assert.match(text, /^FAILURE: Regression caught · AC-2/);
  assert.match(text, /AC-1 +HEALED .*healed: add/);
  assert.match(text, /Fix the application code/);
  assert.match(text, /watch: https:\/\/x\/office\/\?episode=9/);
});

test('MCP: handshake, tool list, scopes and notifications', async () => {
  const store = new Store(':memory:');
  const auth = new Auth(store);
  const saved = process.env.ARENA_TOKEN;
  process.env.ARENA_TOKEN = 'operator-secret';
  const read = auth.mint('viewer', 'read').token;
  let ran = false;
  const agent = {
    floors: async () => [],
    run: async () => ((ran = true), sample),
    wait: async () => sample,
    commit: async () => null,
    runs: () => [],
  } as unknown as AgentApi;
  const app = Fastify();
  registerMcp(app, agent, auth, 'SHOP-42', '/nonexistent');
  const call = (body: unknown, token: string | null = read) =>
    app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: JSON.stringify(body) });
  try {
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)).statusCode, 401);

    const init = (await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json();
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'sentinelqa');

    assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode, 202);

    const tools = (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools;
    assert.deepEqual(tools.map((t: { name: string }) => t.name), ['list_projects', 'run_check', 'get_result', 'commit_status', 'get_acceptance_criteria', 'list_runs']);
    assert.deepEqual(tools.find((t: { name: string }) => t.name === 'run_check').inputSchema.required, ['project']);

    const denied = (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_check', arguments: { project: 'demo' } } })).json();
    assert.equal(denied.result.isError, true);
    assert.equal(ran, false);

    const got = (await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_result', arguments: { run_id: 9 } } })).json();
    assert.match(got.result.content[0].text, /Regression caught/);
    assert.equal(got.result.structuredContent.id, 9);

    const bad = (await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_result', arguments: {} } })).json();
    assert.equal(bad.error.code, -32602);
  } finally {
    await app.close();
    if (saved === undefined) delete process.env.ARENA_TOKEN;
    else process.env.ARENA_TOKEN = saved;
  }
});
