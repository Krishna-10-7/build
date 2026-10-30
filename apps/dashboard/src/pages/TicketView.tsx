import { useEffect, useState } from 'react';
import { api, type Mutation, type Stage, type TicketDetail } from '../api.ts';
import { VerdictChip, ago, useAsync } from '../components.tsx';

const STAGES: { id: Stage; label: string }[] = [
  { id: 'received', label: 'Received' },
  { id: 'compiled', label: 'Contract' },
  { id: 'generated', label: 'Spec locked' },
  { id: 'baselined', label: 'Baseline' },
  { id: 'checked', label: 'Checked' },
];

function Stepper({ stage }: { stage: Stage }) {
  const at = STAGES.findIndex((s) => s.id === stage);
  return (
    <div className="stepper">
      {STAGES.map((s, i) => (
        <div key={s.id} className={`st ${i < at ? 'done' : ''} ${i === at ? 'now done' : ''}`}>
          {i + 1}. {s.label}
        </div>
      ))}
    </div>
  );
}

function CriteriaMatrix({ d }: { d: TicketDetail }) {
  const byId = new Map(d.contract?.criteria.map((c) => [c.id, c]) ?? []);
  return (
    <div className="card" style={{ padding: 0 }}>
      <table>
        <thead>
          <tr>
            <th>Criterion</th>
            <th>Ticket text</th>
            <th>Steps</th>
            <th>Checks</th>
          </tr>
        </thead>
        <tbody>
          {d.ticket.criteria.map((tc) => {
            const c = byId.get(tc.id);
            return (
              <tr key={tc.id}>
                <td className="mono">{tc.id}</td>
                <td>{tc.text}</td>
                <td className="mono small">
                  {!c ? <span className="muted">not compiled</span> : !c.testable ? <span className="muted">{c.note}</span> : c.steps.map((s, i) => <div key={i}>{s.do === 'goto' ? `goto ${s.url}` : `${s.do} ${s.key}${s.do === 'fill' ? ` = "${s.value}"` : ''}`}</div>)}
                </td>
                <td className="mono small">
                  {c?.expect.map((e) => (
                    <div key={e.id}>
                      {e.id} {e.type === 'text' ? `${e.key} ${e.equals !== undefined ? `= "${e.equals}"` : `~ "${e.contains}"`}` : e.type === 'request' ? `${e.method} ${e.path} ${e.status}` : e.type === 'url' ? `url ${e.path}` : `${e.key} visible`}
                    </div>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ContractEditor({ d, onSaved }: { d: TicketDetail; onSaved: () => void }) {
  const [text, setText] = useState(JSON.stringify(d.contract, null, 2));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setText(JSON.stringify(d.contract, null, 2)), [d.contract]);
  async function save() {
    try {
      await api.saveContract(d.ticket.key, JSON.parse(text));
      setErr(null);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="grid">
      <textarea rows={22} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      {err && <div className="err">{err}</div>}
      <div className="row">
        <button className="btn" onClick={save} disabled={!d.nextActions.includes('edit-contract')}>
          Save contract
        </button>
        <span className="small muted">Saving sends the ticket back to the contract stage: the spec and baseline are redone.</span>
      </div>
    </div>
  );
}

export function TicketView({ id, tick }: { id: string; tick: number }) {
  const { data: d, error, reload } = useAsync(() => api.ticket(id), [id, tick]);
  const { data: mutations } = useAsync(() => api.mutations().catch(() => [] as Mutation[]), []);
  const [tab, setTab] = useState<'contract' | 'spec' | 'locators' | 'baseline'>('contract');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <div className="err">{error}</div>;
  if (!d) return <p className="muted">Loading…</p>;
  const can = (a: string) => d.nextActions.includes(a) && !busy;
  const toggle = (m: string) => setPicked((p) => (p.includes(m) ? p.filter((x) => x !== m) : [...p, m]));

  return (
    <div>
      <p className="small muted">
        <a href="#/">Tickets</a> / {d.ticket.key}
      </p>
      <h1>
        {d.ticket.key} · {d.ticket.title}
      </h1>
      <p className="sub">{d.ticket.description.split('\n')[0]}</p>
      <Stepper stage={d.ticket.stage} />

      <div className="row">
        <button className="btn" disabled={!can('compile')} onClick={() => act('compile', () => api.compile(d.ticket.key))}>
          {busy === 'compile' ? 'Compiling…' : 'Compile criteria'}
        </button>
        <button className="btn" disabled={!can('generate')} onClick={() => act('generate', () => api.generate(d.ticket.key))}>
          Generate spec
        </button>
        <button className="btn" disabled={!can('baseline')} onClick={() => act('baseline', () => api.baseline(d.ticket.key))}>
          Record baseline
        </button>
        <button className="btn primary" disabled={!can('check')} onClick={() => act('check', () => api.check(d.ticket.key, picked))}>
          Run{picked.length ? ` with ${picked.join(', ')}` : ' on current build'}
        </button>
        {d.specGate && <span className={`chip ${d.specGate.ok ? 'PASS' : 'REGRESSION'}`}>spec {d.specGate.ok ? 'locked' : 'changed'}</span>}
      </div>
      {err && <div className="err">{err}</div>}

      {mutations && mutations.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="spread">
            <strong>Build under test</strong>
            <span className="small muted">ShopLite mutation flags; none selected means the release as it is</span>
          </div>
          {(['drift', 'regression'] as const).map((kind) => (
            <div key={kind} className="row" style={{ marginTop: 10 }}>
              <span className="small muted" style={{ width: 80 }}>
                {kind === 'drift' ? 'Drifts' : 'Regressions'}
              </span>
              {mutations
                .filter((m) => m.kind === kind)
                .map((m) => (
                  <button key={m.id} className={`mut ${picked.includes(m.id) ? 'on' : ''}`} onClick={() => toggle(m.id)} title={m.title}>
                    <b>{m.id}</b>
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}

      <h2>Criteria to tests</h2>
      <CriteriaMatrix d={d} />

      <div className="tabs">
        {(['contract', 'spec', 'locators', 'baseline'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'spec' ? 'Generated spec' : t === 'locators' ? 'locators.json' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'contract' && (d.contract ? <ContractEditor d={d} onSaved={reload} /> : <p className="muted">Compile the criteria first.</p>)}
      {tab === 'spec' &&
        (d.spec ? (
          <>
            <p className="small muted">{d.specGate?.detail}</p>
            <pre className="code">{d.spec}</pre>
          </>
        ) : (
          <p className="muted">Not generated yet.</p>
        ))}
      {tab === 'locators' && <pre className="code">{JSON.stringify(d.locators, null, 2)}</pre>}
      {tab === 'baseline' &&
        (d.baseline ? (
          <pre className="code">{JSON.stringify({ recordedAt: d.baseline.recordedAt, target: d.baseline.target, effects: d.baseline.effects }, null, 2)}</pre>
        ) : (
          <p className="muted">No baseline yet.</p>
        ))}

      <h2>Runs</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <tbody>
            {d.runs.map((r) => (
              <tr key={r.id} className="click" onClick={() => (location.hash = `#/runs/${r.id}`)}>
                <td className="mono">#{r.id}</td>
                <td>{r.kind}</td>
                <td className="mono small">{r.mutations.join(', ') || 'no mutations'}</td>
                <td>{r.status === 'done' ? <VerdictChip v={r.verdict} /> : <span className="chip plain">{r.status}</span>}</td>
                <td className="muted">{ago(r.created_at)}</td>
              </tr>
            ))}
            {d.runs.length === 0 && (
              <tr>
                <td className="muted">No runs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
