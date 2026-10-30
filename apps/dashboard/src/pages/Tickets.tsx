import { useState } from 'react';
import { api } from '../api.ts';
import { ago, useAsync } from '../components.tsx';

const EXAMPLE = `AC-1: Given the shopper is on "/product/linen-tote", when they click "Add to cart", then the "cart badge" shows "1".`;

export function Tickets({ tick }: { tick: number }) {
  const { data, error, reload } = useAsync(() => api.tickets(), [tick]);
  const [form, setForm] = useState({ key: '', title: '', criteria: '' });
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    try {
      await api.createTicket(form);
      setOpen(false);
      setForm({ key: '', title: '', criteria: '' });
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div>
      <div className="spread">
        <div>
          <h1>Tickets</h1>
          <p className="sub">From Jira (moved to Ready for QA), the tickets folder, or added here.</p>
        </div>
        <button className="btn primary" onClick={() => setOpen(!open)}>
          New ticket
        </button>
      </div>
      {open && (
        <div className="card grid" style={{ marginBottom: 16 }}>
          <div className="row">
            <input placeholder="SHOP-43" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })} style={{ width: 120 }} />
            <input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ flex: 1 }} />
          </div>
          <textarea rows={5} placeholder={EXAMPLE} value={form.criteria} onChange={(e) => setForm({ ...form, criteria: e.target.value })} />
          {err && <div className="err">{err}</div>}
          <div className="row">
            <button className="btn primary" onClick={create} disabled={!form.key || !form.title || !form.criteria}>
              Add ticket
            </button>
            <span className="small muted">One criterion per line, starting with AC-1:, AC-2: …</span>
          </div>
        </div>
      )}
      {error && <div className="err">{error}</div>}
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Title</th>
              <th>Criteria</th>
              <th>Stage</th>
              <th>Source</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((t) => (
              <tr key={t.key} className="click" onClick={() => (location.hash = `#/tickets/${t.key}`)}>
                <td className="mono">{t.key}</td>
                <td>{t.title}</td>
                <td>{t.criteria.length}</td>
                <td>
                  <span className="chip plain">{t.stage}</span>
                </td>
                <td className="muted">{t.source}</td>
                <td className="muted">{ago(t.updatedAt)}</td>
              </tr>
            ))}
            {data?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No tickets yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
