import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describe, type AgentApi, type CheckResult } from './agent.ts';
import { Auth, type Caller, type Scope } from './auth.ts';
import type { TicketDesk } from './tickets.ts';

/**
 * SentinelQA as an MCP server (Streamable HTTP, stateless, JSON responses). Coding agents that push
 * to GitHub can ask, before or after the push, whether the app still does what its tickets say.
 *
 *   claude mcp add --transport http sentinelqa https://<host>/sentinel/mcp --header "Authorization: Bearer sqa_..."
 */

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `SentinelQA checks a build of an app against the acceptance criteria of its tickets, in a real browser.
It repairs broken locators on its own, but never changes what a test checks.
Typical loop: push your change, then call commit_status with the repository and commit SHA (or run_check on a branch), and read the verdicts.
PASS or HEALED: the criterion holds. REGRESSION: the app no longer does what the ticket asks; fix the application code.
Never edit tests or expected values to turn a REGRESSION green. NEEDS_REVIEW: a person must look. ERROR or FLAKY: inconclusive, run again.`;

interface Tool {
  name: string;
  description: string;
  scope: Scope;
  input: z.ZodObject<z.ZodRawShape>;
  run(args: any, caller: Caller): Promise<{ text: string; data: unknown }>;
}

const waitArg = z.number().int().min(0).max(120).default(90).describe('Seconds to wait for the result before returning (0 returns at once).');

export function registerMcp(app: FastifyInstance, agent: AgentApi, auth: Auth, defaultTicket: string, desk: TicketDesk) {
  const result = (r: CheckResult | null, what: string) => {
    if (!r) throw new Error(`${what} not found`);
    return { text: describe(r), data: r };
  };

  const tools: Tool[] = [
    {
      name: 'list_projects',
      description: 'List the projects SentinelQA can check (the ShopLite demo and every connected GitHub repository) with their latest verdict.',
      scope: 'read',
      input: z.object({}),
      async run(_a, caller) {
        const floors = await agent.floors(caller);
        const text = floors
          .map((f) => `${f.id}${f.defaultRef ? ` (default branch ${f.defaultRef})` : ''}: ${f.live ? 'running now' : f.last ? `${f.last.conclusion ?? f.last.status}${f.last.title ? ` · ${f.last.title}` : ''} (run #${f.last.id})` : 'no runs yet'}${f.queued ? ` · ${f.queued} queued` : ''}`)
          .join('\n');
        return { text, data: { projects: floors.map(({ options, ...f }) => ({ ...f, scenarios: f.kind === 'demo' ? options.filter((o) => o.id.startsWith('scenario:')).map((o) => o.id.slice(9)) : undefined })) } };
      },
    },
    {
      name: 'run_check',
      description:
        'Run SentinelQA on a project. For a GitHub repository, checks the latest commit of `ref` (default branch when omitted). For "demo", pass a `scenario` (redesign, qty-bug, lookalike, decoy, order-500, clean) or a demo branch as `ref`. Waits for the verdicts up to wait_seconds.',
      scope: 'run',
      input: z.object({
        project: z.string().describe('"demo" or owner/repo of a connected repository'),
        ref: z.string().optional().describe('Branch to check'),
        scenario: z.string().optional().describe('Demo scenario id'),
        ticket: z.string().optional().describe('Ticket to check, e.g. SHOP-42; a ticket of a linked Jira project is fetched from Jira first'),
        wait_seconds: waitArg,
      }),
      async run(a, caller) {
        const started = await agent.run(caller, { project: a.project, ref: a.ref, scenario: a.scenario, ticket: a.ticket });
        return result(await agent.wait(caller, started.id, a.wait_seconds), 'run');
      },
    },
    {
      name: 'get_result',
      description: 'Get the verdicts of a run by id, waiting up to wait_seconds if it is still going.',
      scope: 'read',
      input: z.object({ run_id: z.number().int(), wait_seconds: waitArg }),
      async run(a, caller) {
        return result(await agent.wait(caller, a.run_id, a.wait_seconds), `run #${a.run_id}`);
      },
    },
    {
      name: 'commit_status',
      description: 'The SentinelQA result for a commit pushed to a connected GitHub repository (the push starts the run). Waits for it to start and finish up to wait_seconds.',
      scope: 'read',
      input: z.object({ repo: z.string().describe('owner/repo'), sha: z.string().min(7).describe('Commit SHA, full or at least 7 characters'), wait_seconds: waitArg }),
      async run(a, caller) {
        const r = await agent.commit(caller, a.repo, a.sha, a.wait_seconds);
        if (!r) return { text: `No run for ${a.repo}@${a.sha.slice(0, 7)} yet. Is the repository connected and the commit pushed? Try again shortly.`, data: null };
        return result(r, 'run');
      },
    },
    {
      name: 'get_acceptance_criteria',
      description: 'The acceptance criteria SentinelQA checks for a ticket, and the steps compiled from them. Read this before changing behaviour the criteria cover.',
      scope: 'read',
      input: z.object({ ticket: z.string().default(defaultTicket) }),
      async run(a, caller) {
        const owner = caller.user?.id ?? null;
        await desk.ensureSuite(owner, a.ticket);
        const contract = await desk.suite(owner, a.ticket).contract();
        if (!contract) throw new Error(`${a.ticket} has no compiled contract`);
        const text = contract.criteria.map((c) => `${c.id}: ${c.text}${c.testable ? '' : ' (not testable in a browser)'}`).join('\n');
        return { text: `${contract.ticket}\n${text}`, data: contract };
      },
    },
    {
      name: 'list_runs',
      description: 'Recent runs, newest first, optionally for one project.',
      scope: 'read',
      input: z.object({ project: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) }),
      async run(a, caller) {
        const runs = agent.runs(caller, a.project, a.limit);
        return { text: runs.map((r) => `#${r.id} ${r.status} ${r.conclusion ?? ''} ${r.label} ${r.title ?? ''}`.replace(/\s+/g, ' ').trim()).join('\n') || 'no runs', data: { runs } };
      },
    },
  ];

  const toolList = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t.input) }));

  async function handle(msg: any, caller: Caller): Promise<object | null> {
    const id = msg?.id;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request');
    if (id === undefined) return null; // a notification
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return ok({
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sentinelqa', title: 'SentinelQA', version: '0.3.0' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: toolList });
      case 'tools/call': {
        const tool = tools.find((t) => t.name === msg.params?.name);
        if (!tool) return fail(-32602, `unknown tool ${msg.params?.name}`);
        if (!Auth.allows(caller, tool.scope)) return ok({ isError: true, content: [{ type: 'text', text: `This token is read-only; ${tool.name} needs a "run" token.` }] });
        const args = tool.input.safeParse(msg.params?.arguments ?? {});
        if (!args.success) return fail(-32602, args.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        try {
          const out = await tool.run(args.data, caller);
          return ok({ content: [{ type: 'text', text: out.text }], ...(out.data && typeof out.data === 'object' ? { structuredContent: out.data } : {}) });
        } catch (err) {
          return ok({ isError: true, content: [{ type: 'text', text: (err as Error).message }] });
        }
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }

  app.post('/mcp', async (req, reply) => {
    const caller = auth.caller(req);
    if (!Auth.allows(caller, 'read')) {
      return reply.status(401).header('www-authenticate', 'Bearer realm="sentinelqa"').send({ error: 'API token required (Authorization: Bearer sqa_...)' });
    }
    const body = req.body as unknown;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(m, caller!)))).filter(Boolean);
      return out.length ? out : reply.status(202).send();
    }
    const out = await handle(body, caller!);
    return out ?? reply.status(202).send();
  });
  // No server-to-client stream: everything is request and response.
  app.get('/mcp', async (_req, reply) => reply.status(405).header('allow', 'POST').send({ error: 'use POST' }));
}

/** Enough JSON Schema for MCP clients, from the zod shapes above. */
function jsonSchema(obj: z.ZodObject<z.ZodRawShape>): object {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, raw] of Object.entries(obj.shape)) {
    let t = raw as z.ZodTypeAny;
    let optional = false;
    let def: unknown;
    const description = t.description;
    for (;;) {
      if (t instanceof z.ZodOptional) (optional = true), (t = t.unwrap());
      else if (t instanceof z.ZodDefault) (optional = true), (def = t._def.defaultValue()), (t = t._def.innerType);
      else break;
    }
    const type = t instanceof z.ZodNumber ? (t.isInt ? 'integer' : 'number') : t instanceof z.ZodBoolean ? 'boolean' : 'string';
    properties[key] = { type, ...(description ? { description } : {}), ...(def !== undefined ? { default: def } : {}) };
    if (!optional) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}
