import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOutput, verifySignature } from '../src/github.ts';
import { Arena, type Episode } from '../src/arena/arena.ts';
import { Store } from '../src/db.ts';

test('webhook signature must match the exact body', () => {
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  assert.equal(verifySignature('s3cret', body, sig), true);
  assert.equal(verifySignature('other', body, sig), false);
  assert.equal(verifySignature('s3cret', Buffer.from('{"ref":"refs/heads/evil"}'), sig), false);
  assert.equal(verifySignature('s3cret', body, undefined), false);
  assert.equal(verifySignature('s3cret', body, 'sha256=00'), false);
});

const result = (criterion: string, verdict: string, heals = 0) => ({ criterion, verdict, rule: 'V0', heals: Array(heals).fill({ decision: 'accepted' }) }) as never;
const ep = (sentinel: unknown[] | null, rival: unknown[] | null = null, status: Episode['status'] = 'finished') =>
  ({ id: 7, status, error: status === 'failed' ? 'install exited with 1' : null, request: { ticket: 'SHOP-42' }, results: { sentinel, rival } }) as never;

test('a regression fails the commit even when the fixer went green', () => {
  const out = checkOutput(ep([result('AC-1', 'PASS'), result('AC-2', 'REGRESSION')], [{ criterion: 'AC-2', green: true, editedAssertions: true }]), 'https://x/office/?episode=7');
  assert.equal(out.conclusion, 'failure');
  assert.match(out.title, /Regression caught · AC-2/);
  assert.match(out.summary, /after rewriting the assertion/);
  assert.match(out.summary, /episode=7/);
});

test('healed locators pass and are counted', () => {
  const out = checkOutput(ep([result('AC-1', 'HEALED', 2), result('AC-2', 'PASS')]));
  assert.equal(out.conclusion, 'success');
  assert.equal(out.title, '2/2 criteria pass · 2 locators healed');
});

test('review, errors and failed runs never report success', () => {
  assert.equal(checkOutput(ep([result('AC-1', 'NEEDS_REVIEW')])).conclusion, 'action_required');
  assert.equal(checkOutput(ep([result('AC-1', 'ERROR')])).conclusion, 'neutral');
  const failed = checkOutput(ep(null, null, 'failed'));
  assert.equal(failed.conclusion, 'neutral');
  assert.match(failed.summary, /install exited with 1/);
});

test('episodes queue one at a time and are kept across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-'));
  const store = new Store(':memory:');
  const cfg = { suitesDir: join(dir, 'suites'), workDir: join(dir, 'repos'), shopliteUrl: 'http://127.0.0.1:1', repos: [], store };
  const arena = new Arena(cfg);
  const done = new Promise<void>((resolve) => {
    let n = 0;
    arena.bus.on('finished', () => ++n === 2 && resolve());
  });
  // No suite exists for this ticket, so each episode fails fast; the queue still has to drain in order.
  const a = arena.start({ ticket: 'NOPE-1', stepDelayMs: 0, target: { kind: 'shoplite', mutations: [] } });
  const b = arena.start({ ticket: 'NOPE-1', stepDelayMs: 0, target: { kind: 'shoplite', mutations: ['R5'] } });
  assert.equal(a.status, 'preparing');
  assert.equal(b.status, 'queued');
  assert.deepEqual(arena.snapshot()!.queue.map((q) => q.id), [b.id]);
  await done;

  const history = arena.history();
  assert.deepEqual(history.map((e) => e.id), [b.id, a.id]);
  assert.ok(history.every((e) => e.status === 'failed'));
  assert.equal(history[0].truth, 'regression');

  const again = new Arena(cfg);
  assert.equal(again.episode?.id, b.id);
  assert.equal(again.start({ ticket: 'NOPE-1', stepDelayMs: 0, target: { kind: 'shoplite', mutations: [] } }).id, b.id + 1);
});
