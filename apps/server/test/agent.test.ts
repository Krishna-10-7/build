import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Auth, SESSION_COOKIE, canSee } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { Tenancy } from '../src/tenancy.ts';
import { describe, type AgentApi, type CheckResult } from '../src/agent.ts';
import { registerMcp } from '../src/mcp.ts';

const req = (token?: string, cookie?: string) => ({ headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) } }) as never;

function world() {
  const store = new Store(':memory:');
  const tenancy = new Tenancy(store.db);
  return { store, tenancy, auth: new Auth(store, tenancy) };
}

function withOperatorToken<T>(fn: () => T): T {
  const saved = process.env.ARENA_TOKEN;
  process.env.ARENA_TOKEN = 'operator-secret';
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.ARENA_TOKEN;
    else process.env.ARENA_TOKEN = saved;
  }
}

test('callers: local mode, presenter token, sessions, tokens and their scopes', () => {
  const { store, tenancy, auth } = world();
  const saved = process.env.ARENA_TOKEN;
  delete process.env.ARENA_TOKEN;
  assert.equal(auth.caller(req())?.operator, true, 'without a presenter token, local development is open');
  if (saved !== undefined) process.env.ARENA_TOKEN = saved;

  withOperatorToken(() => {
    assert.equal(auth.caller(req()), null);
    assert.equal(auth.caller(req('operator-secret'))?.via, 'presenter');
    assert.equal(auth.caller(req('sqa_made-up')), null);

    const alice = tenancy.upsertUser({ github_id: 1, login: 'alice', name: null, avatar: null }, false);
    const sid = auth.newSession(alice.id);
    const viaSession = auth.caller(req(undefined, `${SESSION_COOKIE}=${sid}`));
    assert.equal(viaSession?.user?.login, 'alice');
    assert.equal(viaSession?.operator, false);
    assert.ok(Auth.allows(viaSession, 'user') && !Auth.allows(viaSession, 'operator'));

    const run = auth.mint('ci', 'run', alice.id);
    const read = auth.mint('viewer', 'read', alice.id);
    assert.match(run.token, /^sqa_/);
    assert.equal(auth.caller(req(run.token))?.user?.id, alice.id);
    assert.ok(Auth.allows(auth.caller(req(run.token)), 'run'));
    assert.ok(!Auth.allows(auth.caller(req(read.token)), 'run'));
    assert.ok(!Auth.allows(auth.caller(req(run.token)), 'user'), 'tokens cannot manage the account');

    // Only hashes are stored, and people only see and revoke their own.
    const bob = tenancy.upsertUser({ github_id: 2, login: 'bob', name: null, avatar: null }, false);
    assert.equal(store.tokens(alice.id).length, 2);
    assert.equal(store.tokens(bob.id).length, 0);
    assert.ok(store.tokens().every((r) => !JSON.stringify(r).includes(run.token)));
    assert.equal(store.revokeToken(run.id, bob.id), false);
    assert.ok(store.revokeToken(run.id, alice.id));
    assert.equal(auth.caller(req(run.token)), null);

    // A blocked person is signed out everywhere.
    tenancy.setDisabled(alice.id, true);
    assert.equal(auth.caller(req(read.token)), null);
    assert.equal(auth.caller(req(undefined, `${SESSION_COOKIE}=${sid}`)), null);
  });
});

test('visibility: the demo is shared, everything else is its owner’s', () => {
  const alice = { user: { id: 1 }, operator: false, scope: 'all', via: 'session' } as never;
  const operator = { user: null, operator: true, scope: 'all', via: 'presenter' } as never;
  assert.ok(canSee(null, null));
  assert.ok(canSee(alice, 1));
  assert.ok(!canSee(alice, 2));
  assert.ok(!canSee(null, 1));
  assert.ok(canSee(operator, 2));
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
  const { tenancy, auth } = world();
  const saved = process.env.ARENA_TOKEN;
  process.env.ARENA_TOKEN = 'operator-secret';
  const alice = tenancy.upsertUser({ github_id: 1, login: 'alice', name: null, avatar: null }, false);
  const read = auth.mint('viewer', 'read', alice.id).token;
  let ran = false;
  let askedAs: unknown = null;
  const agent = {
    floors: async () => [],
    run: async () => ((ran = true), sample),
    wait: async (c: { user: { login: string } }) => ((askedAs = c.user.login), sample),
    commit: async () => null,
    runs: () => [],
  } as unknown as AgentApi;
  const app = Fastify();
  registerMcp(app, agent, auth, 'SHOP-42', {} as never);
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
    assert.equal(askedAs, 'alice', 'tools act as the token’s owner');

    const bad = (await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_result', arguments: {} } })).json();
    assert.equal(bad.error.code, -32602);
  } finally {
    await app.close();
    if (saved === undefined) delete process.env.ARENA_TOKEN;
    else process.env.ARENA_TOKEN = saved;
  }
});
