import type { Fingerprint } from '@sentinelqa/core';
import { similarity } from './similarity.ts';

/** Feature weights for L1 matching; they sum to 1. */
export const WEIGHTS = {
  role: 0.2,
  name: 0.2,
  text: 0.1,
  near: 0.1,
  landmarks: 0.1,
  testid: 0.1,
  attrs: 0.15,
  position: 0.05,
} as const;

export const THRESHOLDS = {
  /** Below this nothing is a credible match. */
  min: 0.55,
  /** Top two closer than this are a tie. */
  tieGap: 0.08,
  /** At or above this (and not a tie) a heal may be accepted without review. */
  auto: 0.85,
};

const CLICKABLE = new Set(['button', 'link', 'menuitem', 'tab']);

function textMatch(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return a === b ? 1 : similarity(a, b);
}

function exact(a: string, b: string): number {
  return a === b ? 1 : 0;
}

function roleMatch(a: string, b: string): number {
  if (a === b) return 1;
  return CLICKABLE.has(a) && CLICKABLE.has(b) ? 0.5 : 0;
}

function landmarkMatch(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const jaccard = inter / (sa.size + sb.size - inter);
  const sameInnermost = a.at(-1) === b.at(-1) ? 1 : 0;
  return 0.6 * jaccard + 0.4 * sameInnermost;
}

function positionMatch(a: Fingerprint, b: Fingerprint): number {
  const span = Math.max(a.siblings, b.siblings, 1);
  return 1 - Math.min(1, Math.abs(a.index - b.index) / span);
}

export interface ScoreBreakdown {
  total: number;
  parts: Record<keyof typeof WEIGHTS, number>;
}

/** How likely `cand` is the element the baseline fingerprint described. */
export function scoreCandidate(base: Fingerprint, cand: Fingerprint): ScoreBreakdown {
  const parts = {
    role: roleMatch(base.role, cand.role),
    name: textMatch(base.name, cand.name),
    text: textMatch(base.text, cand.text),
    near: textMatch(base.near, cand.near),
    landmarks: landmarkMatch(base.landmarks, cand.landmarks),
    testid: textMatch(base.testid, cand.testid),
    attrs:
      (exact(base.tag, cand.tag) + textMatch(base.id, cand.id) + exact(base.type, cand.type) + exact(base.attrName, cand.attrName) + exact(base.href, cand.href)) /
      5,
    position: positionMatch(base, cand),
  };
  let total = 0;
  for (const k of Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]) total += WEIGHTS[k] * parts[k];
  // An element the user cannot use is not a substitute for one they could.
  if (!cand.visible) total *= 0.5;
  return { total: Math.round(total * 1000) / 1000, parts };
}

/** Plain-language reason for a heal: what changed between baseline and candidate. */
export function explainChange(base: Fingerprint, cand: Fingerprint): string {
  const notes: string[] = [];
  if (base.testid !== cand.testid) notes.push(base.testid ? (cand.testid ? `testid '${base.testid}' -> '${cand.testid}'` : `testid '${base.testid}' removed`) : `testid '${cand.testid}' added`);
  if (base.id !== cand.id) notes.push(base.id ? (cand.id ? `id '${base.id}' -> '${cand.id}'` : `id '${base.id}' removed`) : `id '${cand.id}' added`);
  if (base.role === cand.role) notes.push(`same role (${cand.role})`);
  else notes.push(`role ${base.role} -> ${cand.role}`);
  if (base.name !== cand.name) notes.push(`name '${base.name}' -> '${cand.name}'`);
  if (base.tag !== cand.tag) notes.push(`<${base.tag}> -> <${cand.tag}>`);
  if (base.landmarks.join('>') !== cand.landmarks.join('>')) notes.push(`moved ${base.landmarks.join('>') || 'page'} -> ${cand.landmarks.join('>') || 'page'}`);
  return notes.join('; ');
}
