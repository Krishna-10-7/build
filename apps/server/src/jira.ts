import { extractCriteria, type CriterionResult, type Ticket } from '@sentinelqa/core';

/** Jira Cloud REST v3 with an API token. Credentials stay in the server's .env. */
export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
  readyStatus: string;
  /** Field that holds acceptance criteria, when it is not in the description. */
  criteriaField?: string;
}

export function jiraConfigFromEnv(env = process.env): JiraConfig | null {
  if (!env.JIRA_BASE_URL || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN) return null;
  return {
    baseUrl: env.JIRA_BASE_URL.replace(/\/$/, ''),
    email: env.JIRA_EMAIL,
    token: env.JIRA_API_TOKEN,
    readyStatus: env.JIRA_READY_STATUS ?? 'Ready for QA',
    criteriaField: env.JIRA_CRITERIA_FIELD || undefined,
  };
}

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}

const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'tableRow']);

/** Atlassian Document Format to plain text, one block per line, list items as "- ". */
export function adfToText(node: AdfNode | string | null | undefined): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const out: string[] = [];
  const walk = (n: AdfNode, parent: string) => {
    if (n.type === 'text') {
      out[out.length - 1] = (out.at(-1) ?? '') + (n.text ?? '');
      return;
    }
    if (n.type === 'hardBreak') {
      out.push('');
      return;
    }
    // The first paragraph of a list item continues its "- " line.
    if (n.type === 'listItem') out.push('- ');
    else if (BLOCKS.has(n.type) && !(parent === 'listItem' && out.at(-1) === '- ')) out.push('');
    for (const c of n.content ?? []) walk(c, n.type);
  };
  walk(node, '');
  return out.filter((l) => l.trim() && l.trim() !== '-').join('\n');
}

function auth(cfg: JiraConfig) {
  return { authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}`, accept: 'application/json' };
}

export async function fetchIssue(cfg: JiraConfig, key: string): Promise<Ticket> {
  const fields = ['summary', 'description', 'status', ...(cfg.criteriaField ? [cfg.criteriaField] : [])].join(',');
  const res = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`, { headers: auth(cfg) });
  if (!res.ok) throw new Error(`Jira ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const issue = (await res.json()) as { key: string; fields: Record<string, any> };
  const description = adfToText(issue.fields.description);
  const criteriaText = cfg.criteriaField ? adfToText(issue.fields[cfg.criteriaField]) : description;
  return {
    key: issue.key,
    title: issue.fields.summary ?? issue.key,
    status: issue.fields.status?.name ?? 'Unknown',
    description,
    criteria: extractCriteria(criteriaText),
    source: 'jira',
  };
}

const ICON: Record<string, string> = { PASS: '✅', HEALED: '🩹', NEEDS_REVIEW: '🟡', REGRESSION: '❌', FLAKY: '🔁', ERROR: '⚠️' };

/** Posts the run's verdicts back to the ticket as an ADF comment. */
export async function postRunComment(cfg: JiraConfig, key: string, runId: number, results: CriterionResult[], dashboardUrl?: string) {
  const items = results.map((r) => ({
    type: 'listItem',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: `${ICON[r.verdict] ?? ''} ${r.criterion} ${r.verdict}`, marks: [{ type: 'strong' }] },
          { type: 'text', text: ` (${r.rule}): ${r.reason.slice(0, 300)}` },
        ],
      },
    ],
  }));
  const content: unknown[] = [
    { type: 'paragraph', content: [{ type: 'text', text: `SentinelQA run #${runId}`, marks: [{ type: 'strong' }] }] },
    { type: 'bulletList', content: items },
  ];
  if (dashboardUrl) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: 'Heal ledger and screenshots', marks: [{ type: 'link', attrs: { href: `${dashboardUrl}#/runs/${runId}` } }] }] });
  }
  const res = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    headers: { ...auth(cfg), 'content-type': 'application/json' },
    body: JSON.stringify({ body: { type: 'doc', version: 1, content } }),
  });
  if (!res.ok) throw new Error(`Jira comment on ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** Pulls the issue key and new status out of a Jira "issue updated" webhook. */
export function readWebhook(body: any): { key: string; status: string | null } | null {
  const key = body?.issue?.key;
  if (!key) return null;
  const change = (body?.changelog?.items ?? []).find((i: any) => i.field === 'status');
  return { key, status: change?.toString ?? body?.issue?.fields?.status?.name ?? null };
}

/** Checks the credentials and returns who they belong to. */
export async function jiraWhoAmI(cfg: Pick<JiraConfig, 'baseUrl' | 'email' | 'token'>): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/rest/api/3/myself`, { headers: auth(cfg as JiraConfig) });
  if (res.status === 401 || res.status === 403) throw new Error('Jira refused the email and API token');
  if (!res.ok) throw new Error(`Jira answered ${res.status}; is ${cfg.baseUrl} a Jira Cloud site?`);
  const me = (await res.json()) as { displayName?: string; emailAddress?: string };
  return me.displayName ?? me.emailAddress ?? cfg.email;
}

/** One arena run, as a comment on the ticket: the verdict, each criterion, where it ran and the replay. */
export async function postArenaComment(
  cfg: JiraConfig,
  key: string,
  run: { id: number; conclusion: string; title: string; where: string; criteria: { criterion: string; verdict: string; rule: string }[]; fixerRewrote: string[]; replayUrl?: string },
) {
  const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
  const para = (...content: unknown[]) => ({ type: 'paragraph', content });
  const head = run.conclusion === 'success' ? '✅' : run.conclusion === 'failure' ? '❌' : '🟡';
  const content: unknown[] = [
    para(text(`${head} SentinelQA: ${run.title}`, [{ type: 'strong' }])),
    para(text(`Run #${run.id} on ${run.where}`)),
  ];
  if (run.criteria.length) {
    content.push({
      type: 'bulletList',
      content: run.criteria.map((c) => ({ type: 'listItem', content: [para(text(`${ICON[c.verdict] ?? ''} ${c.criterion} ${c.verdict}`, [{ type: 'strong' }]), text(` (${c.rule})`))] })),
    });
  }
  if (run.fixerRewrote.length) content.push(para(text(`For comparison, an LLM test-fixer went green on ${run.fixerRewrote.join(', ')} by rewriting the expected value.`)));
  if (run.replayUrl) content.push(para(text('Watch the replay', [{ type: 'link', attrs: { href: run.replayUrl } }])));
  const res = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    headers: { ...auth(cfg), 'content-type': 'application/json' },
    body: JSON.stringify({ body: { type: 'doc', version: 1, content } }),
  });
  if (!res.ok) throw new Error(`Jira comment on ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}
