import { spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { Target } from './channel.ts';
import { guardPage } from './guard.ts';

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

/**
 * A commit of a repository connected through the GitHub App. Never parsed from a request body:
 * only the webhook handler and the token-protected "run now" route build one.
 */
export interface GithubTarget {
  kind: 'github';
  /** owner/name */
  repo: string;
  ref: string;
  sha: string;
  /** Public repositories are fetched without a token. */
  private: boolean;
  /** From the repository's sentinelqa.json, or the defaults. */
  install: string;
  start: string;
}

export type AnyTarget = TargetSpec | GithubTarget;

export interface ResolvedTarget extends Target {
  label: string;
  /** Stops anything the target started. */
  dispose(): Promise<void>;
}

const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^::1$/, /^f[cd]/i, /^fe80/i];

/** Browsing a URL from the server must not reach its own private network. */
export async function assertPublic(url: string) {
  if (process.env.ARENA_ALLOW_PRIVATE === '1') return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some((a) => PRIVATE.some((re) => re.test(a)))) throw new Error(`${host} resolves to a private address; only public URLs can be tested`);
}

/** Only what a build needs. The server's secrets (LLM key, presenter token, GitHub App key) stay out. */
const PASS_ENV = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'SystemRoot', 'ComSpec', 'PATHEXT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
function buildEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PORT: String(port), CI: '1', npm_config_update_notifier: 'false' };
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * git reads the token from the environment, so it never shows up in the process list or a log line.
 * Credential helpers are switched off: a rejected fetch fails at once instead of waiting on a login prompt.
 */
function gitEnv(token: string | null): NodeJS.ProcessEnv {
  const config: [string, string][] = [['credential.helper', '']];
  if (token) config.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]);
  const env: NodeJS.ProcessEnv = { ...buildEnv(0), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_CONFIG_COUNT: String(config.length) };
  config.forEach(([k, v], i) => ((env[`GIT_CONFIG_KEY_${i}`] = k), (env[`GIT_CONFIG_VALUE_${i}`] = v)));
  return env;
}

interface Running {
  stop(): Promise<void>;
}

const INSTALL_MS = Number(process.env.SANDBOX_INSTALL_SECONDS ?? 360) * 1000;
const sandboxed = () => process.env.SANDBOX === 'podman';

/** Rejects after `ms`, running `onTimeout` first, when `p` takes longer. */
function within(p: Promise<void>, ms: number, what: string, onTimeout: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (onTimeout(), reject(new Error(`${what} took longer than ${ms / 1000}s`))), ms);
    p.then(
      () => (clearTimeout(t), resolve()),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

async function startApp(dir: string, install: string, start: string, port: number, log: (line: string) => void): Promise<Running> {
  if (sandboxed()) return startInPodman(dir, install, start, port, log);
  const env = buildEnv(port);
  log(`$ ${install}`);
  const inst = run(install, [], dir, env, log, true);
  await within(done(inst, 'install'), INSTALL_MS, 'install', () => killTree(inst));
  log(`$ ${start}  (PORT=${port})`);
  const app = run(start, [], dir, env, log, true);
  try {
    await waitForHttp(`http://127.0.0.1:${port}`, 90_000);
  } catch (err) {
    killTree(app);
    throw err;
  }
  return { stop: async () => killTree(app) };
}

/**
 * The repository's own commands run in a rootless Podman container: its own filesystem with only the
 * checkout mounted, no capabilities, memory, CPU and process limits, no route to this machine's
 * loopback, and none of the server's environment. Only the app's port is published, on loopback.
 */
async function startInPodman(dir: string, install: string, start: string, port: number, log: (line: string) => void): Promise<Running> {
  const image = process.env.SANDBOX_IMAGE ?? 'docker.io/library/node:22-bookworm-slim';
  const name = `sqa-${randomBytes(4).toString('hex')}`;
  const limits = process.env.SANDBOX_LIMITS === '0' ? [] : ['--memory', process.env.SANDBOX_MEMORY ?? '1536m', '--cpus', process.env.SANDBOX_CPUS ?? '1', '--pids-limit', '512'];
  const common = [
    '--rm',
    '--network', 'slirp4netns:allow_host_loopback=false',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,size=256m',
    '-v', `${dir}:/app`,
    '-w', '/app',
    '-e', 'HOME=/app/.sqa-home',
    '-e', 'CI=1',
    '-e', 'npm_config_update_notifier=false',
    '-e', 'npm_config_cache=/app/.sqa-home/.npm',
    ...limits,
  ];
  // Podman reaches the service user's own systemd manager through these.
  const env = { ...buildEnv(0), XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '', DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? '' };
  const rmForce = (n: string) => new Promise<void>((r) => spawn('podman', ['rm', '-f', '-t', '2', n], { env, stdio: 'ignore' }).on('exit', () => r()).on('error', () => r()));

  log(`$ ${install}   (sandboxed)`);
  const inst = run('podman', ['run', '--name', `${name}-install`, ...common, image, 'sh', '-c', install], dir, env, log);
  await within(done(inst, 'install'), INSTALL_MS, 'install', () => void rmForce(`${name}-install`));

  log(`$ ${start}  (PORT=${port}, sandboxed)`);
  const app = run('podman', ['run', '--name', name, ...common, '-p', `127.0.0.1:${port}:${port}`, '-e', `PORT=${port}`, image, 'sh', '-c', start], dir, env, log);
  try {
    await waitForHttp(`http://127.0.0.1:${port}`, 120_000);
  } catch (err) {
    await rmForce(name);
    throw err;
  }
  return { stop: () => rmForce(name) };
}

/** Removes containers a crash left behind. */
export async function cleanupSandboxes() {
  if (!sandboxed()) return;
  await new Promise<void>((r) => {
    const ls = spawn('podman', ['ps', '-a', '--filter', 'name=^sqa-', '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ls.stdout.on('data', (b) => (out += b));
    ls.on('error', () => r());
    ls.on('exit', () => {
      const names = out.split('\n').filter(Boolean);
      if (!names.length) return r();
      spawn('podman', ['rm', '-f', ...names], { stdio: 'ignore' }).on('exit', () => r()).on('error', () => r());
    });
  });
}

/** Keeps the checkouts under a size budget, dropping the least recently used ones first. */
async function pruneWorkDir(workDir: string, keep: string) {
  if (process.platform === 'win32') return;
  const budget = Number(process.env.ARENA_WORK_MAX_MB ?? 6000) * 1024;
  const dirs = await readdir(workDir).catch(() => [] as string[]);
  const sized = await Promise.all(
    dirs.map(async (d) => {
      const path = join(workDir, d);
      const size = await new Promise<number>((r) => {
        const du = spawn('du', ['-sk', path], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        du.stdout.on('data', (b) => (out += b));
        du.on('exit', () => r(Number(out.split('\t')[0]) || 0));
        du.on('error', () => r(0));
      });
      return { path, size, used: (await stat(path).catch(() => null))?.mtimeMs ?? 0 };
    }),
  );
  let total = sized.reduce((n, d) => n + d.size, 0);
  for (const d of sized.sort((a, b) => a.used - b.used)) {
    if (total <= budget) break;
    if (d.path === keep) continue;
    await rm(d.path, { recursive: true, force: true }).catch(() => {});
    total -= d.size;
  }
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

export interface ResolveOpts {
  shopliteUrl: string;
  workDir: string;
  repos: RepoEntry[];
  log: (line: string) => void;
  /** Installation token for a connected repository, or null for a public one. */
  githubToken?: (repo: string) => Promise<string | null>;
  githubPort?: number;
}

export async function resolveTarget(spec: AnyTarget, opts: ResolveOpts): Promise<ResolvedTarget> {
  const t = await resolveBare(spec, opts);
  return { ...t, guard: (page) => guardPage(page, t.baseURL) };
}

async function resolveBare(spec: AnyTarget, opts: ResolveOpts): Promise<ResolvedTarget> {
  if (spec.kind === 'shoplite') {
    return { baseURL: opts.shopliteUrl, mutations: spec.mutations, label: `ShopLite${spec.mutations.length ? ` + ${spec.mutations.join(', ')}` : ''}`, dispose: async () => {} };
  }
  if (spec.kind === 'url') {
    await assertPublic(spec.baseUrl);
    return { baseURL: spec.baseUrl, mutations: [], label: spec.baseUrl, dispose: async () => {} };
  }
  await mkdir(opts.workDir, { recursive: true });

  if (spec.kind === 'github') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(spec.repo) || !/^[0-9a-f]{40}$/.test(spec.sha)) throw new Error('bad repository or commit');
    const dir = join(opts.workDir, `gh-${spec.repo.replace('/', '__')}`);
    const env = gitEnv(spec.private ? ((await opts.githubToken?.(spec.repo)) ?? null) : null);
    if (!existsSync(join(dir, '.git'))) {
      await mkdir(dir, { recursive: true });
      await done(run('git', ['init', '-q'], dir, env, opts.log), 'git init');
      await done(run('git', ['remote', 'add', 'origin', `https://github.com/${spec.repo}.git`], dir, env, opts.log), 'git remote');
    }
    opts.log(`$ git fetch --depth 1 origin ${spec.sha.slice(0, 7)}  (${spec.ref})`);
    await done(run('git', ['fetch', '-q', '--depth', '1', 'origin', spec.sha], dir, env, opts.log), 'git fetch');
    await done(run('git', ['checkout', '-qf', 'FETCH_HEAD'], dir, env, opts.log), 'git checkout');
    await done(run('git', ['clean', '-fdq'], dir, env, opts.log), 'git clean');
    await utimes(dir, new Date(), new Date()).catch(() => {});
    const port = opts.githubPort ?? 8472;
    const app = await startApp(dir, spec.install, spec.start, port, opts.log);
    return {
      baseURL: `http://127.0.0.1:${port}`,
      mutations: [],
      label: `${spec.repo} @ ${spec.ref} (${spec.sha.slice(0, 7)})`,
      dispose: async () => {
        await app.stop();
        void pruneWorkDir(opts.workDir, dir);
      },
    };
  }

  const repo = opts.repos.find((r) => r.id === spec.id);
  if (!repo) throw new Error(`unknown repository id ${spec.id}`);
  if (!repo.refs.includes(spec.ref)) throw new Error(`${spec.ref} is not an allowed branch for ${repo.id}`);
  const dir = join(opts.workDir, `${repo.id}@${spec.ref.replace(/\//g, '_')}`);
  const env = gitEnv(null);
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
  const app = await startApp(dir, repo.install, repo.start, repo.port, opts.log);
  return { baseURL: `http://127.0.0.1:${repo.port}`, mutations: [], label: `${repo.title} @ ${spec.ref}`, dispose: () => app.stop() };
}
