import { useState } from 'react';
import { api, type HealRecord, type HealRow, type LocatorMap } from '../api.ts';
import { RuleChip, VerdictChip, ago, artifactUrl, useAsync } from '../components.tsx';

type Entry = LocatorMap[string];

function describe(e: Entry | null | undefined): string {
  if (!e) return '—';
  switch (e.strategy) {
    case 'testid':
      return `testid "${e.value}"`;
    case 'role':
      return `role ${e.role} "${e.name}"`;
    case 'label':
      return `label "${e.name}"`;
    case 'id':
      return `#${e.value}`;
    case 'css':
      return e.selector;
  }
}

function Gate({ name, g }: { name: string; g: { ok: boolean; detail: string } }) {
  return (
    <div className="row small" style={{ alignItems: 'flex-start' }}>
      <span className={`chip ${g.ok ? 'PASS' : 'REGRESSION'}`} style={{ minWidth: 92, justifyContent: 'center' }}>
        {g.ok ? '✓' : '✕'} {name}
      </span>
      <span className="mono" style={{ flex: 1 }}>
        {g.detail}
      </span>
    </div>
  );
}

const DECISION: Record<string, string> = { accepted: 'HEALED', review: 'NEEDS_REVIEW', refused: 'REGRESSION' };

export function HealCard({ h, row, onDone }: { h: HealRecord; row?: HealRow; onDone?: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const review = async (approve: boolean) => {
    if (!row) return;
    try {
      await (approve ? api.approve(row.id) : api.reject(row.id));
      onDone?.();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="card grid" style={{ background: '#fdfcfa' }}>
      <div className="spread">
        <div className="row">
          <span className="mono">{h.key}</span>
          <span className={`chip ${DECISION[h.decision]}`}>{h.decision}</span>
          <RuleChip rule={h.rule} />
          <span className="small muted">
            {h.layer} score {h.score.toFixed(2)}
            {h.runnerUp !== null ? ` · runner-up ${h.runnerUp.toFixed(2)}` : ''}
          </span>
        </div>
        {row && <span className="small muted">{row.status}</span>}
      </div>
      <div className="mono small">
        <div style={{ color: 'var(--fail)' }}>- {describe(h.from)}</div>
        <div style={{ color: 'var(--pass)' }}>+ {describe(h.to)}</div>
      </div>
      <div className="small">
        <span className="muted">Candidate:</span> {h.candidate} · <span className="muted">Why:</span> {h.reason}
      </div>
      <Gate name="Spec" g={h.gates.spec} />
      <Gate name="Effect" g={h.gates.effect} />
      <Gate name="Criteria" g={h.gates.criteria} />
      {row?.status === 'pending' && (
        <div className="row">
          <button className="btn primary" onClick={() => review(true)}>
            Approve and write locator
          </button>
          <button className="btn danger" onClick={() => review(false)}>
            Reject
          </button>
        </div>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

export function RunView({ id, tick }: { id: number; tick: number }) {
  const { data, error, reload } = useAsync(() => api.run(id), [id, tick]);
  if (error) return <div className="err">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  const { run, results, heals } = data;
  const rowFor = (h: HealRecord) => heals.find((r) => r.criterion === h.criterion && r.key === h.key);

  return (
    <div>
      <p className="small muted">
        <a href={`#/tickets/${run.ticket}`}>{run.ticket}</a> / run #{run.id}
      </p>
      <div className="spread">
        <h1>
          Run #{run.id} <VerdictChip v={run.status === 'done' ? run.verdict : null} />
        </h1>
        <span className="muted small">
          {run.kind} · {run.mode} · {run.mutations.join(', ') || 'no mutations'} · {ago(run.created_at)}
        </span>
      </div>
      {run.status !== 'done' && <p className="sub">{run.status === 'failed' ? <span className="err">{run.error}</span> : `${run.status}…`}</p>}

      {results.map((r) => (
        <div key={r.criterion} className="card grid" style={{ marginTop: 14 }}>
          <div className="spread">
            <div className="row">
              <strong className="mono">{r.criterion}</strong>
              <VerdictChip v={r.verdict} />
              <RuleChip rule={r.rule} />
            </div>
            <span className="small muted">
              {(r.durationMs / 1000).toFixed(1)} s{r.attempts > 1 ? ` · ${r.attempts} attempts` : ''}
            </span>
          </div>
          <div className="small muted">{r.title}</div>
          <div>{r.reason}</div>
          {r.expects.length > 0 && (
            <div className="mono small">
              {r.expects.map((e) => (
                <div key={e.id} style={{ color: e.ok ? 'var(--pass)' : 'var(--fail)' }}>
                  {e.ok ? '✓' : '✕'} {e.id} {e.detail}
                </div>
              ))}
            </div>
          )}
          {r.heals.map((h) => (
            <HealCard key={h.key} h={h} row={rowFor(h)} onDone={reload} />
          ))}
          {r.screenshots.length > 0 && (
            <div className="row">
              {r.screenshots.map((s) => (
                <a key={s} href={artifactUrl(s)} target="_blank" rel="noreferrer">
                  <img src={artifactUrl(s)} alt={`${r.criterion} final state`} style={{ width: 260, borderRadius: 8, border: '1px solid var(--line)' }} />
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function Runs({ tick }: { tick: number }) {
  const { data } = useAsync(() => api.runs(), [tick]);
  return (
    <div>
      <h1>Runs</h1>
      <p className="sub">Every baseline and check, newest first.</p>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Ticket</th>
              <th>Kind</th>
              <th>Mode</th>
              <th>Mutations</th>
              <th>Verdict</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} className="click" onClick={() => (location.hash = `#/runs/${r.id}`)}>
                <td className="mono">#{r.id}</td>
                <td className="mono">{r.ticket}</td>
                <td>{r.kind}</td>
                <td>{r.mode}</td>
                <td className="mono small">{r.mutations.join(', ') || '—'}</td>
                <td>{r.status === 'done' ? <VerdictChip v={r.verdict} /> : <span className="chip plain">{r.status}</span>}</td>
                <td className="muted">{ago(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Review({ tick }: { tick: number }) {
  const { data, reload } = useAsync(() => api.heals('pending'), [tick]);
  return (
    <div>
      <h1>Review queue</h1>
      <p className="sub">Repairs the policy would not accept on its own. Approving writes the locator to locators.json; the spec never changes.</p>
      {data?.length === 0 && <p className="muted">Nothing waiting.</p>}
      <div className="grid">
        {data?.map((row) => (
          <div key={row.id}>
            <p className="small muted" style={{ margin: '0 0 6px' }}>
              <a href={`#/runs/${row.run_id}`}>
                {row.ticket} · run #{row.run_id} · {row.criterion}
              </a>
            </p>
            <HealCard h={row.record} row={row} onDone={reload} />
          </div>
        ))}
      </div>
    </div>
  );
}
