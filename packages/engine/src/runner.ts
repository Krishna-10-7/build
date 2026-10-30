import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import type { Criterion, EffectSignature, Expect, ExpectResult, Fingerprint, LocatorEntry, LocatorMap, Step } from '@sentinelqa/core';
import { newContext } from './browser.ts';
import { fingerprintOf, resolve, type Resolution } from './locate.ts';
import { TrafficRecorder, signatureLine, urlPath, normalizePath } from './effects.ts';
import type { UseKind } from './ground.ts';

export interface UnresolvedKey {
  page: Page;
  key: string;
  intent: string;
  kind: UseKind;
  criterion: string;
  step: number;
  resolution: Resolution;
}

export interface RunHooks {
  /** A key did not resolve to exactly one element. Return a locator to try for this run, or null. */
  onUnresolved?: (u: UnresolvedKey) => Promise<LocatorEntry | null>;
}

export interface Failure {
  kind: 'missing' | 'ambiguous' | 'action' | 'expect' | 'navigation' | 'crash';
  detail: string;
  key?: string;
  step?: number;
}

export interface CriterionRun {
  criterion: string;
  ok: boolean;
  failure?: Failure;
  /** Effect of each action step, keyed by step index. */
  effects: Record<number, EffectSignature>;
  expects: ExpectResult[];
  /** Locator each key was found with in this run, including temporary heal patches. */
  used: Record<string, LocatorEntry>;
  /** Keys whose locator came from onUnresolved instead of the locator map. */
  substituted: Record<string, { step: number; entry: LocatorEntry }>;
  fingerprints: Record<string, Fingerprint>;
  screenshots: string[];
  durationMs: number;
}

export interface RunConfig {
  baseURL: string;
  mutations?: string[];
  /** Folder for screenshots; none are taken when unset. */
  artifactsDir?: string;
  label?: string;
}

const EXPECT_TIMEOUT_MS = Number(process.env.EXPECT_TIMEOUT_MS ?? 2500);
const CRITERION_TIMEOUT_MS = Number(process.env.CRITERION_TIMEOUT_MS ?? 60_000);

function watchedKeys(c: Criterion): string[] {
  return [...new Set(c.expect.flatMap((e) => ('key' in e ? [e.key] : [])))];
}

class KeyLookup {
  constructor(
    private page: Page,
    private locators: LocatorMap,
    private c: Criterion,
    private hooks: RunHooks,
    private out: CriterionRun,
  ) {}

  /** Current text of a key without healing, for watched elements. */
  async peek(key: string): Promise<string> {
    const entry = this.out.used[key] ?? this.locators[key];
    if (!entry) return '<missing>';
    const r = await resolve(this.page, entry);
    if (r.status !== 'found') return '<missing>';
    // Long numbers are order ids or timestamps; they differ on every run.
    return ((await r.locator.textContent()) ?? '').replace(/\s+/g, ' ').trim().replace(/\d{4,}/g, '#');
  }

  async find(key: string, intent: string, kind: UseKind, step: number, waitMs = 0): Promise<Locator | Failure> {
    const entry = this.out.used[key] ?? this.locators[key];
    let r: Resolution = { status: 'missing' };
    if (entry) {
      const until = Date.now() + waitMs;
      do {
        r = await resolve(this.page, entry);
        if (r.status === 'found') break;
        if (Date.now() < until) await this.page.waitForTimeout(150);
      } while (Date.now() < until);
    }
    if (r.status === 'found') {
      this.out.used[key] = entry!;
      await this.remember(key, r.locator);
      return r.locator;
    }
    const patch = this.hooks.onUnresolved
      ? await this.hooks.onUnresolved({ page: this.page, key, intent, kind, criterion: this.c.id, step, resolution: r })
      : null;
    if (patch) {
      const again = await resolve(this.page, patch);
      if (again.status === 'found') {
        this.out.used[key] = patch;
        this.out.substituted[key] = { step, entry: patch };
        await this.remember(key, again.locator);
        return again.locator;
      }
    }
    return r.status === 'ambiguous'
      ? { kind: 'ambiguous', key, step, detail: `${key} matches ${r.count} elements` }
      : { kind: 'missing', key, step, detail: `${key} (${intent}) not found` };
  }

  private async remember(key: string, loc: Locator) {
    if (!this.out.fingerprints[key]) this.out.fingerprints[key] = await fingerprintOf(loc);
  }
}

function isFailure(x: unknown): x is Failure {
  return typeof x === 'object' && x !== null && 'kind' in x && 'detail' in x;
}

async function checkExpect(e: Expect, page: Page, keys: KeyLookup, traffic: TrafficRecorder, stepCount: number): Promise<ExpectResult> {
  switch (e.type) {
    case 'text': {
      const loc = await keys.find(e.key, e.intent, 'read', stepCount, EXPECT_TIMEOUT_MS);
      if (isFailure(loc)) return { id: e.id, ok: false, detail: loc.detail };
      const until = Date.now() + EXPECT_TIMEOUT_MS;
      let text = '';
      do {
        text = ((await loc.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
        const ok = e.equals !== undefined ? text === e.equals : text.includes(e.contains ?? '');
        if (ok) return { id: e.id, ok: true, detail: `"${text}"` };
        await page.waitForTimeout(100);
      } while (Date.now() < until);
      const want = e.equals !== undefined ? `"${e.equals}"` : `text containing "${e.contains}"`;
      return { id: e.id, ok: false, detail: `${e.key} shows "${text}", expected ${want}` };
    }
    case 'visible': {
      const loc = await keys.find(e.key, e.intent, 'read', stepCount, EXPECT_TIMEOUT_MS);
      return isFailure(loc) ? { id: e.id, ok: false, detail: loc.detail } : { id: e.id, ok: true, detail: 'visible' };
    }
    case 'request': {
      const want = normalizePath(e.path);
      const hit = traffic.all.find((r) => r.method === e.method && r.path === want && r.status === e.status);
      if (hit) return { id: e.id, ok: true, detail: `${e.method} ${e.path} ${e.status}` };
      const seen = traffic.all.filter((r) => r.path === want).map((r) => `${r.method} ${r.status}`);
      return { id: e.id, ok: false, detail: `no ${e.method} ${e.path} ${e.status}${seen.length ? `; saw ${seen.join(', ')}` : ''}` };
    }
    case 'url': {
      const now = urlPath(page);
      return { id: e.id, ok: now === e.path, detail: now === e.path ? now : `at ${now}, expected ${e.path}` };
    }
  }
}

async function act(step: Step, loc: Locator): Promise<void> {
  if (step.do === 'click') await loc.click();
  else if (step.do === 'fill') await loc.fill(step.value);
}

/** Runs one criterion in a fresh browser context and records what every step caused. */
export async function runCriterion(c: Criterion, locators: LocatorMap, cfg: RunConfig, hooks: RunHooks = {}): Promise<CriterionRun> {
  const started = Date.now();
  const out: CriterionRun = {
    criterion: c.id,
    ok: false,
    effects: {},
    expects: [],
    used: {},
    substituted: {},
    fingerprints: {},
    screenshots: [],
    durationMs: 0,
  };
  const ctx = await newContext({ baseURL: cfg.baseURL, mutations: cfg.mutations });
  const page = await ctx.newPage();
  const traffic = new TrafficRecorder(page);
  const keys = new KeyLookup(page, locators, c, hooks, out);
  const watched = watchedKeys(c);
  // A crashed page or a stuck browser must end the criterion, not hang the queue.
  let aborted: string | null = null;
  const abort = (why: string) => {
    aborted ??= why;
    ctx.close().catch(() => {});
  };
  page.on('crash', () => abort('the page crashed (often low memory)'));
  const deadline = setTimeout(() => abort(`timed out after ${CRITERION_TIMEOUT_MS / 1000}s`), CRITERION_TIMEOUT_MS);

  try {
    for (let i = 0; i < c.steps.length; i++) {
      const step = c.steps[i];
      if (step.do === 'goto') {
        try {
          await page.goto(step.url);
          await traffic.settle();
        } catch (err) {
          out.failure = { kind: 'navigation', step: i, detail: `could not open ${step.url}: ${(err as Error).message.split('\n')[0]}` };
          break;
        }
        continue;
      }
      const loc = await keys.find(step.key, step.intent, step.do, i);
      if (isFailure(loc)) {
        out.failure = loc;
        break;
      }
      const before: Record<string, string> = {};
      for (const k of watched) before[k] = await keys.peek(k);
      const urlBefore = urlPath(page);
      traffic.mark();
      try {
        await act(step, loc);
      } catch (err) {
        out.failure = { kind: 'action', key: step.key, step: i, detail: `${step.do} on ${step.key} failed: ${(err as Error).message.split('\n')[0]}` };
        break;
      }
      await traffic.settle();
      const after: Record<string, string> = {};
      for (const k of watched) after[k] = await keys.peek(k);
      out.effects[i] = {
        requests: traffic.since().map(signatureLine),
        urlBefore,
        urlAfter: urlPath(page),
        watched: Object.fromEntries(watched.map((k) => [k, { before: before[k], after: after[k] }])),
      };
    }

    if (!out.failure) {
      for (const e of c.expect) out.expects.push(await checkExpect(e, page, keys, traffic, c.steps.length));
      const bad = out.expects.find((x) => !x.ok);
      if (bad) out.failure = { kind: 'expect', detail: `${bad.id}: ${bad.detail}` };
    }
    out.ok = !out.failure;

    if (cfg.artifactsDir) {
      await mkdir(cfg.artifactsDir, { recursive: true });
      const file = join(cfg.artifactsDir, `${cfg.label ?? 'run'}-${c.id}-${out.ok ? 'pass' : 'fail'}.png`);
      await page.screenshot({ path: file }).catch(() => {});
      out.screenshots.push(file);
    }
  } catch (err) {
    if (!aborted) throw err;
  } finally {
    clearTimeout(deadline);
    if (aborted) {
      out.ok = false;
      out.failure = { kind: 'crash', detail: aborted };
    }
    await ctx.close().catch(() => {});
    out.durationMs = Date.now() - started;
  }
  return out;
}

