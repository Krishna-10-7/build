import { z } from 'zod';

/** Element keys look like `product.addToCart`: page scope, then a camelCase name. */
export const ElementKey = z.string().regex(/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/, 'key must look like page.elementName');

export const Step = z.discriminatedUnion('do', [
  z.object({ do: z.literal('goto'), url: z.string().startsWith('/') }),
  z.object({ do: z.literal('click'), key: ElementKey, intent: z.string().min(3) }),
  z.object({ do: z.literal('fill'), key: ElementKey, intent: z.string().min(3), value: z.string() }),
]);
export type Step = z.infer<typeof Step>;

const ExpectId = z.string().regex(/^AC-\d+\.[a-z]$/, 'expectation ids look like AC-1.a');

export const Expect = z.discriminatedUnion('type', [
  z.object({
    id: ExpectId,
    type: z.literal('text'),
    key: ElementKey,
    intent: z.string().min(3),
    equals: z.string().optional(),
    contains: z.string().optional(),
  }),
  z.object({ id: ExpectId, type: z.literal('visible'), key: ElementKey, intent: z.string().min(3) }),
  z.object({
    id: ExpectId,
    type: z.literal('request'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().startsWith('/'),
    status: z.number().int().min(100).max(599),
  }),
  z.object({ id: ExpectId, type: z.literal('url'), path: z.string().startsWith('/') }),
]);
export type Expect = z.infer<typeof Expect>;

export const Criterion = z
  .object({
    id: z.string().regex(/^AC-\d+$/),
    text: z.string().min(5),
    testable: z.boolean().default(true),
    note: z.string().optional(),
    steps: z.array(Step),
    expect: z.array(Expect),
  })
  .superRefine((c, ctx) => {
    if (!c.testable) return;
    if (!c.steps.length) ctx.addIssue({ code: 'custom', message: `${c.id} has no steps` });
    if (!c.expect.length) ctx.addIssue({ code: 'custom', message: `${c.id} has no expectations` });
    if (c.steps[0] && c.steps[0].do !== 'goto') ctx.addIssue({ code: 'custom', message: `${c.id} must start with a goto step` });
    for (const e of c.expect) {
      if (!e.id.startsWith(c.id + '.')) ctx.addIssue({ code: 'custom', message: `${e.id} does not belong to ${c.id}` });
      if (e.type === 'text' && e.equals === undefined && e.contains === undefined) {
        ctx.addIssue({ code: 'custom', message: `${e.id} needs equals or contains` });
      }
    }
  });
export type Criterion = z.infer<typeof Criterion>;

export const Contract = z
  .object({
    ticket: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
    title: z.string(),
    source: z.enum(['llm', 'parser', 'manual']),
    criteria: z.array(Criterion).min(1),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const cr of c.criteria) {
      if (ids.has(cr.id)) ctx.addIssue({ code: 'custom', message: `duplicate criterion ${cr.id}` });
      ids.add(cr.id);
    }
  });
export type Contract = z.infer<typeof Contract>;

/** Every key the contract refers to, with the first intent given for it. */
export function contractKeys(contract: Contract): Map<string, string> {
  const keys = new Map<string, string>();
  for (const cr of contract.criteria) {
    for (const s of [...cr.steps, ...cr.expect]) {
      if ('key' in s && !keys.has(s.key)) keys.set(s.key, s.intent);
    }
  }
  return keys;
}
