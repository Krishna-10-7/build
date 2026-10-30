import { Contract } from './contract.ts';
import { chatJson, extractJson, llmConfigFromEnv, type ChatMessage, type LlmConfig } from './llm.ts';
import { parseCriterion } from './parser.ts';
import type { Ticket } from './ticket.ts';

const SYSTEM = `You compile acceptance criteria into a JSON test contract for a browser test generator.
Return only JSON with this shape:
{
  "ticket": "<ticket key>",
  "title": "<ticket title>",
  "source": "llm",
  "criteria": [{
    "id": "AC-1",
    "text": "<criterion text, unchanged>",
    "testable": true,
    "steps": [
      { "do": "goto", "url": "/path" },
      { "do": "click", "key": "page.elementName", "intent": "what the element is, in words a user would say" },
      { "do": "fill", "key": "page.fieldName", "intent": "...", "value": "text to type" }
    ],
    "expect": [
      { "id": "AC-1.a", "type": "text", "key": "page.elementName", "intent": "...", "equals": "exact text" },
      { "id": "AC-1.b", "type": "text", "key": "page.elementName", "intent": "...", "contains": "part of the text" },
      { "id": "AC-1.c", "type": "visible", "key": "page.elementName", "intent": "..." },
      { "id": "AC-1.d", "type": "request", "method": "POST", "path": "/api/...", "status": 201 },
      { "id": "AC-1.e", "type": "url", "path": "/path" }
    ]
  }]
}
Rules:
- Every testable criterion starts with a goto step to a path that the ticket states.
- Add a goto step only where the shopper opens a path directly. After a click that navigates, continue on the new page without a goto.
- Keys are "scope.camelCaseName". Use the page as scope ("product", "cart", "checkout"), or "header" for site header elements. Reuse the same key for the same element across criteria.
- Intents describe the element by its visible label and role, e.g. "Add to cart button".
- Only add request or url expectations when the "then" part of the criterion states them. Do not invent API paths.
- Never invent page paths, values or texts that the ticket does not contain.
- If a criterion cannot be checked in a browser, set "testable": false, give a short "note", and leave steps and expect empty.`;

export interface CompileOutcome {
  contract: Contract;
  source: 'llm' | 'parser';
  model?: string;
  cached?: boolean;
  warnings: string[];
}

function userPrompt(t: Ticket): string {
  const criteria = t.criteria.map((c) => `${c.id}: ${c.text}`).join('\n');
  return `Ticket ${t.key}: ${t.title}\n\nDescription:\n${t.description.slice(0, 4000)}\n\nAcceptance criteria:\n${criteria}`;
}

export function compileWithParser(t: Ticket): CompileOutcome {
  const contract = Contract.parse({ ticket: t.key, title: t.title, source: 'parser', criteria: t.criteria.map(parseCriterion) });
  const warnings = contract.criteria.filter((c) => !c.testable).map((c) => `${c.id}: ${c.note}`);
  return { contract, source: 'parser', warnings };
}

export async function compileWithLlm(t: Ticket, cfg: LlmConfig): Promise<CompileOutcome> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt(t) },
  ];
  // One retry that shows the model its schema errors.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chatJson(cfg, messages);
    let parsed: unknown;
    try {
      parsed = extractJson(res.content);
    } catch (err) {
      messages.push({ role: 'assistant', content: res.content }, { role: 'user', content: `That was not valid JSON (${(err as Error).message}). Return only the JSON object.` });
      continue;
    }
    const check = Contract.safeParse({ ...(parsed as object), ticket: t.key, source: 'llm' });
    if (check.success) {
      const known = new Set(t.criteria.map((c) => c.id));
      const warnings = check.data.criteria.filter((c) => !known.has(c.id)).map((c) => `${c.id} is not in the ticket`);
      warnings.push(...check.data.criteria.filter((c) => !c.testable).map((c) => `${c.id}: ${c.note ?? 'not testable'}`));
      return { contract: check.data, source: 'llm', model: res.model, cached: res.cached, warnings };
    }
    const issues = check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    messages.push({ role: 'assistant', content: res.content }, { role: 'user', content: `The JSON does not match the schema:\n${issues}\nFix it and return the full JSON object.` });
  }
  throw new Error('the model did not return a valid contract after a retry');
}

export type CompileMode = 'auto' | 'llm' | 'parser';

/** LLM when configured, rule-based parser otherwise or when the LLM call fails. */
export async function compileTicket(t: Ticket, mode: CompileMode = 'auto'): Promise<CompileOutcome> {
  if (!t.criteria.length) throw new Error(`${t.key} has no acceptance criteria`);
  const cfg = llmConfigFromEnv();
  if (mode === 'parser' || (mode === 'auto' && !cfg)) return compileWithParser(t);
  if (!cfg) throw new Error('no LLM configured: set LLM_PROVIDER and LLM_API_KEY');
  try {
    return await compileWithLlm(t, cfg);
  } catch (err) {
    if (mode === 'llm') throw err;
    const out = compileWithParser(t);
    out.warnings.unshift(`LLM compile failed (${(err as Error).message}); used the rule-based parser`);
    return out;
  }
}
