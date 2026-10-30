/** Words that mean the same thing on a shop UI. Each group maps to its first word. */
const SYNONYM_GROUPS = [
  ['cart', 'bag', 'basket', 'trolley'],
  ['login', 'log in', 'sign in', 'signin'],
  ['logout', 'log out', 'sign out'],
  ['checkout', 'check out'],
  ['remove', 'delete', 'discard'],
  ['email', 'e-mail', 'mail'],
  ['quantity', 'qty', 'how many'],
  ['order', 'purchase'],
  ['add', 'put'],
  ['total', 'subtotal', 'amount'],
  ['status', 'message', 'msg', 'notice'],
  ['badge', 'count', 'counter'],
];

const CANON = new Map<string, string>();
for (const g of SYNONYM_GROUPS) for (const w of g) CANON.set(w, g[0]);

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'on', 'in', 'your', 'my', 'btn', 'button']);

export function normalize(s: string): string {
  let t = s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_\-./#]+/g, ' ')
    .replace(/[^a-z0-9₹ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Multi-word synonyms first so "sign in" becomes one token.
  for (const [w, c] of CANON) if (w.includes(' ')) t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), c);
  return t;
}

export function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .map((w) => CANON.get(w) ?? w);
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const t = s.replace(/ /g, '');
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [, n] of A) total += n;
  for (const [, n] of B) total += n;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) ?? 0);
  return total ? (2 * overlap) / total : 0;
}

/** 0..1 similarity of two labels; synonyms count as equal words. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const ja = ta.join(' ');
  const jb = tb.join(' ');
  if (ja === jb) return 1;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const jaccard = inter / (sa.size + sb.size - inter);
  return 0.6 * jaccard + 0.4 * dice(ja, jb);
}

/** Exact match is 1, both empty is neutral (null), one empty is 0. */
export function fieldMatch(a: string, b: string): number | null {
  if (!a && !b) return null;
  if (!a || !b) return 0;
  return a === b ? 1 : similarity(a, b);
}
