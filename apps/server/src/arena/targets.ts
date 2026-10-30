import { spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { Target } from './channel.ts';

export const TargetSpec = z.discriminatedUnion('kind', [
  /** The bundled demo store with mutation flags. */
  z.object({ kind: z.literal('shoplite'), mutations: z.array(z.string()).default([]) }),
  /** Any public deployment. Its suite must already have a baseline. */
  z.object({ kind: z.literal('url'), baseUrl: z.string().url() }),
  /**
   * A repository from the operator's registry at a branch. A request only picks the
   * registry id and the ref; the repository URL and its commands never come from a request.
   */
  z.object({ kind: z.literal('repo'), id: z.string().regex(/^[\w-]+$/), ref: z.string().regex(/^[\w][\w./-]*$/).default('main') }),
]);
export type TargetSpec = z.infer<typeof TargetSpec>;

/** Operator-maintained list of repositories the arena may run (ARENA_REPOS_FILE, a JSON array). */
export const RepoEntry = z.object({
  id: z.string().regex(/^[\w-]+$/),
  title: z.string(),
  repo: z.string().url(),
  install: z.string(),
  start: z.string(),
  port: z.number().int().min(1024).max(65535),
  /** Branches offered in the arena controls. */
  refs: z.array(z.string()).default(['main']),
  /** What each branch really is, revealed on the scoreboard after an episode. */
  truth: z.record(z.string(), z.enum(['drift', 'regression', 'no change'])).default({}),
});
export type RepoEntry = z.infer<typeof RepoEntry>;

export function loadRepoRegistry(file: string | undefined): RepoEntry[] {
  if (!file || !existsSync(file)) return [];
  return z.array(RepoEntry).parse(JSON.parse(readFileSync(file, 'utf8')));
}

export interface ResolvedTarget extends Target {
  label: string;
  /** Stops anything the target started. */
  dispose(): Promise<void>;
}

const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^::1$/, /^f[cd]/i, /^fe80/i];

/** Browsing a URL from the server must not reach its own private network. */
async function assertPublic(url: string) {
  if (process.env.ARENA_ALLOW_PRIVATE === '1') return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some((a) => PRIVATE.some((re) => re.test(a)))) throw new Error(`${host} resolves to a private address; only public URLs can be tested`);
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: (line: string) => void, shell = false): ChildProcess {
  // Own process group on Linux, so the whole tree (shell, npm, node) can be stopped together.
  const child = spawn(cmd, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const pipe = (buf: Buffer) => buf.toString().split(/\r?\n/).filter(Boolean).forEach((l) => log(l.slice(0, 200)));
  child.stdout?.on('data', pipe);
  child.stderr?.on('data', pipe);
  return child;
}

function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

function done(child: ChildProcess, what: string): Promise<void> {
  return new Promise((resolve, reject) => child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${what} exited with ${code}`)))));
}

async function waitForHttp(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fetch(url).then(() => true).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not respond within ${ms / 1000}s`);
}

export async function resolveTarget(spec: TargetSpec, opts: { shopliteUrl: string; workDir: string; repos: RepoEntry[]; log: (line: string) => void }): Promise<ResolvedTarget> {
  if (spec.kind === 'shoplite') {
    return { baseURL: opts.shopliteUrl, mutations: spec.mutations, label: `ShopLite${spec.mutations.length ? ` + ${spec.mutations.join(', ')}` : ''}`, dispose: async () => {} };
  }
  if (spec.kind === 'url') {
    await assertPublic(spec.baseUrl);
    return { baseURL: spec.baseUrl, mutations: [], label: spec.baseUrl, dispose: async () => {} };
  }

  const repo = opts.repos.find((r) => r.id === spec.id);
  if (!repo) throw new Error(`unknown repository id ${spec.id}`);
  if (!repo.refs.includes(spec.ref)) throw new Error(`${spec.ref} is not an allowed branch for ${repo.id}`);
  const dir = join(opts.workDir, `${repo.id}@${spec.ref.replace(/\//g, '_')}`);
  await mkdir(opts.workDir, { recursive: true });
  const env = { ...process.env, PORT: String(repo.port), CI: '1' };
  // git gets its arguments as an array, never through a shell.
  if (!existsSync(join(dir, '.git'))) {
    opts.log(`$ git clone --depth 1 --branch ${spec.ref} ${repo.repo}`);
    await done(run('git', ['clone', '--depth', '1', '--branch', spec.ref, repo.repo, dir], opts.workDir, env, opts.log), 'git clone');
  } else {
    opts.log(`$ git fetch --depth 1 origin ${spec.ref} && git checkout FETCH_HEAD`);
    await done(run('git', ['fetch', '--depth', '1', 'origin', spec.ref], dir, env, opts.log), 'git fetch');
    await done(run('git', ['checkout', '-q', 'FETCH_HEAD'], dir, env, opts.log), 'git checkout');
  }
  // install and start are the operator's commands from the registry file.
  opts.log(`$ ${repo.install}`);
  await done(run(repo.install, [], dir, env, opts.log, true), 'install');
  opts.log(`$ ${repo.start}  (PORT=${repo.port})`);
  const app = run(repo.start, [], dir, env, opts.log, true);
  const baseURL = `http://127.0.0.1:${repo.port}`;
  try {
    await waitForHttp(baseURL, 90_000);
  } catch (err) {
    killTree(app);
    throw err;
  }
  return { baseURL, mutations: [], label: `${repo.title} @ ${spec.ref}`, dispose: async () => killTree(app) };
}
