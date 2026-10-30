import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Decisions (accept a heal? which verdict?) are made by ordered rules kept as
 * data, not by branches in code. The first rule whose condition holds decides,
 * and the result names that rule, so every ledger entry can say why.
 */

export type Facts = Record<string, string | number | boolean>;

type Condition =
  | { fact: string; eq?: string | number | boolean; ne?: string | number | boolean; in?: (string | number | boolean)[]; gt?: number; gte?: number; lt?: number }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema) }).strict(),
    z.object({ any: z.array(ConditionSchema) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
    z
      .object({
        fact: z.string(),
        eq: Scalar.optional(),
        ne: Scalar.optional(),
        in: z.array(Scalar).optional(),
        gt: z.number().optional(),
        gte: z.number().optional(),
        lt: z.number().optional(),
      })
      .strict(),
  ]),
);

export const PolicySchema = z.object({
  name: z.string(),
  version: z.number().int(),
  description: z.string(),
  /** Facts every evaluation must supply; a missing fact is an error, not a silent false. */
  facts: z.record(z.string(), z.enum(['string', 'number', 'boolean'])),
  /** Values a decision may take. */
  decisions: z.array(z.string()).min(1),
  rules: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
        when: ConditionSchema,
        then: z.string(),
      }),
    )
    .min(1),
  otherwise: z.object({ id: z.string(), description: z.string(), then: z.string() }),
});
export type Policy = z.infer<typeof PolicySchema>;

export interface PolicyDecision {
  decision: string;
  rule: string;
  description: string;
  policy: string;
}

function factsUsed(c: Condition, out: Set<string>): Set<string> {
  if ('all' in c) c.all.forEach((x) => factsUsed(x, out));
  else if ('any' in c) c.any.forEach((x) => factsUsed(x, out));
  else if ('not' in c) factsUsed(c.not, out);
  else out.add(c.fact);
  return out;
}

function holds(c: Condition, f: Facts): boolean {
  if ('all' in c) return c.all.every((x) => holds(x, f));
  if ('any' in c) return c.any.some((x) => holds(x, f));
  if ('not' in c) return !holds(c.not, f);
  const v = f[c.fact];
  if (c.eq !== undefined && v !== c.eq) return false;
  if (c.ne !== undefined && v === c.ne) return false;
  if (c.in !== undefined && !c.in.includes(v)) return false;
  if (c.gt !== undefined && !(typeof v === 'number' && v > c.gt)) return false;
  if (c.gte !== undefined && !(typeof v === 'number' && v >= c.gte)) return false;
  if (c.lt !== undefined && !(typeof v === 'number' && v < c.lt)) return false;
  return true;
}

export class PolicyEngine {
  readonly sha256: string;
  readonly label: string;

  constructor(readonly policy: Policy) {
    const p = PolicySchema.parse(policy);
    const allowed = new Set(p.decisions);
    for (const r of [...p.rules, p.otherwise]) {
      if (!allowed.has(r.then)) throw new Error(`${p.name}: rule ${r.id} decides "${r.then}", which is not a declared decision`);
    }
    for (const r of p.rules) {
      for (const fact of factsUsed(r.when, new Set())) {
        if (!(fact in p.facts)) throw new Error(`${p.name}: rule ${r.id} uses undeclared fact "${fact}"`);
      }
    }
    this.sha256 = createHash('sha256').update(JSON.stringify(p)).digest('hex');
    this.label = `${p.name}@${p.version}`;
  }

  static fromFile(file: string | URL): PolicyEngine {
    return new PolicyEngine(PolicySchema.parse(JSON.parse(readFileSync(file, 'utf8'))));
  }

  evaluate(facts: Facts): PolicyDecision {
    for (const [name, type] of Object.entries(this.policy.facts)) {
      if (typeof facts[name] !== type) throw new Error(`${this.label}: fact "${name}" must be a ${type}, got ${JSON.stringify(facts[name])}`);
    }
    const hit = this.policy.rules.find((r) => holds(r.when, facts)) ?? this.policy.otherwise;
    return { decision: hit.then, rule: hit.id, description: hit.description, policy: this.label };
  }
}

const builtIn = (name: string) => new URL(`./policies/${name}.json`, import.meta.url);

let cache: { heal: PolicyEngine; verdict: PolicyEngine } | null = null;

/** The policies shipped with SentinelQA. POLICY_DIR points at a folder with replacements. */
export function policies(): { heal: PolicyEngine; verdict: PolicyEngine } {
  if (!cache) {
    const dir = process.env.POLICY_DIR;
    const file = (n: string) => (dir ? `${dir}/${n}.json` : builtIn(n));
    cache = { heal: PolicyEngine.fromFile(file('heal')), verdict: PolicyEngine.fromFile(file('verdict')) };
  }
  return cache;
}
