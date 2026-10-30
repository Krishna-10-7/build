import { useEffect, useState } from 'react';
import type { LiveEvent, Verdict } from './api.ts';

const LABEL: Record<string, string> = {
  PASS: 'Pass',
  HEALED: 'Healed',
  NEEDS_REVIEW: 'Needs review',
  REGRESSION: 'Regression',
  FLAKY: 'Flaky',
  ERROR: 'Error',
};

export function VerdictChip({ v }: { v: Verdict | string | null }) {
  if (!v) return <span className="chip plain">…</span>;
  return <span className={`chip ${v}`}>{LABEL[v] ?? v}</span>;
}

export function RuleChip({ rule }: { rule: string }) {
  return (
    <span className="chip rule" title="Policy rule that made this decision">
      {rule}
    </span>
  );
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    load()
      .then((d) => live && (setData(d), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function EventFeed({ events }: { events: LiveEvent[] }) {
  return (
    <div>
      <div className="spread">
        <strong>Live activity</strong>
        <span className="small muted">{events.length} events</span>
      </div>
      {events.length === 0 && <p className="small muted">Nothing yet. Compile a ticket to start.</p>}
      {events.map((e, i) => (
        <div className="ev" key={i}>
          <div>
            <span className="t">{new Date(e.at).toLocaleTimeString()}</span>
            <span className="ty">{e.type}</span>
            {e.ticket && <span className="ty">{e.ticket}</span>}
          </div>
          <div>{e.message}</div>
        </div>
      ))}
    </div>
  );
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Screenshot paths are stored as files on the server; map them to /artifacts URLs. */
export function artifactUrl(file: string): string {
  const i = file.replace(/\\/g, '/').lastIndexOf('/artifacts/');
  return i >= 0 ? file.replace(/\\/g, '/').slice(i + 1) : file;
}
