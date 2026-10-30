/**
 * Mutation benchmark: every drift and regression in ShopLite, under four healing
 * modes, on the same suite and baseline. Writes bench/results/latest.json.
 *
 *   npm run bench                         all 20 mutations x 4 modes
 *   npm run bench -- --modes sentinel,plain --only D1,R4
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileTicket, loadEnv, parseTicketFile, type CriterionResult, type Verdict } from '@sentinelqa/core';
import { Suite, checkSuite, closeBrowser, recordBaseline, type HealMode } from '@sentinelqa/engine';
import { MUTATIONS } from '../apps/shoplite/src/mutations.ts';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
loadEnv();

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const MODES = (arg('modes')?.split(',') ?? ['none', 'plain', 'no-effect', 'sentinel']) as HealMode[];
const ONLY = arg('only')?.split(',');
const TICKET = arg('ticket') ?? 'SHOP-42';
const PORT = Number(arg('port') ?? process.env.BENCH_PORT ?? 4180);
const BASE = `http://localhost:${PORT}`;
const CONCURRENCY = Number(arg('workers') ?? process.env.WORKERS ?? 2);

async function up(): Promise<boolean> {
  return fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false);
}

async function startShopLite(): Promise<ChildProcess | null> {
  if (await up()) return null;
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/shoplite/src/server.ts'], { env: { ...process.env, SHOPLITE_PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });
  child.on('exit', (code) => console.error(`ShopLite exited with ${code}`));
  for (let i = 0; i < 150 && !(await up()); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await up())) throw new Error('ShopLite did not start');
  return child;
}

/** A dedicated suite so benchmark runs never touch the demo's locators. */
async function prepareSuite(): Promise<Suite> {
  const suite = Suite.at('data/bench', TICKET);
  if ((await suite.baseline()) && (await suite.verifySpec()).ok) return suite;
  const ticket = parseTicketFile(await readFile(`tickets/${TICKET}.md`, 'utf8'));
  const compiled = await compileTicket(ticket);
  console.log(`compiled ${TICKET} via ${compiled.source}`);
  await suite.saveContract(compiled.contract);
  await suite.generate();
  const rec = await recordBaseline(compiled.contract, {}, { baseURL: BASE });
  if (rec.runs.some((r) => !r.ok)) throw new Error(`baseline failed: ${rec.problems.join('; ')}`);
  await suite.saveLocators(rec.locators);
  await suite.saveBaseline(rec.baseline);
  return suite;
}

interface Cell {
  mutation: string;
  kind: 'drift' | 'regression';
  mode: HealMode;
  verdicts: Record<string, Verdict>;
  rules: Record<string, string>;
  /** Repairs the mode would write to locators.json. */
  acceptedHeals: number;
  reviewHeals: number;
  outcome: string;
  ms: number;
}

const FAILING: Verdict[] = ['REGRESSION', 'ERROR'];

function classify(kind: Cell['kind'], results: CriterionResult[], accepted: number): string {
  const vs = results.map((r) => r.verdict);
  if (kind === 'drift') {
    if (vs.some((v) => FAILING.includes(v))) return 'broken';
    return vs.includes('NEEDS_REVIEW') ? 'review' : vs.includes('HEALED') ? 'healed' : 'unaffected';
  }
  if (accepted > 0) return 'false-heal';
  return vs.some((v) => v === 'REGRESSION' || v === 'NEEDS_REVIEW') ? 'caught' : 'missed';
}

function summarize(cells: Cell[], mode: HealMode) {
  const mine = cells.filter((c) => c.mode === mode);
  const drifts = mine.filter((c) => c.kind === 'drift');
  const regs = mine.filter((c) => c.kind === 'regression');
  const healsOnDrift = drifts.reduce((n, c) => n + c.acceptedHeals, 0);
  const healsOnReg = regs.reduce((n, c) => n + c.acceptedHeals, 0);
  const times = mine.map((c) => c.ms).sort((a, b) => a - b);
  return {
    mode,
    driftHandled: drifts.filter((c) => c.outcome !== 'broken').length,
    driftAutoHealed: drifts.filter((c) => c.outcome === 'healed').length,
    drifts: drifts.length,
    regressionsCaught: regs.filter((c) => c.outcome === 'caught').length,
    falseHeals: regs.filter((c) => c.outcome === 'false-heal').length,
    regressions: regs.length,
    /** Accepted repairs that were on drifts, out of all accepted repairs. */
    healAccuracy: healsOnDrift + healsOnReg ? healsOnDrift / (healsOnDrift + healsOnReg) : null,
    medianSuiteMs: times[Math.floor(times.length / 2)] ?? 0,
  };
}

async function main() {
  const shop = await startShopLite();
  try {
    const suite = await prepareSuite();
    const mutations = MUTATIONS.filter((m) => !ONLY || ONLY.includes(m.id));
    const cells: Cell[] = [];
    for (const m of mutations) {
      for (const mode of MODES) {
        const t0 = Date.now();
        const out = await checkSuite(suite, { baseURL: BASE, mutations: [m.id], mode, retryOnFail: false, concurrency: CONCURRENCY, commit: false });
        const accepted = out.results.flatMap((r) => r.heals).filter((h) => h.decision === 'accepted').length;
        const cell: Cell = {
          mutation: m.id,
          kind: m.kind,
          mode,
          verdicts: Object.fromEntries(out.results.map((r) => [r.criterion, r.verdict])),
          rules: Object.fromEntries(out.results.map((r) => [r.criterion, r.rule])),
          acceptedHeals: accepted,
          reviewHeals: out.results.flatMap((r) => r.heals).filter((h) => h.decision === 'review').length,
          outcome: classify(m.kind, out.results, accepted),
          ms: Date.now() - t0,
        };
        cells.push(cell);
        console.log(`${m.id.padEnd(4)} ${mode.padEnd(10)} ${cell.outcome.padEnd(11)} ${Object.values(cell.verdicts).join(' ')}  (${(cell.ms / 1000).toFixed(1)} s)`);
      }
    }
    const summary = MODES.map((mode) => summarize(cells, mode));
    console.log('\nmode        drifts handled  auto-healed  regressions caught  false heals  heal accuracy');
    for (const s of summary) {
      const acc = s.healAccuracy === null ? '—' : `${Math.round(s.healAccuracy * 100)}%`;
      console.log(`${s.mode.padEnd(11)} ${`${s.driftHandled}/${s.drifts}`.padEnd(15)} ${`${s.driftAutoHealed}/${s.drifts}`.padEnd(12)} ${`${s.regressionsCaught}/${s.regressions}`.padEnd(19)} ${`${s.falseHeals}/${s.regressions}`.padEnd(12)} ${acc}`);
    }
    await mkdir('bench/results', { recursive: true });
    const report = { ticket: TICKET, at: new Date().toISOString(), target: BASE, mutations: MUTATIONS, summary, cells };
    await writeFile('bench/results/latest.json', JSON.stringify(report, null, 2));
    console.log('\nwrote bench/results/latest.json');
  } finally {
    await closeBrowser();
    shop?.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
