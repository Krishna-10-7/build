import { at } from '../api.ts';
import { useAsync } from '../components.tsx';

interface Rule {
  id: string;
  description: string;
  when: unknown;
  then: string;
}

interface PolicyDoc {
  name: string;
  version: number;
  description: string;
  facts: Record<string, string>;
  decisions: string[];
  rules: Rule[];
  otherwise: { id: string; description: string; then: string };
  sha256: string;
}

interface Policies {
  heal: PolicyDoc;
  verdict: PolicyDoc;
  pipeline: { stages: string[]; transitions: { action: string; from: string[]; to: string; why: string }[] };
}

/** Renders a rule condition as a short readable expression. */
function cond(c: any): string {
  if (c.all) return c.all.map(cond).join(' and ');
  if (c.any) return '(' + c.any.map(cond).join(' or ') + ')';
  if (c.not) return 'not ' + cond(c.not);
  const ops: [string, string][] = [
    ['eq', '='],
    ['ne', '≠'],
    ['gt', '>'],
    ['gte', '≥'],
    ['lt', '<'],
  ];
  for (const [k, sym] of ops) if (k in c) return `${c.fact} ${sym} ${JSON.stringify(c[k])}`;
  if ('in' in c) return `${c.fact} in ${JSON.stringify(c.in)}`;
  return c.fact;
}

const DECISION_CHIP: Record<string, string> = { accepted: 'HEALED', review: 'NEEDS_REVIEW', refused: 'REGRESSION' };

function PolicyTable({ p }: { p: PolicyDoc }) {
  return (
    <div className="card" style={{ padding: 0, marginBottom: 18 }}>
      <div style={{ padding: '14px 16px 4px' }}>
        <div className="spread">
          <strong>
            {p.name}@{p.version}
          </strong>
          <span className="mono small muted">sha256 {p.sha256.slice(0, 12)}</span>
        </div>
        <p className="small muted" style={{ margin: '4px 0 10px' }}>
          {p.description} Rules are checked top to bottom; the first that matches decides.
        </p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Rule</th>
            <th>When</th>
            <th>Then</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {[...p.rules, { ...p.otherwise, when: null }].map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.id}</td>
              <td className="mono small">{r.when ? cond(r.when) : 'otherwise'}</td>
              <td>
                <span className={`chip ${DECISION_CHIP[r.then] ?? r.then}`}>{r.then}</span>
              </td>
              <td className="small">{r.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PoliciesPage() {
  const { data, error } = useAsync(() => fetch(at('api/policies')).then((r) => r.json() as Promise<Policies>), []);
  if (error) return <div className="err">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div>
      <h1>Policies</h1>
      <p className="sub">Every heal and verdict is decided by these rules, kept as data in packages/core/src/policies. The ledger records which rule fired.</p>
      <PolicyTable p={data.heal} />
      <PolicyTable p={data.verdict} />
      <h2>Pipeline</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Allowed from</th>
              <th>Moves to</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            {data.pipeline.transitions.map((t) => (
              <tr key={t.action}>
                <td className="mono">{t.action}</td>
                <td className="small">{t.from.join(', ')}</td>
                <td className="small">{t.to}</td>
                <td className="small">{t.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface BenchReport {
  at: string;
  ticket: string;
  mutations: { id: string; kind: string; title: string }[];
  summary: {
    mode: string;
    driftHandled: number;
    driftAutoHealed: number;
    drifts: number;
    regressionsCaught: number;
    falseHeals: number;
    regressions: number;
    healAccuracy: number | null;
    medianSuiteMs: number;
  }[];
  cells: { mutation: string; mode: string; outcome: string; acceptedHeals: number; verdicts: Record<string, string> }[];
}

const MODE_LABEL: Record<string, string> = {
  none: 'No healing',
  plain: 'Plain similarity healer',
  'no-effect': 'SentinelQA without effect gate',
  sentinel: 'SentinelQA',
};

const OUTCOME_CHIP: Record<string, string> = {
  unaffected: 'PASS',
  healed: 'HEALED',
  review: 'NEEDS_REVIEW',
  broken: 'REGRESSION',
  caught: 'PASS',
  missed: 'NEEDS_REVIEW',
  'false-heal': 'REGRESSION',
};

export function BenchPage() {
  const { data, error } = useAsync(() => fetch(at('api/bench')).then(async (r) => (r.ok ? (r.json() as Promise<BenchReport>) : Promise.reject(new Error((await r.json()).error)))), []);
  if (error) return <div className="err">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  const modes = data.summary.map((s) => s.mode);
  return (
    <div>
      <h1>Benchmark</h1>
      <p className="sub">
        {data.ticket} against every ShopLite mutation, one at a time, recorded {new Date(data.at).toLocaleString()}. Numbers below come from that run only.
      </p>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Mode</th>
              <th>Drifts handled</th>
              <th>Auto-healed</th>
              <th>Regressions caught</th>
              <th>False heals</th>
              <th>Heal accuracy</th>
              <th>Median suite time</th>
            </tr>
          </thead>
          <tbody>
            {data.summary.map((s) => (
              <tr key={s.mode}>
                <td>
                  <strong>{MODE_LABEL[s.mode] ?? s.mode}</strong>
                </td>
                <td>
                  {s.driftHandled}/{s.drifts}
                </td>
                <td>
                  {s.driftAutoHealed}/{s.drifts}
                </td>
                <td>
                  {s.regressionsCaught}/{s.regressions}
                </td>
                <td style={{ color: s.falseHeals ? 'var(--fail)' : 'var(--pass)', fontWeight: 600 }}>
                  {s.falseHeals}/{s.regressions}
                </td>
                <td>{s.healAccuracy === null ? '—' : `${Math.round(s.healAccuracy * 100)}%`}</td>
                <td>{(s.medianSuiteMs / 1000).toFixed(1)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Handled: no criterion fails (pass, healed or sent to review). False heal: the mode would write a repair to locators.json while the app has a real regression. Heal accuracy: accepted repairs on drifts out of all accepted repairs.
      </p>
      <h2>Per mutation</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Mutation</th>
              {modes.map((m) => (
                <th key={m}>{MODE_LABEL[m] ?? m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.mutations.map((mu) => (
              <tr key={mu.id}>
                <td>
                  <span className="mono">{mu.id}</span> <span className="small muted">{mu.title}</span>
                </td>
                {modes.map((mode) => {
                  const c = data.cells.find((x) => x.mutation === mu.id && x.mode === mode);
                  return <td key={mode}>{c ? <span className={`chip ${OUTCOME_CHIP[c.outcome] ?? 'plain'}`}>{c.outcome}</span> : '—'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
