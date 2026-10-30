import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StageError, nextActions, transition } from '../src/pipeline.ts';
import { Store } from '../src/db.ts';

test('stages cannot be skipped', () => {
  assert.throws(() => transition('received', 'generate'), StageError);
  assert.throws(() => transition('compiled', 'check'), StageError);
  assert.equal(transition('generated', 'baseline').to, 'baselined');
});

test('editing the contract sends a checked ticket back to the contract stage', () => {
  assert.equal(transition('checked', 'edit-contract').to, 'compiled');
  assert.deepEqual(nextActions('received'), ['compile']);
});

test('store keeps runs, results and heals together', () => {
  const s = new Store(':memory:');
  s.upsertTicket({ key: 'SHOP-1', title: 't', status: 'Ready for QA', description: '', criteria: [{ id: 'AC-1', text: 'x' }], source: 'api' });
  const run = s.createRun('SHOP-1', 'check', 'sentinel', ['D1']);
  s.saveResults(
    run,
    'SHOP-1',
    [
      {
        ticket: 'SHOP-1',
        criterion: 'AC-1',
        title: 'x',
        verdict: 'NEEDS_REVIEW',
        rule: 'verdict@1 V6',
        reason: 'r',
        durationMs: 1,
        attempts: 1,
        expects: [],
        screenshots: [],
        heals: [
          {
            key: 'cart.checkout',
            criterion: 'AC-1',
            step: 1,
            layer: 'L1',
            score: 0.8,
            runnerUp: null,
            from: { strategy: 'role', role: 'link', name: 'Checkout' },
            to: { strategy: 'role', role: 'link', name: 'Proceed to checkout' },
            candidate: "link 'Proceed to checkout', 0.80",
            reason: 'name changed',
            gates: { spec: { ok: true, detail: '' }, effect: { ok: true, detail: '' }, criteria: { ok: true, detail: '' } },
            decision: 'review',
            rule: 'heal@2 H5',
          },
        ],
      },
    ],
    () => 'pending',
  );
  assert.equal(s.results(run)[0].verdict, 'NEEDS_REVIEW');
  const [h] = s.heals({ status: 'pending' });
  assert.equal(h.key, 'cart.checkout');
  s.reviewHeal(h.id, 'approved');
  assert.equal(s.heal(h.id)?.status, 'approved');
});
