import type { Criterion, Expect, Step } from './contract.ts';
import type { TicketCriterion } from './ticket.ts';

/**
 * Rule-based compiler for criteria written with quoted targets, for example:
 *   Given the shopper is on "/product/clay-mug", when they click "Add to cart",
 *   then the "cart badge" shows "1".
 * Used when no LLM is configured, or as a fallback when the LLM call fails.
 */

type ExpectDraft = Expect extends infer E ? (E extends unknown ? Omit<E, 'id'> : never) : never;

const FILLER = new Set(['the', 'a', 'an', 'button', 'field', 'link', 'input', 'box']);

export function keyName(intent: string): string {
  const words = intent
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w));
  if (!words.length) return 'element';
  const name = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('');
  return /^[a-z]/.test(name) ? name : 'el' + name;
}

export function scopeOf(url: string): string {
  const seg = url.split('?')[0].split('/').filter(Boolean)[0];
  return seg ? keyName(seg) : 'home';
}

/** Moves the key scope to a new page without adding a step, e.g. after a click navigates. */
interface ScopeChange {
  scope: string;
}

interface Match {
  at: number;
  build: (scope: string) => Step | ExpectDraft | ScopeChange;
}

const PATTERNS: { re: RegExp; make: (m: RegExpExecArray) => Match['build'] }[] = [
  {
    re: /\b(?:is on|are on|opens?|goes to|go to|visits?|navigates? to)\s+"(\/[^"]*)"/gi,
    make: (m) => () => ({ do: 'goto', url: m[1] }),
  },
  {
    re: /\b(?:taking them to|landing on)\s+"(\/[^"]*)"/gi,
    make: (m) => () => ({ scope: scopeOf(m[1]) }),
  },
  {
    re: /\b(?:clicks?|taps?|presses?|selects?)\s+(?:on\s+)?"([^"]+)"/gi,
    make: (m) => (scope) => ({ do: 'click', key: `${scope}.${keyName(m[1])}`, intent: m[1] }),
  },
  {
    re: /\b(?:sets?|enters?|types?|fills?(?: in)?)\s+"([^"]+)"\s+(?:to|with|as)\s+"([^"]*)"/gi,
    make: (m) => (scope) => ({ do: 'fill', key: `${scope}.${keyName(m[1])}`, intent: m[1], value: m[2] }),
  },
  {
    re: /\bthe\s+"([^"]+)"\s+(shows|reads|equals|contains|includes)\s+"([^"]*)"/gi,
    make: (m) => (scope) => {
      const exact = /shows|reads|equals/i.test(m[2]);
      return {
        type: 'text',
        key: `${scope}.${keyName(m[1])}`,
        intent: m[1],
        ...(exact ? { equals: m[3] } : { contains: m[3] }),
      } as ExpectDraft;
    },
  },
  {
    re: /\bthe\s+"([^"]+)"\s+is\s+(?:shown|visible|displayed)/gi,
    make: (m) => (scope) => ({ type: 'visible', key: `${scope}.${keyName(m[1])}`, intent: m[1] }) as ExpectDraft,
  },
  {
    re: /\ba\s+(GET|POST|PUT|PATCH|DELETE)\s+(?:request\s+)?to\s+"(\/[^"]*)"\s+returns\s+(\d{3})/gi,
    make: (m) => () => ({ type: 'request', method: m[1].toUpperCase(), path: m[2], status: Number(m[3]) }) as ExpectDraft,
  },
];

export function parseCriterion(c: TicketCriterion): Criterion {
  const thenAt = c.text.search(/\bthen\b/i);
  const matches: Match[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(c.text))) matches.push({ at: m.index, build: p.make(m) });
  }
  matches.sort((a, b) => a.at - b.at);

  const steps: Step[] = [];
  const expect: Expect[] = [];
  let scope = 'home';
  for (const m of matches) {
    const built = m.build(scope);
    if ('scope' in built) {
      scope = built.scope;
    } else if ('do' in built) {
      if (thenAt >= 0 && m.at > thenAt) continue;
      if (built.do === 'goto') scope = scopeOf(built.url);
      steps.push(built);
    } else {
      if (thenAt >= 0 && m.at < thenAt) continue;
      expect.push({ ...built, id: `${c.id}.${String.fromCharCode(97 + expect.length)}` } as Expect);
    }
  }

  const testable = steps.length > 0 && steps[0].do === 'goto' && expect.length > 0;
  return {
    id: c.id,
    text: c.text,
    testable,
    ...(testable ? {} : { note: 'Could not find a start page, an action and a checkable outcome in quotes. Rewrite it or compile with an LLM.' }),
    steps: testable ? steps : [],
    expect: testable ? expect : [],
  };
}
