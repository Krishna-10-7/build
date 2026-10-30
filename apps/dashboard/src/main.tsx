import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, subscribe, type LiveEvent } from './api.ts';
import { EventFeed } from './components.tsx';
import { Tickets } from './pages/Tickets.tsx';
import { TicketView } from './pages/TicketView.tsx';
import { Review, RunView, Runs } from './pages/RunView.tsx';
import { BenchPage, PoliciesPage } from './pages/Insights.tsx';
import { GitHubPage } from './pages/GitHub.tsx';
import './styles.css';

function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

const NAV = [
  { href: '#/', label: 'Tickets', match: ['', 'tickets'] },
  { href: '#/runs', label: 'Runs', match: ['runs'] },
  { href: '#/review', label: 'Review queue', match: ['review'] },
  { href: '#/github', label: 'GitHub', match: ['github'] },
  { href: '#/bench', label: 'Benchmark', match: ['bench'] },
  { href: '#/policies', label: 'Policies', match: ['policies'] },
];

function App() {
  const route = useRoute();
  const [events, setEvents] = useState<LiveEvent[]>([]);
  // Bumped on every server event so open pages refetch.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.events().then((past) => setEvents(past.map((e) => ({ ...e, at: (e as unknown as { at: string }).at }))));
    return subscribe((e) => {
      setEvents((list) => [e, ...list].slice(0, 200));
      setTick((t) => t + 1);
    });
  }, []);

  const [pending, setPending] = useState(0);
  useEffect(() => {
    api.heals('pending').then((h) => setPending(h.length)).catch(() => {});
  }, [tick]);

  let page;
  if (route[0] === 'tickets' && route[1]) page = <TicketView id={route[1]} tick={tick} />;
  else if (route[0] === 'runs' && route[1]) page = <RunView id={Number(route[1])} tick={tick} />;
  else if (route[0] === 'runs') page = <Runs tick={tick} />;
  else if (route[0] === 'review') page = <Review tick={tick} />;
  else if (route[0] === 'bench') page = <BenchPage />;
  else if (route[0] === 'policies') page = <PoliciesPage />;
  else if (route[0] === 'github') page = <GitHubPage />;
  else page = <Tickets tick={tick} />;

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark" /> SentinelQA
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className={n.match.includes(route[0] ?? '') ? 'on' : ''}>
              {n.label}
              {n.href === '#/review' && pending > 0 && <span className="count">{pending}</span>}
            </a>
          ))}
        </nav>
        <div className="side-foot">Heals locators, never hides regressions.</div>
      </aside>
      <main className="main">{page}</main>
      <aside className="feed">
        <EventFeed events={events} />
      </aside>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
