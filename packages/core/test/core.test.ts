import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contract, PolicyEngine, extractCriteria, parseCriterion, policies, type Policy } from '../src/index.ts';

test('parser turns quoted criteria into steps and checks', () => {
  const c = parseCriterion({
    id: 'AC-1',
    text: 'Given the shopper is on "/product/clay-mug", when they set "Quantity" to "2" and click "Add to cart", then the "cart badge" shows "2".',
  });
  assert.equal(c.testable, true);
  assert.deepEqual(
    c.steps.map((s) => s.do),
    ['goto', 'fill', 'click'],
  );
  assert.deepEqual(c.expect[0], { id: 'AC-1.a', type: 'text', key: 'product.cartBadge', intent: 'cart badge', equals: '2' });
});

test('parser marks criteria it cannot read as not testable', () => {
  const c = parseCriterion({ id: 'AC-2', text: 'The checkout should feel fast.' });
  assert.equal(c.testable, false);
  assert.ok(c.note);
});

test('a "taking them to" phrase changes key scope without adding a step', () => {
  const c = parseCriterion({ id: 'AC-1', text: 'Given the shopper is on "/cart", when they click "Checkout" taking them to "/checkout" and click "Place order", then the "order status" contains "Order placed".' });
  assert.equal(c.steps.length, 3);
  assert.equal(c.steps[2].do === 'click' && c.steps[2].key, 'checkout.placeOrder');
});

test('criteria are found by AC id or under an Acceptance criteria heading', () => {
  assert.equal(extractCriteria('- AC-1: one\n- AC-2: two').length, 2);
  assert.deepEqual(extractCriteria('## Acceptance criteria\n- first\n- second'), [
    { id: 'AC-1', text: 'first' },
    { id: 'AC-2', text: 'second' },
  ]);
});

test('contract schema rejects checks that belong to another criterion', () => {
  const bad = {
    ticket: 'SHOP-1',
    title: 't',
    source: 'manual',
    criteria: [{ id: 'AC-1', text: 'some text', steps: [{ do: 'goto', url: '/' }], expect: [{ id: 'AC-2.a', type: 'url', path: '/' }] }],
  };
  assert.equal(Contract.safeParse(bad).success, false);
});

const tiny: Policy = {
  name: 'tiny',
  version: 1,
  description: 'test',
  facts: { score: 'number', ok: 'boolean' },
  decisions: ['yes', 'no', 'maybe'],
  rules: [
    { id: 'R1', description: 'not ok', when: { fact: 'ok', eq: false }, then: 'no' },
    { id: 'R2', description: 'high score', when: { fact: 'score', gte: 0.85 }, then: 'yes' },
  ],
  otherwise: { id: 'R0', description: 'fallback', then: 'maybe' },
};

test('policy engine: first matching rule wins and is named', () => {
  const e = new PolicyEngine(tiny);
  assert.deepEqual(e.evaluate({ score: 0.9, ok: false }), { decision: 'no', rule: 'R1', description: 'not ok', policy: 'tiny@1' });
  assert.equal(e.evaluate({ score: 0.9, ok: true }).rule, 'R2');
  assert.equal(e.evaluate({ score: 0.5, ok: true }).rule, 'R0');
});

test('policy engine refuses missing facts and undeclared decisions', () => {
  const e = new PolicyEngine(tiny);
  assert.throws(() => e.evaluate({ score: 0.9 }), /fact "ok"/);
  assert.throws(() => new PolicyEngine({ ...tiny, rules: [{ ...tiny.rules[0], then: 'perhaps' }] }), /not a declared decision/);
  assert.throws(() => new PolicyEngine({ ...tiny, rules: [{ ...tiny.rules[0], when: { fact: 'colour', eq: 'red' } }] }), /undeclared fact/);
});

const healFacts = { mode: 'sentinel', tier: 'auto', kind: 'click', specOk: true, effectOk: true, effectUnverifiable: false, criteriaOk: true, siblingRefused: false };

test('shipped heal policy: a look-alike with a different effect is refused even when checks pass', () => {
  const { heal } = policies();
  assert.equal(heal.evaluate(healFacts).decision, 'accepted');
  const d = heal.evaluate({ ...healFacts, effectOk: false });
  assert.equal(d.decision, 'refused');
  assert.equal(d.rule, 'H2');
  assert.equal(heal.evaluate({ ...healFacts, siblingRefused: true }).decision, 'refused');
  assert.equal(heal.evaluate({ ...healFacts, effectOk: false, effectUnverifiable: true }).decision, 'review');
  assert.equal(heal.evaluate({ ...healFacts, mode: 'plain', effectOk: false }).decision, 'accepted');
});

test('shipped verdict policy orders refusals before retries and reviews', () => {
  const { verdict } = policies();
  const base = { mode: 'sentinel', runOk: true, failureKind: 'none', heals: 0, refused: 0, review: 0, drift: false, retriedOk: false };
  assert.equal(verdict.evaluate(base).decision, 'PASS');
  assert.equal(verdict.evaluate({ ...base, heals: 1 }).decision, 'HEALED');
  assert.equal(verdict.evaluate({ ...base, heals: 2, refused: 1, review: 1 }).decision, 'REGRESSION');
  assert.equal(verdict.evaluate({ ...base, runOk: false, failureKind: 'expect', retriedOk: true }).decision, 'FLAKY');
  assert.equal(verdict.evaluate({ ...base, runOk: false, failureKind: 'crash' }).decision, 'ERROR');
  assert.equal(verdict.evaluate({ ...base, drift: true }).decision, 'NEEDS_REVIEW');
});
