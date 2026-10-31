import { useEffect, useState } from 'react';
import { at } from '../api.ts';
import { VerdictChip, useAsync } from '../components.tsx';

interface GithubStatus {
  configured: boolean;
  canSetup: boolean;
  canSignIn: boolean;
  installUrl: string | null;
  repos: { repo: string; defaultBranch: string; private: boolean; url: string; defaultTicket: string | null }[];
}

type Trigger =
  | { kind: 'manual' }
  | { kind: 'github'; event: 'push' | 'manual' | 'jira'; repo: string; ref: string; sha: string; message: string; author: string; url: string }
  | { kind: 'jira'; key: string; url: string };

interface EpisodeRow {
  id: number;
  status: 'queued' | 'preparing' | 'running' | 'finished' | 'failed';
  label: string;
  truth: string | null;
  trigger?: Trigger;
  request: { ticket: string };
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  results: {
    rival: { criterion: string; green: boolean; editedAssertions: boolean }[] | null;
    sentinel: { criterion: string; verdict: string }[] | null;
  };
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(at(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status}`);
  return data as T;
}

/** The same rule as the check run on the commit: SentinelQA's verdicts decide. */
function outcome(e: EpisodeRow): { verdict: string | null; text: string } {
  if (e.status === 'queued') return { verdict: null, text: 'waiting in the queue' };
  if (e.status === 'preparing' || e.status === 'running') return { verdict: null, text: 'running…' };
  const s = e.results.sentinel;
  if (e.status === 'failed' || !s) return { verdict: 'ERROR', text: e.error ?? 'did not finish' };
  const worst = ['REGRESSION', 'NEEDS_REVIEW', 'ERROR', 'FLAKY', 'HEALED'].find((v) => s.some((r) => r.verdict === v)) ?? 'PASS';
  const hit = s.filter((r) => r.verdict === worst).map((r) => r.criterion);
  return { verdict: worst, text: worst === 'PASS' ? `${s.length}/${s.length} pass` : `${hit.join(', ')}` };
}

function fixerText(e: EpisodeRow): string {
  const r = e.results.rival;
  if (!r) return '—';
  const green = r.filter((x) => x.green).length;
  const rewrote = r.filter((x) => x.editedAssertions).length;
  return `${green}/${r.length} green${rewrote ? ` · rewrote ${rewrote} assertion${rewrote === 1 ? '' : 's'}` : ''}`;
}

function when(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function GitHubPage() {
  const gh = useAsync(() => fetch(at('api/github')).then((r) => r.json() as Promise<GithubStatus>), []);
  const eps = useAsync(() => fetch(at('api/arena/episodes')).then((r) => r.json() as Promise<EpisodeRow[]>), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Runs move on their own (pushes arrive any time), so the list refreshes itself.
  useEffect(() => {
    const t = setInterval(eps.reload, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runNow(repo: string, ref: string) {
    setErr(null);
    setBusy(repo);
    try {
      await post('api/github/run', { repo, ref });
      eps.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const s = gh.data;
  const runs = eps.data ?? [];
  const lastFor = (repo: string) => runs.find((e) => e.trigger?.kind === 'github' && e.trigger.repo === repo);

  return (
    <div>
      <h1>GitHub</h1>
      <p className="sub">Your repositories and runs. Every push runs the Fixer and Sentinel on that commit and posts a SentinelQA check on it.</p>

      {(gh.error || err) && <div className="err">{gh.error ?? err}</div>}

      <div className="card" style={{ marginBottom: 18 }}>
        {!s ? (
          <p className="muted">Loading…</p>
        ) : s.configured ? (
          <div className="spread">
            <div>
              <strong>Connected</strong> <span className="chip PASS">GitHub App</span>
              <div className="small muted" style={{ marginTop: 4 }}>
                Sign in at the lobby's GitHub kiosk and install the app on your repositories; each becomes a floor that only you see.
              </div>
            </div>
            <div className="row">
              <a className="btn" href={at('?open=github')}>
                Open the GitHub kiosk
              </a>
              {s.installUrl && (
                <a className="btn primary" href={s.installUrl}>
                  Install on repositories
                </a>
              )}
            </div>
          </div>
        ) : (
          <p className="muted">GitHub is not set up yet. The operator creates the tower's GitHub App once, at the lobby's GitHub kiosk.</p>
        )}
      </div>

      {s?.configured && (
        <>
          <h2>Repositories</h2>
          <div className="card" style={{ padding: 0, marginBottom: 18 }}>
            {s.repos.length === 0 ? (
              <p className="muted" style={{ padding: '12px 16px' }}>
                No repositories of yours yet. Sign in at the lobby and install the app.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Repository</th>
                    <th>Last run</th>
                    <th style={{ width: 260 }} />
                  </tr>
                </thead>
                <tbody>
                  {s.repos.map((r) => {
                    const last = lastFor(r.repo);
                    const o = last && outcome(last);
                    return (
                      <tr key={r.repo}>
                        <td>
                          <a href={r.url}>{r.repo}</a> {r.private && <span className="chip plain">private</span>}
                        </td>
                        <td>{last && o ? <><VerdictChip v={o.verdict} /> <span className="small muted">{o.text} · {when(last.startedAt)}</span></> : <span className="small muted">no runs yet</span>}</td>
                        <td>
                          <RunButton repo={r.repo} branch={r.defaultBranch} busy={busy === r.repo} disabled={false} onRun={runNow} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <h2>Runs</h2>
      <div className="card" style={{ padding: 0 }}>
        {runs.length === 0 ? (
          <p className="muted" style={{ padding: '12px 16px' }}>
            No episodes yet.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Build</th>
                <th>SentinelQA</th>
                <th>LLM test-fixer</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((e) => {
                const o = outcome(e);
                const t = e.trigger;
                return (
                  <tr key={e.id}>
                    <td className="mono">{e.id}</td>
                    <td>
                      {t?.kind === 'github' ? (
                        <>
                          <span className="chip plain">{t.event === 'push' ? 'push' : t.event === 'jira' ? `Jira ${e.request.ticket}` : 'run'}</span> {t.repo}@{t.ref}{' '}
                          <a className="mono small" href={t.url}>
                            {t.sha.slice(0, 7)}
                          </a>
                          <div className="small muted">
                            {t.message} {t.author && `· ${t.author}`}
                          </div>
                        </>
                      ) : (
                        <>
                          {e.label || '…'}
                          {e.truth && <div className="small muted">answer key: {e.truth}</div>}
                        </>
                      )}
                    </td>
                    <td>
                      <VerdictChip v={o.verdict} /> <span className="small muted">{o.text}</span>
                    </td>
                    <td className="small">{fixerText(e)}</td>
                    <td className="small muted">{when(e.startedAt)}</td>
                    <td>
                      <a className="btn" href={at(`office/?episode=${e.id}`)} target="_blank" rel="noopener">
                        Watch
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RunButton({ repo, branch, busy, disabled, onRun }: { repo: string; branch: string; busy: boolean; disabled: boolean; onRun: (repo: string, ref: string) => void }) {
  const [ref, setRef] = useState(branch);
  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <input value={ref} onChange={(e) => setRef(e.target.value)} style={{ width: 150 }} aria-label="Branch" />
      <button className="btn" disabled={disabled || busy || !ref} onClick={() => onRun(repo, ref)}>
        {busy ? 'Queuing…' : 'Run now'}
      </button>
    </div>
  );
}
