import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Contract, EffectSignature, Fingerprint } from '@sentinelqa/core';
import { compareEffects, generateSpec, normalizePath, scoreCandidate, sha256, similarity, THRESHOLDS } from '../src/index.ts';

const button = (over: Partial<Fingerprint> = {}): Fingerprint => ({
  role: 'button',
  name: 'Add to cart',
  text: 'Add to cart',
  near: 'Clay Mug',
  landmarks: ['main', 'section'],
  testid: 'add-to-cart',
  tag: 'button',
  id: '',
  type: '',
  attrName: '',
  href: '',
  placeholder: '',
  index: 0,
  siblings: 3,
  visible: true,
  enabled: true,
  ...over,
});

test('similarity treats shop synonyms as the same word', () => {
  assert.equal(similarity('Add to cart', 'Add to bag'), 1);
  assert.equal(similarity('Sign in', 'Log in'), 1);
  assert.ok(similarity('Add to cart', 'Add to wishlist') < 0.6);
});

test('a renamed and relabelled button still scores above the auto-heal line', () => {
  const s = scoreCandidate(button(), button({ testid: 'btn-add-cart', name: 'Add to bag', text: 'Add to bag' }));
  assert.ok(s.total >= THRESHOLDS.auto, `score ${s.total}`);
});

test('a different button in the same card scores below the auto-heal line', () => {
  const s = scoreCandidate(button(), button({ testid: '', name: 'Save for later', text: 'Save for later', index: 1 }));
  assert.ok(s.total < THRESHOLDS.auto, `score ${s.total}`);
});

test('paths keep their shape with ids replaced', () => {
  assert.equal(normalizePath('/api/cart/items/42?x=1'), '/api/cart/items/:id');
  assert.equal(normalizePath('/api/orders/3f2a9c1e-77aa-4c1b-9e1a-1234567890ab'), '/api/orders/:id');
});

const effect = (over: Partial<EffectSignature> = {}): EffectSignature => ({
  requests: ['POST /api/cart/items 2xx'],
  urlBefore: '/product/clay-mug',
  urlAfter: '/product/clay-mug',
  watched: { 'header.cartBadge': { before: '0', after: '1' } },
  ...over,
});

test('same action, same effect matches', () => {
  assert.equal(compareEffects(effect(), effect()).match, true);
});

test('a look-alike that calls another endpoint is a mismatch', () => {
  const c = compareEffects(effect(), effect({ requests: ['POST /api/wishlist 2xx'], watched: { 'header.cartBadge': { before: '0', after: '0' } } }));
  assert.equal(c.match, false);
  assert.match(c.detail, /expected POST \/api\/cart\/items 2xx; observed POST \/api\/wishlist 2xx/);
});

test('watched elements that cannot be read are skipped, not counted as a change', () => {
  const c = compareEffects(effect(), effect({ watched: { 'header.cartBadge': { before: '<missing>', after: '<missing>' } } }));
  assert.equal(c.match, true);
});

test('a step with no observable effect cannot verify a heal', () => {
  const quiet = effect({ requests: [], watched: {} });
  const c = compareEffects(quiet, quiet);
  assert.equal(c.unverifiable, true);
  assert.equal(c.match, false);
});

test('generated specs are deterministic, so their hash can be locked', () => {
  const contract: Contract = {
    ticket: 'SHOP-1',
    title: 'Badge',
    source: 'manual',
    criteria: [
      {
        id: 'AC-1',
        text: 'badge shows 1',
        testable: true,
        steps: [
          { do: 'goto', url: '/product/clay-mug' },
          { do: 'click', key: 'product.addToCart', intent: 'Add to cart button' },
        ],
        expect: [{ id: 'AC-1.a', type: 'text', key: 'header.cartBadge', intent: 'cart badge', equals: '1' }],
      },
    ],
  };
  const a = generateSpec(contract);
  assert.equal(sha256(a), sha256(generateSpec(structuredClone(contract))));
  assert.match(a, /await loc\(page, "product\.addToCart"\)\.click\(\);/);
  assert.match(a, /\/\/ @criterion AC-1\.a/);
});
