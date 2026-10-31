#!/usr/bin/env node
// SentinelQA command line. One file, no dependencies, Node 18 or newer.
//
//   curl -fsSL __SENTINELQA_URL__cli/sentinelqa.mjs -o sentinelqa.mjs
//   node sentinelqa.mjs login --token sqa_...
//   node sentinelqa.mjs check owner/repo --ref main
//
// Exit codes: 0 pass, 1 regression, 2 needs review, 3 inconclusive or still running, 4 usage or auth error.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_URL = '__SENTINELQA_URL__';
const CONFIG = join(process.env.SENTINELQA_CONFIG_DIR || join(homedir(), '.sentinelqa'), 'config.json');

const HELP = `sentinelqa: check a build against its tickets' acceptance criteria

  login --token <sqa_...> [--url <server>]   save credentials to ${CONFIG}
  projects                                   floors of the building: demo and connected repos
  check <project> [--ref <branch>] [--scenario <id>] [--wait <s>]
                                             run a check and wait for the verdicts
  commit <owner/repo> <sha> [--wait <s>]     result of the check a push started
  result <run-id> [--wait <s>]               verdicts of a run
  runs [project]                             recent runs
  criteria [ticket]                          acceptance criteria being checked
  mcp                                        MCP server on stdio (bridges to the HTTP one)

  --json prints the full result. SENTINELQA_URL and SENTINELQA_TOKEN override the saved login.
  Exit: 0 pass, 1 regression, 2 needs review, 3 inconclusive or not finished, 4 usage or auth error.`;

const BOOLEAN = new Set(['json', 'no-wait', 'help']);

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (!BOOLEAN.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function config() {
  const saved = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
  let url = process.env.SENTINELQA_URL || saved.url || DEFAULT_URL;
  if (url.includes('__SENTINELQA')) url = 'http://localhost:4200/';
  return { url: url.endsWith('/') ? url : `${url}/`, token: process.env.SENTINELQA_TOKEN || saved.token || '' };
}

function die(msg, code = 4) {
  process.stderr.write(`sentinelqa: ${msg}\n`);
  process.exit(code);
}

async function api(path, init = {}) {
  const { url, token } = config();
  const res = await fetch(new URL(path, url), {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  }).catch((e) => die(`cannot reach ${url}: ${e.message}`));
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) die('not logged in or the token was revoked; run: sentinelqa login --token sqa_...');
  if (res.status === 403) die(body.error || 'this token cannot do that');
  if (!res.ok) die(body.error || `${res.status} ${res.statusText}`, res.status === 404 ? 3 : 4);
  return body;
}

const EXIT = { success: 0, failure: 1, action_required: 2, neutral: 3 };

function show(r, flags) {
  if (flags.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    const head = r.done ? `${r.conclusion.toUpperCase()}  ${r.title}` : `${r.status.toUpperCase()}  run #${r.id} has not finished`;
    const lines = [head, `run #${r.id} · ${r.project} · ${r.label || 'preparing'} · ticket ${r.ticket}`];
    if (r.error) lines.push(`error: ${r.error}`);
    for (const c of r.criteria) {
      const healed = c.heals.filter((h) => h.decision === 'accepted').map((h) => h.key);
      lines.push(`  ${c.id}  ${c.verdict.padEnd(12)} ${c.rule}${healed.length ? `  healed ${healed.join(', ')}` : ''}`);
    }
    const rewrote = r.fixer.filter((f) => f.rewroteAssertion).map((f) => f.criterion);
    if (rewrote.length) lines.push(`  (an LLM test-fixer would have rewritten the assertion of ${rewrote.join(', ')} to go green)`);
    if (r.criteria.some((c) => c.verdict === 'REGRESSION')) lines.push('Fix the application code. Editing the test or its expected values does not count.');
    if (r.watchUrl) lines.push(`watch: ${r.watchUrl}`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  process.exit(r.done ? (EXIT[r.conclusion] ?? 3) : 3);
}

/** Long runs: ask in slices of up to 60 s until done or the deadline. */
async function follow(id, seconds) {
  const until = Date.now() + seconds * 1000;
  let r = await api(`api/agent/checks/${id}`);
  while (!r.done && Date.now() < until) {
    if (process.stderr.isTTY) process.stderr.write(`  run #${id}: ${r.status}…\n`);
    r = await api(`api/agent/checks/${id}?wait=${Math.min(60, Math.ceil((until - Date.now()) / 1000))}`);
  }
  return r;
}

async function mcp() {
  const { url, token } = config();
  const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    try {
      const res = await fetch(new URL('mcp', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(msg),
      });
      if (res.status === 202) return;
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: body?.error || `server answered ${res.status}` } });
        return;
      }
      for (const m of Array.isArray(body) ? body : [body]) out(m);
    } catch (e) {
      if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `cannot reach ${url}: ${e.message}` } });
    }
  });
}

const { pos, flags } = parse(process.argv.slice(2));
const [cmd, ...args] = pos;
const wait = Number(flags.wait ?? 300);

switch (cmd) {
  case 'login': {
    const token = typeof flags.token === 'string' ? flags.token : '';
    if (!token.startsWith('sqa_')) die('usage: sentinelqa login --token sqa_... [--url https://host/sentinel/]');
    const url = typeof flags.url === 'string' ? flags.url : config().url;
    mkdirSync(join(CONFIG, '..'), { recursive: true });
    writeFileSync(CONFIG, JSON.stringify({ url, token }, null, 2), { mode: 0o600 });
    try {
      chmodSync(CONFIG, 0o600);
    } catch {
      // Windows keeps its own ACLs
    }
    process.env.SENTINELQA_URL = url;
    process.env.SENTINELQA_TOKEN = token;
    const floors = await api('api/agent/projects');
    process.stdout.write(`logged in to ${url} · ${floors.length} project${floors.length === 1 ? '' : 's'}\nsaved ${CONFIG}\n`);
    break;
  }
  case 'projects': {
    const floors = await api('api/agent/projects');
    if (flags.json) process.stdout.write(JSON.stringify(floors, null, 2) + '\n');
    else
      for (const f of floors)
        process.stdout.write(`${String(f.n).padStart(2)}  ${f.id.padEnd(34)} ${f.live ? 'RUNNING' : f.last ? `${(f.last.conclusion ?? f.last.status).toUpperCase()} ${f.last.title ?? ''}` : 'no runs yet'}\n`);
    break;
  }
  case 'check': {
    if (!args[0]) die('usage: sentinelqa check <project> [--ref <branch>] [--scenario <id>]');
    const body = { project: args[0], ref: typeof flags.ref === 'string' ? flags.ref : undefined, scenario: typeof flags.scenario === 'string' ? flags.scenario : undefined };
    const started = await api('api/agent/checks', { method: 'POST', body: JSON.stringify(body) });
    process.stderr.write(`queued run #${started.id}${started.watchUrl ? ` · watch ${started.watchUrl}` : ''}\n`);
    show(flags['no-wait'] ? started : await follow(started.id, wait), flags);
    break;
  }
  case 'commit': {
    const [repo, sha] = args;
    if (!repo || !sha) die('usage: sentinelqa commit <owner/repo> <sha>');
    const until = Date.now() + wait * 1000;
    let r = null;
    while (!r && Date.now() < until) {
      const { url, token } = config();
      const res = await fetch(new URL(`api/agent/commits/${repo}/${sha}?wait=30`, url), { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (res.status === 401) die('not logged in; run: sentinelqa login --token sqa_...');
      if (res.ok) r = await res.json();
    }
    if (!r) die(`no run for ${repo}@${sha.slice(0, 7)}; is the repository connected and the commit pushed?`, 3);
    show(r.done ? r : await follow(r.id, Math.max(0, (until - Date.now()) / 1000)), flags);
    break;
  }
  case 'result': {
    if (!args[0]) die('usage: sentinelqa result <run-id>');
    show(await follow(Number(args[0]), flags.wait === undefined ? 0 : wait), flags);
    break;
  }
  case 'runs': {
    const runs = await api(`api/agent/runs${args[0] ? `?project=${encodeURIComponent(args[0])}` : ''}`);
    if (flags.json) process.stdout.write(JSON.stringify(runs, null, 2) + '\n');
    else for (const r of runs) process.stdout.write(`#${String(r.id).padEnd(4)} ${(r.conclusion ?? r.status).padEnd(15)} ${r.label}  ${r.title ?? ''}\n`);
    break;
  }
  case 'criteria': {
    const t = await api(`api/tickets/${args[0] || 'SHOP-42'}`);
    const list = t.contract?.criteria ?? t.ticket.criteria;
    process.stdout.write(`${t.ticket.key}  ${t.ticket.title}\n${list.map((c) => `  ${c.id}: ${c.text}`).join('\n')}\n`);
    break;
  }
  case 'mcp':
    await mcp();
    break;
  case undefined:
  case 'help':
  case '--help':
    process.stdout.write(HELP + '\n');
    break;
  default:
    die(`unknown command ${cmd}\n\n${HELP}`);
}
