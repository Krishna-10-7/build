import type { Page, Request, Response } from 'playwright';
import type { EffectSignature } from '@sentinelqa/core';

/** Calls that change on every run or carry no behaviour. */
const IGNORED = [/^\/api\/analytics\b/, /\/(collect|beacon|telemetry)\b/];

export function normalizePath(path: string): string {
  return path
    .split('?')[0]
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) ? ':id' : seg))
    .join('/');
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export interface ObservedResponse {
  method: string;
  path: string;
  status: number;
}

/**
 * Watches API traffic on a page. Each action step reads what happened between
 * mark() and settle().
 */
export class TrafficRecorder {
  private inflight = new Set<Request>();
  private lastChange = Date.now();
  readonly all: ObservedResponse[] = [];
  private cursor = 0;

  constructor(private page: Page) {
    page.on('request', (r) => {
      if (!this.tracked(r)) return;
      this.inflight.add(r);
      this.lastChange = Date.now();
    });
    const done = (r: Request) => {
      if (this.inflight.delete(r)) this.lastChange = Date.now();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    page.on('response', (res: Response) => {
      const r = res.request();
      if (!this.tracked(r)) return;
      this.all.push({ method: r.method(), path: normalizePath(new URL(r.url()).pathname), status: res.status() });
    });
  }

  private tracked(r: Request): boolean {
    const type = r.resourceType();
    if (type !== 'fetch' && type !== 'xhr') return false;
    const path = new URL(r.url()).pathname;
    return !IGNORED.some((re) => re.test(path));
  }

  mark(): void {
    this.cursor = this.all.length;
  }

  since(): ObservedResponse[] {
    return this.all.slice(this.cursor);
  }

  /** Waits until no tracked request has been open for `quietMs`, up to `maxMs`. */
  async settle(quietMs = 250, maxMs = 4000): Promise<void> {
    const start = Date.now();
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    while (Date.now() - start < maxMs) {
      if (this.inflight.size === 0 && Date.now() - this.lastChange >= quietMs) return;
      await this.page.waitForTimeout(50);
    }
  }
}

export function signatureLine(r: ObservedResponse): string {
  return `${r.method} ${r.path} ${statusClass(r.status)}`;
}

export function urlPath(page: Page): string {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return '';
  }
}

export interface EffectComparison {
  match: boolean;
  /** Nothing observable happened in the baseline, so a heal cannot be verified. */
  unverifiable: boolean;
  detail: string;
}

export function hasObservableEffect(e: EffectSignature): boolean {
  return e.requests.length > 0 || e.urlBefore !== e.urlAfter || Object.values(e.watched).some((w) => w.before !== w.after);
}

/**
 * Same action, same effect: the step must cause the same API calls (method, path
 * with ids as :id, status class), the same URL change, and the same change in
 * watched elements. Watched elements that cannot be read now are skipped.
 */
export function compareEffects(expected: EffectSignature, observed: EffectSignature): EffectComparison {
  if (!hasObservableEffect(expected)) {
    return { match: false, unverifiable: true, detail: 'the baseline step had no observable effect' };
  }
  const problems: string[] = [];
  const exp = [...new Set(expected.requests)].sort();
  const obs = [...new Set(observed.requests)].sort();
  const missing = exp.filter((r) => !obs.includes(r));
  const extra = obs.filter((r) => !exp.includes(r));
  if (missing.length) problems.push(`expected ${missing.join(', ')}; observed ${obs.length ? obs.join(', ') : 'none'}`);
  else if (extra.length) problems.push(`unexpected ${extra.join(', ')}`);
  if (expected.urlAfter !== observed.urlAfter) problems.push(`URL ${observed.urlBefore} -> ${observed.urlAfter}, expected -> ${expected.urlAfter}`);
  for (const [key, w] of Object.entries(expected.watched)) {
    const now = observed.watched[key];
    if (!now || now.before === '<missing>' || now.after === '<missing>') continue;
    const changedBefore = w.before !== w.after;
    const changedNow = now.before !== now.after;
    if (changedBefore !== changedNow || (changedBefore && now.after !== w.after)) {
      problems.push(`${key} ${now.before} -> ${now.after}, expected ${w.before} -> ${w.after}`);
    }
  }
  if (problems.length) return { match: false, unverifiable: false, detail: `mismatch: ${problems.join('; ')}` };
  const parts = [...exp];
  if (expected.urlBefore !== expected.urlAfter) parts.push(`URL -> ${expected.urlAfter}`);
  for (const [key, w] of Object.entries(expected.watched)) if (w.before !== w.after) parts.push(`${key} ${w.before} -> ${w.after}`);
  return { match: true, unverifiable: false, detail: `match: ${parts.join(', ')}` };
}
