import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Arena } from '../src/arena/arena.ts';
import { isPrivateAddress } from '../src/arena/guard.ts';
import { Store } from '../src/db.ts';
import { LIMITS, Limits } from '../src/limits.ts';
import { initSecrets, seal, unseal } from '../src/secrets.ts';
import { Tenancy } from '../src/tenancy.ts';

function people() {
  const store = new Store(':memory:');
  const tenancy = new Tenancy(store.db);
  const alice = tenancy.upsertUser({ github_id: 1, login: 'alice', name: null, avatar: null }, false);
  const bob = tenancy.upsertUser({ github_id: 2, login: 'bob', name: null, avatar: null }, false);
  return { store, tenancy, alice, bob };
}

test('a repository belongs to whoever connected it first', () => {
  const { tenancy, alice, bob } = people();
  const r = { repo: 'acme/shop', installation: 5, defaultBranch: 'main', private: true, url: 'https://github.com/acme/shop' };
  assert.equal(tenancy.claimRepo(r, alice.id), alice.id);
  assert.equal(tenancy.claimRepo({ ...r, defaultBranch: 'trunk' }, bob.id), alice.id, 'Bob cannot take it');
  assert.equal(tenancy.repo('ACME/shop')?.default_branch, 'main', 'names match without case');
  assert.deepEqual(tenancy.reposOf(bob.id), []);
  assert.equal(tenancy.setDefaultTicket('acme/shop', bob.id, 'SHOP-1'), false);
  assert.ok(tenancy.setDefaultTicket('acme/shop', alice.id, 'SHOP-1'));
  tenancy.dropRepos(5);
  assert.equal(tenancy.repo('acme/shop'), null);
});

test('daily limits, queue limits, and the shared LLM key', () => {
  const { tenancy, alice } = people();
  const limits = new Limits(tenancy);
  limits.admit(alice.id, 0);
  assert.throws(() => limits.admit(alice.id, LIMITS.queuedPerUser), /waiting/);
  for (let i = 0; i < LIMITS.runsPerDay; i++) limits.counted(alice.id);
  assert.throws(() => limits.admit(alice.id, 0), /daily limit/);
  limits.admit(null, 99);

  const saved = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = 'shared-key-for-tests-0000';
  initSecrets(join(mkdtempSync(join(tmpdir(), 'lim-')), 'secret.key'));
  try {
    assert.equal(limits.llmFor(alice.id).shared, true);
    for (let i = 0; i < LIMITS.llmRunsPerDay; i++) limits.usedSharedLlm(alice.id);
    const capped = limits.llmFor(alice.id);
    assert.equal(capped.llm, null);
    assert.match(capped.note ?? '', /own key/);
    tenancy.setLlmKey(alice.id, seal('alice-own-key-0123456789'));
    const own = limits.llmFor(alice.id);
    assert.equal(own.llm?.apiKey, 'alice-own-key-0123456789');
    assert.equal(own.shared, false);
    tenancy.setDisabled(alice.id, true);
    assert.throws(() => limits.admit(alice.id, 0), /disabled/);
  } finally {
    if (saved === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = saved;
  }
});

test('secrets are sealed with authentication', () => {
  initSecrets(join(mkdtempSync(join(tmpdir(), 'sec-')), 'secret.key'));
  const s = seal('jira-token');
  assert.notEqual(s, 'jira-token');
  assert.equal(unseal(s), 'jira-token');
  const tampered = s.slice(0, -2) + (s.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => unseal(tampered));
});

test('the arena takes turns and shows each person only their runs and the demo', async () => {
  const { store, alice, bob } = people();
  const dir = mkdtempSync(join(tmpdir(), 'arena-mt-'));
  const arena = new Arena({ suitesDir: join(dir, 'suites'), workDir: join(dir, 'repos'), shopliteUrl: 'http://127.0.0.1:1', repos: [], store });
  const order: (number | null)[] = [];
  const done = new Promise<void>((resolve) => {
    arena.bus.on('started', (ep) => order.push(ep.owner));
    arena.bus.on('finished', () => order.length === 4 && resolve());
  });
  const go = (owner: number | null) => arena.start({ ticket: 'NOPE-1', owner, stepDelayMs: 0, target: { kind: 'shoplite', mutations: [] } });
  // Alice queues three in a row; Bob's one should not wait behind all of hers.
  go(alice.id);
  go(alice.id);
  go(alice.id);
  go(bob.id);
  await done;
  assert.deepEqual(order, [alice.id, bob.id, alice.id, alice.id]);

  go(null);
  await new Promise((r) => arena.bus.once('finished', r));
  const owners = (viewer?: number | null) => arena.history(50, viewer).map((e) => (e as { owner: number | null }).owner);
  assert.ok(owners(alice.id).every((o) => o === alice.id || o === null));
  assert.ok(owners(bob.id).every((o) => o === bob.id || o === null));
  assert.deepEqual(owners(null), [null], 'a visitor sees only the demo');
  assert.equal(owners(undefined).length, 5, 'the operator sees everything');
});

test('the browser fence knows private addresses', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.1.1', '169.254.169.254', '100.101.1.1', '::1', 'fd00::1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '140.82.112.3', '172.32.0.1', '100.128.0.1']) assert.ok(!isPrivateAddress(a), a);
});
