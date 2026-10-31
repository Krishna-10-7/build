import * as THREE from 'three';
import { arrive, floorHref, light, openElevator, ride } from './elevator.ts';
import { buildLobby, type LobbySpot } from './lobby-scene.ts';
import { at, connect, getJson, getMe, goSignIn, signOut, type Building, type Me } from './live.ts';
import { roundRect, wrap } from './toon.ts';
import './style.css';
import './lobby.css';

const opened = arrive();
const world = buildLobby(document.getElementById('stage')!);
const ui = document.getElementById('ui')!;
let building: Building | null = null;
let me: Me | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const el = <T extends HTMLElement>(html: string): T => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
};

// ---------- HUD ----------
const title = el<HTMLDivElement>(`<div class="title pill"><b>SentinelQA Tower</b><div class="sub">Ground floor · lobby</div><div class="acct"></div></div>`);
const views = el<HTMLDivElement>(`<div class="views">
  <button class="btn go" data-act="elevator">Elevator</button>
  <button class="btn" data-act="reception">Tickets</button>
  <button class="btn" data-act="github">GitHub</button>
  <button class="btn" data-act="jira">Jira</button>
  <button class="btn" data-act="agents">Agent access</button>
  <button class="btn" data-act="users" hidden>People</button>
  <a class="btn" href="${at('console/')}">Control room ↗</a>
</div>`);
const directory = el<HTMLDivElement>(`<div class="controls pill lobby-dir"><label>Directory</label><div class="dir-list">Loading…</div></div>`);
const now = el<HTMLDivElement>(`<div class="status"><div class="agent pill"><span class="dot"></span><div style="min-width:0"><div class="who">Now</div><div class="what">…</div></div></div></div>`);
const hint = el<HTMLDivElement>(`<div class="hint pill">Click the lift, a kiosk or the control room door</div>`);
ui.append(title, views, directory, now, hint);
views.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => (b.onclick = () => act(b.dataset.act as LobbySpot)));

// ---------- boards in the scene ----------
const TONE: Record<string, string> = { ok: '#5fd68a', bad: '#ff6b6b', warn: '#ffc861', run: '#ffd166', idle: '#8b94a3' };

function drawDirectory(b: Building) {
  const p = world.directory;
  const g = p.ctx;
  g.fillStyle = '#12151c';
  g.fillRect(0, 0, p.w, p.h);
  g.fillStyle = '#ffb38a';
  g.font = '900 64px Nunito, sans-serif';
  g.fillText('Directory', 50, 92);
  g.fillStyle = '#8b94a3';
  g.font = '700 30px Nunito, sans-serif';
  g.fillText('one floor per project · take the lift', 50, 136);
  const rows = [...b.floors].reverse().slice(0, 9);
  rows.forEach((f, i) => {
    const y = 200 + i * 78;
    const l = light(f);
    g.fillStyle = '#1f2430';
    roundRect(g, 40, y - 50, p.w - 80, 66, 14);
    g.fill();
    g.fillStyle = '#ffb38a';
    g.font = '900 40px "JetBrains Mono", monospace';
    g.fillText(String(f.n), 66, y - 4);
    g.fillStyle = '#e6e1da';
    g.font = '800 34px Nunito, sans-serif';
    g.fillText(f.title.length > 30 ? `${f.title.slice(0, 29)}…` : f.title, 130, y - 4);
    g.fillStyle = TONE[l.cls];
    g.beginPath();
    g.arc(p.w - 340, y - 16, 12, 0, Math.PI * 2);
    g.fill();
    g.font = '700 26px Nunito, sans-serif';
    const t = l.text.length > 20 ? `${l.text.slice(0, 19)}…` : l.text;
    g.fillText(t, p.w - 316, y - 6);
  });
  const gy = 200 + rows.length * 78;
  g.fillStyle = '#1f2430';
  roundRect(g, 40, gy - 50, p.w - 80, 66, 14);
  g.fill();
  g.fillStyle = '#ffb38a';
  g.font = '900 40px "JetBrains Mono", monospace';
  g.fillText('G', 66, gy - 4);
  g.fillStyle = '#e6e1da';
  g.font = '800 34px Nunito, sans-serif';
  g.fillText('Lobby · GitHub · agent access', 130, gy - 4);
  if (!b.github.configured) {
    g.fillStyle = '#8b94a3';
    g.font = '700 28px Nunito, sans-serif';
    g.fillText('Connect GitHub at the purple kiosk to add floors.', 50, Math.min(p.h - 30, gy + 70));
  }
  p.commit();
}

function drawIndicators(b: Building) {
  const live = b.live && b.floors.find((f) => f.id === b.live!.floor);
  world.indicators.forEach((p, i) => {
    const g = p.ctx;
    g.fillStyle = '#12151c';
    g.fillRect(0, 0, p.w, p.h);
    g.fillStyle = '#ffb38a';
    g.font = '900 60px "JetBrains Mono", monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(i === 0 && live ? `▲ ${live.n}` : 'G', p.w / 2, p.h / 2 + 3);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    p.commit();
  });
}

function screen(p: typeof world.githubScreen, bg: string, head: string, lines: string[], foot: string) {
  const g = p.ctx;
  g.fillStyle = bg;
  g.fillRect(0, 0, p.w, p.h);
  g.fillStyle = '#fffaf2';
  g.font = '900 60px Nunito, sans-serif';
  g.fillText(head, 34, 80);
  g.font = '700 30px Nunito, sans-serif';
  let y = 140;
  for (const l of lines) for (const w of wrap(g, l, p.w - 68)) (g.fillText(w, 34, y), (y += 38));
  g.fillStyle = 'rgba(255,250,242,.85)';
  g.font = '800 26px "JetBrains Mono", monospace';
  g.fillText(foot, 34, p.h - 34);
  p.commit();
}

function drawKiosks(b: Building) {
  const repos = b.floors.filter((f) => f.kind === 'github').length;
  screen(
    world.githubScreen,
    '#5b4bb3',
    'GitHub',
    b.github.configured ? [`${repos} repositor${repos === 1 ? 'y' : 'ies'} connected.`, 'Every push runs here and gets a check.'] : ['Connect a repository.', 'It gets its own floor.'],
    b.github.configured ? '▶ manage' : '▶ connect',
  );
  const linked = b.jira.links.length;
  screen(
    world.jiraScreen,
    '#1d5fc4',
    'Jira',
    b.jira.configured ? [`${linked} project${linked === 1 ? '' : 's'} linked to floors.`, 'Ready for QA runs the ticket.'] : ['Connect Jira Cloud.', 'Tickets run on their floor.'],
    b.jira.configured ? '▶ manage' : '▶ connect',
  );
  screen(world.agentScreen, '#b8501f', 'Agent access', ['MCP server, CLI and API tokens for coding agents.'], '$ sentinelqa check');
}

function render(b: Building) {
  building = b;
  drawDirectory(b);
  drawIndicators(b);
  drawKiosks(b);
  const live = b.live && b.floors.find((f) => f.id === b.live!.floor);
  title.querySelector('.sub')!.textContent = `Ground floor · lobby · ${b.floors.length} floor${b.floors.length === 1 ? '' : 's'}`;
  world.receptionist.setMood(live ? 'working' : 'idle');
  const greeting = live
    ? `Floor ${live.n} is checking ${esc(b.live!.label || live.title)}`
    : me?.user
      ? `Welcome back, @${esc(me.user.login)}. Take the lift to a floor.`
      : b.busy
        ? 'Someone is running a check upstairs. Sign in to get floors of your own.'
        : 'Welcome! Sign in with GitHub to get floors of your own.';
  world.bubble.innerHTML = `<div class="bubble"><span class="state s-${live ? 'working' : 'idle'}">${live ? 'BUSY' : 'WELCOME'}</span><div class="head">${greeting}</div></div><div class="name">Reception · tickets</div>`;
  const card = now.querySelector<HTMLDivElement>('.agent')!;
  card.querySelector<HTMLSpanElement>('.dot')!.style.background = live ? '#ffd166' : '#e9e3da';
  card.querySelector('.what')!.textContent = live ? `Floor ${live.n} · ${b.live!.label || live.title} · ${b.live!.status}` : 'Nothing running';
  card.onclick = live ? () => ride(0, { n: live.n, label: live.title, href: floorHref(live.id) }) : null;
  card.style.cursor = live ? 'pointer' : 'default';
  directory.querySelector('.dir-list')!.innerHTML = [...b.floors]
    .reverse()
    .map((f) => {
      const l = light(f);
      return `<button class="dir-row" data-id="${esc(f.id)}" data-n="${f.n}" data-label="${esc(f.title)}"><span class="dir-n">${f.n}</span><span class="dir-t">${esc(f.title)}</span><span class="dir-s"><i class="dot ${l.cls}"></i>${esc(l.text)}</span></button>`;
    })
    .join('');
  directory.querySelectorAll<HTMLButtonElement>('.dir-row').forEach((r) => (r.onclick = () => ride(0, { n: Number(r.dataset.n), label: r.dataset.label!, href: floorHref(r.dataset.id!) })));
}

let accountKey = '';
function renderAccount() {
  const acct = title.querySelector<HTMLDivElement>('.acct')!;
  views.querySelector<HTMLButtonElement>('[data-act="users"]')!.hidden = !me?.operator || !me.user;
  // Rebuild only when it changes, so a button is never swapped out under the pointer.
  const key = JSON.stringify([me?.user?.login, me?.user?.role, me?.signIn, me?.operator]);
  if (key === accountKey) return;
  accountKey = key;
  if (me?.user) {
    acct.innerHTML = `${me.user.avatar ? `<img src="${esc(me.user.avatar)}" alt="" />` : ''}<span>@${esc(me.user.login)}${me.user.role === 'operator' ? ' · operator' : ''}</span><button class="btn" id="signout">Sign out</button>`;
    acct.querySelector<HTMLButtonElement>('#signout')!.onclick = () => void signOut();
  } else if (me?.signIn) {
    acct.innerHTML = '<button class="btn go" id="signin">Continue with GitHub</button>';
    acct.querySelector<HTMLButtonElement>('#signin')!.onclick = () => act('github');
  } else {
    acct.innerHTML = me?.operator ? '<span>operator · local</span>' : '<span>sign-in opens once GitHub is connected</span>';
  }
}

async function refresh() {
  try {
    me = await getMe();
    renderAccount();
    render(await getJson<Building>('api/building'));
  } catch (e) {
    directory.querySelector('.dir-list')!.textContent = `Cannot reach the server: ${(e as Error).message}`;
  }
}

// ---------- sheets (overlays) ----------
function sheet(titleText: string, body: string): HTMLDivElement {
  document.querySelector('.sheet-wrap')?.remove();
  const wrapEl = el<HTMLDivElement>(`<div class="sheet-wrap"><div class="sheet" role="dialog" aria-label="${esc(titleText)}">
    <header><b>${esc(titleText)}</b><span class="grow"></span><button class="btn" data-close>Close</button></header>
    <div class="sheet-body">${body}</div></div></div>`);
  const close = () => {
    wrapEl.remove();
    fly('overview');
  };
  // A block body on purpose: an onclick handler that returns false cancels the click, links included.
  wrapEl.addEventListener('click', (e) => {
    if (e.target === wrapEl || (e.target as HTMLElement).dataset.close !== undefined) close();
  });
  ui.append(wrapEl);
  return wrapEl;
}

function copyable(text: string): string {
  return `<div class="code"><pre>${esc(text)}</pre><button class="btn copy" data-copy="${esc(text)}">Copy</button></div>`;
}

function wireCopy(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy!);
        b.textContent = 'Copied';
      } catch {
        b.textContent = 'Select and copy';
      }
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    };
  });
}

/** Calls as the signed-in person (their session cookie). */
async function post<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const send = method === 'POST' || method === 'PUT';
  return getJson<T>(path, { method, headers: send ? { 'content-type': 'application/json' } : {}, body: send ? JSON.stringify(body ?? {}) : undefined });
}

/** Fills the sheet with a sign-in prompt when nobody is signed in; true when it did. */
function needSignIn(s: HTMLDivElement, why: string, open: string): boolean {
  if (me?.user) return false;
  const body = s.querySelector<HTMLDivElement>('.sheet-body')!;
  body.innerHTML = `<p>${why}</p>${
    me?.signIn ? '<div class="row"><button class="btn go" id="signin">Sign in with GitHub</button></div>' : '<p class="muted">Sign-in opens as soon as the operator has connected GitHub at the purple kiosk.</p>'
  }`;
  s.querySelector<HTMLButtonElement>('#signin')?.addEventListener('click', () => me && goSignIn(me, `?open=${open}`));
  return true;
}

interface GithubStatus {
  configured: boolean;
  canSetup: boolean;
  canSignIn: boolean;
  installUrl: string | null;
  repos: { repo: string; defaultBranch: string; private: boolean; url: string; defaultTicket: string | null }[];
}

interface MyTicket {
  key: string;
  title: string;
  source: string;
  criteria: number;
  baselined: boolean;
  sample: boolean;
}

async function githubSheet() {
  const s = sheet('GitHub', '<p class="muted">Loading…</p>');
  const body = s.querySelector<HTMLDivElement>('.sheet-body')!;
  let g: GithubStatus;
  try {
    g = await getJson<GithubStatus>('api/github');
  } catch (e) {
    body.innerHTML = `<p class="err">${esc((e as Error).message)}</p>`;
    return;
  }
  if (!g.configured) {
    // The tower's owner creates its GitHub App once (from a setup link, or here when running locally).
    body.innerHTML = !g.canSetup
      ? '<p>This server has no public address (PUBLIC_URL), so GitHub cannot reach it.</p>'
      : me?.operator
        ? `<p><b>One-time setup.</b> This creates the tower's GitHub App. After that, anyone connects their repositories with one click.</p>
           <p class="muted">GitHub shows the app (read code, write checks, receive pushes) and asks you to confirm.</p>
           <div class="row"><button class="btn go" id="connect">Create the GitHub App</button></div><p class="err" id="e"></p>`
        : '<p>The tower is finishing its one-time setup with GitHub. Once it is done, connecting your repositories takes one click here.</p>';
    s.querySelector<HTMLButtonElement>('#connect')?.addEventListener('click', async () => {
      try {
        const r = await post<{ action: string; manifest: unknown }>('api/github/manifest', {});
        const form = document.createElement('form');
        form.method = 'post';
        form.action = r.action;
        const f = document.createElement('input');
        f.type = 'hidden';
        f.name = 'manifest';
        f.value = JSON.stringify(r.manifest);
        form.append(f);
        document.body.append(form);
        form.submit();
      } catch (e) {
        s.querySelector('#e')!.textContent = (e as Error).message;
      }
    });
    return;
  }
  if (!me?.user) {
    // Like a hosting platform: one button installs the app on the repositories you pick and signs you in.
    body.innerHTML = `<p>Connect your GitHub repositories. Each one becomes a floor of yours; every push to it runs here and gets a check on the commit. Only you see your floors.</p>
      <div class="row"><a class="btn go" href="${esc(g.installUrl ?? '#')}">Connect GitHub</a><button class="btn" id="signin">I have connected before: sign in</button></div>
      <p class="muted">GitHub asks which repositories to give access to, then brings you back here, signed in.</p>`;
    s.querySelector<HTMLButtonElement>('#signin')!.onclick = () => me && goSignIn(me, '?open=github');
    return;
  }
  const tickets = await getJson<MyTicket[]>('api/my/tickets').catch(() => [] as MyTicket[]);
  const floors = building?.floors ?? [];
  const opts = (sel: string | null) =>
    `<option value="">No default ticket</option>${tickets.map((t) => `<option value="${esc(t.key)}" ${t.key === sel ? 'selected' : ''}>${esc(t.key)} · ${esc(t.title)}${t.sample ? ' (sample)' : ''}</option>`).join('')}`;
  body.innerHTML = `
    <p>Your repositories. A push runs the ticket its branch or commit names (SHOP-42-fix), or the repository's default ticket.</p>
    <div class="repo-list">${
      g.repos.length
        ? g.repos
            .map((r) => {
              const f = floors.find((x) => x.id === r.repo);
              const l = f ? light(f) : { cls: 'idle', text: '' };
              return `<div class="repo-row"><span class="dir-n">${f?.n ?? '·'}</span><div class="repo-t"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.repo)}</a><small><i class="dot ${l.cls}"></i>${esc(l.text)}</small></div>
                <select data-ticket="${esc(r.repo)}" aria-label="Default ticket">${opts(r.defaultTicket)}</select>
                <button class="btn" data-ride="${esc(r.repo)}">Ride up</button></div>`;
            })
            .join('')
        : '<p class="muted">No repositories yet. Install the app on some.</p>'
    }</div>
    <div class="row"><a class="btn go" href="${esc(g.installUrl ?? '#')}">Install on your repositories</a><button class="btn" id="refresh">Refresh my repositories</button></div>
    <p class="muted">Tickets come from your Jira (blue kiosk) or are written at the reception desk.</p>
    <p class="err" id="e"></p>`;
  s.querySelector<HTMLButtonElement>('#refresh')!.onclick = () => me && goSignIn(me, '?open=github');
  s.querySelectorAll<HTMLSelectElement>('[data-ticket]').forEach((sel) => {
    sel.onchange = async () => {
      try {
        await post(`api/github/repos/${sel.dataset.ticket}`, { defaultTicket: sel.value || null }, 'PUT');
      } catch (e) {
        s.querySelector('#e')!.textContent = (e as Error).message;
      }
    };
  });
  s.querySelectorAll<HTMLButtonElement>('[data-ride]').forEach((b) => {
    const f = floors.find((x) => x.id === b.dataset.ride);
    b.onclick = () => f && ride(0, { n: f.n, label: f.title, href: floorHref(f.id) });
  });
}

interface JiraStatus {
  configured: boolean;
  site: string | null;
  account: string | null;
  readyStatus: string;
  links: { project: string; floor: string }[];
  canReceive: boolean;
}

async function jiraSheet(note?: string) {
  const s = sheet('Jira', '<p class="muted">Loading…</p>');
  if (needSignIn(s, 'Sign in to connect your own Jira Cloud site. Tickets that reach "Ready for QA" then run on the floor you link their project to, and the verdict is commented on the ticket.', 'jira')) return;
  const body = s.querySelector<HTMLDivElement>('.sheet-body')!;
  let j: JiraStatus;
  try {
    j = await getJson<JiraStatus>('api/jira');
  } catch (e) {
    body.innerHTML = `<p class="err">${esc((e as Error).message)}</p>`;
    return;
  }
  const floors = building?.floors ?? [];
  const floorName = (id: string) => floors.find((f) => f.id === id);
  if (!j.configured) {
    body.innerHTML = `
      <p>Connect your Jira Cloud site. Link each Jira project to one of your floors; when one of its tickets moves to <b>Ready for QA</b>, SentinelQA reads its acceptance criteria, runs them on that floor and comments the verdicts on the ticket.</p>
      <p class="muted">Create an API token at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener">id.atlassian.com → Security → API tokens</a>. It is checked with Jira, then stored encrypted and used only for your tickets.</p>
      <div class="row"><input id="site" placeholder="https://your-team.atlassian.net" /></div>
      <div class="row"><input id="email" type="email" placeholder="Atlassian account email" /><input id="jtok" type="password" placeholder="Jira API token" /></div>
      <div class="row"><input id="ready" placeholder="Ready status" value="Ready for QA" /></div>
      <div class="row"><button class="btn go" id="connect">Connect Jira</button></div>
      <p class="err" id="e"></p>`;
    s.querySelector<HTMLButtonElement>('#connect')!.onclick = async () => {
      const v = (id: string) => s.querySelector<HTMLInputElement>(`#${id}`)!.value;
      try {
        await post('api/jira/connect', { baseUrl: v('site'), email: v('email'), token: v('jtok'), readyStatus: v('ready') });
        await refresh();
        void jiraSheet('Connected. Link a project to a floor next.');
      } catch (e) {
        s.querySelector('#e')!.textContent = (e as Error).message;
      }
    };
    return;
  }
  const options = floors.map((f) => `<option value="${esc(f.id)}">${f.n} · ${esc(f.title)}</option>`).join('');
  body.innerHTML = `
    ${note ? `<div class="fresh">${esc(note)}</div>` : ''}
    <p>Connected to <a href="${esc(j.site!)}" target="_blank" rel="noopener">${esc(j.site!.replace(/^https?:\/\//, ''))}</a> as <b>${esc(j.account ?? '')}</b>. Tickets that reach <b>${esc(j.readyStatus)}</b> run on their floor.</p>
    <h3>Projects and floors</h3>
    <div class="repo-list">${
      j.links.length
        ? j.links
            .map((l) => {
              const f = floorName(l.floor);
              return `<div class="repo-row"><span class="dir-n">${f?.n ?? '·'}</span><div class="repo-t"><b>${esc(l.project)} → ${esc(f?.title ?? l.floor)}</b><small>tickets ${esc(l.project)}-… run here; branches named ${esc(l.project)}-42-… check that ticket</small></div><button class="btn" data-unlink="${esc(l.project)}">Unlink</button></div>`;
            })
            .join('')
        : '<p class="muted">No projects linked yet.</p>'
    }</div>
    <div class="row"><input id="proj" placeholder="Jira project key, e.g. SHOP" style="flex:0 1 220px" /><select id="floor">${options}</select><button class="btn go" id="link">Link</button></div>
    <h3>Run a ticket now</h3>
    <div class="row"><input id="key" placeholder="Ticket, e.g. SHOP-42" /><button class="btn" id="run">Run on its floor</button></div>
    <h3>Jira automation rule</h3>
    <p class="muted">So that "${esc(j.readyStatus)}" starts a run by itself. In Jira: Project settings → Automation → Create rule.</p>
    <div id="hook"><button class="btn" id="showHook">Show your webhook address</button></div>
    <p class="err" id="e"></p>
    <div class="row"><button class="btn" id="disconnect">Disconnect Jira</button></div>`;
  const err = s.querySelector<HTMLParagraphElement>('#e')!;
  const guard = async (fn: () => Promise<unknown>) => {
    err.textContent = '';
    try {
      await fn();
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  };
  s.querySelectorAll<HTMLButtonElement>('[data-unlink]').forEach((b) => (b.onclick = () => guard(async () => (await post(`api/jira/links/${b.dataset.unlink}`, undefined, 'DELETE'), await refresh(), void jiraSheet()))));
  s.querySelector<HTMLButtonElement>('#link')!.onclick = () =>
    guard(async () => {
      await post('api/jira/links', { project: s.querySelector<HTMLInputElement>('#proj')!.value, floor: s.querySelector<HTMLSelectElement>('#floor')!.value }, 'PUT');
      await refresh();
      void jiraSheet();
    });
  s.querySelector<HTMLButtonElement>('#run')!.onclick = () =>
    guard(async () => {
      const key = s.querySelector<HTMLInputElement>('#key')!.value.trim().toUpperCase();
      const r = await post<{ id: number; floor: string }>(`api/jira/tickets/${encodeURIComponent(key)}/run`, {});
      const f = floorName(r.floor);
      if (f) ride(0, { n: f.n, label: `${f.title} · ${key}`, href: floorHref(f.id) });
    });
  s.querySelector<HTMLButtonElement>('#showHook')!.onclick = () =>
    guard(async () => {
      const h = await post<{ url: string; readyStatus: string }>('api/jira/webhook', undefined, 'GET');
      s.querySelector('#hook')!.innerHTML = `<ol class="muted steps">
          <li>Trigger: <b>Issue transitioned</b>, to status <b>${esc(h.readyStatus)}</b>.</li>
          <li>Action: <b>Send web request</b>, method <b>POST</b>, body <b>Issue data (Jira format)</b>, to:</li></ol>
        ${copyable(h.url)}
        <p class="muted">The address contains your secret; keep it inside Jira.</p>`;
      wireCopy(s);
    });
  s.querySelector<HTMLButtonElement>('#disconnect')!.onclick = () => guard(async () => (await post('api/jira', undefined, 'DELETE'), await refresh(), void jiraSheet()));
}

/** The reception desk: tickets written here, imported from Jira, and the shared samples. */
async function ticketsSheet(note?: string) {
  const s = sheet('Ticket desk', '<p class="muted">Loading…</p>');
  if (needSignIn(s, 'Sign in to keep your own tickets. A ticket is a title and acceptance criteria; SentinelQA turns them into checks and runs them on your floors.', 'tickets')) return;
  const body = s.querySelector<HTMLDivElement>('.sheet-body')!;
  const list = await getJson<MyTicket[]>('api/my/tickets').catch(() => [] as MyTicket[]);
  const src = (t: MyTicket) => (t.sample ? 'sample' : t.source === 'jira' ? 'from Jira' : 'written here');
  body.innerHTML = `
    ${note ? `<div class="fresh">${esc(note)}</div>` : ''}
    <p>The criteria live here, not in your repository, so nothing pushed to it can change what is checked.</p>
    <div class="repo-list">${list
      .map(
        (t) => `<div class="repo-row"><div class="repo-t"><b>${esc(t.key)} · ${esc(t.title)}</b><small>${src(t)} · ${t.criteria} criteria${t.sample ? '' : t.baselined ? ' · baseline recorded' : ' · baseline on its first run'}</small></div>
          ${t.sample ? '' : `<button class="btn" data-del="${esc(t.key)}">Delete</button>`}</div>`,
      )
      .join('')}</div>
    <h3>Write a ticket</h3>
    <div class="row"><input id="key" placeholder="Key, e.g. CART-7" style="flex:0 1 160px" /><input id="title" placeholder="Title" /></div>
    <textarea id="criteria" rows="5" placeholder='AC-1: Given the shopper is on "/product/clay-mug", when they click "Add to cart", then the "cart badge" shows "1".'></textarea>
    <div class="row"><button class="btn go" id="save">Save and compile</button></div>
    <p class="err" id="e"></p>`;
  const err = s.querySelector<HTMLParagraphElement>('#e')!;
  s.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
    b.onclick = async () => {
      await post(`api/my/tickets/${b.dataset.del}`, undefined, 'DELETE').catch((e) => (err.textContent = (e as Error).message));
      void ticketsSheet();
    };
  });
  s.querySelector<HTMLButtonElement>('#save')!.onclick = async () => {
    err.textContent = 'Compiling the criteria…';
    try {
      const v = (id: string) => s.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!.value;
      const t = await post<{ key: string; criteria: number }>('api/my/tickets', { key: v('key'), title: v('title'), criteria: v('criteria') });
      void ticketsSheet(`${t.key} saved with ${t.criteria} criteria. Pick it as a floor's default ticket at the GitHub kiosk, or name it in a branch.`);
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  };
}

interface TokenRow {
  id: number;
  name: string;
  scope: string;
  hint: string;
  created_at: string;
  last_used_at: string | null;
}

async function agentsSheet(fresh?: string) {
  const b = building ?? (await getJson<Building>('api/building'));
  const tok = fresh ?? '$SENTINELQA_TOKEN';
  const firstRepo = b.floors.find((f) => f.kind === 'github')?.id ?? 'owner/repo';
  const u = me?.usage;
  const s = sheet(
    'Agent access',
    `<p>Most code is now pushed by coding agents. Give them SentinelQA as a tool: they check their own pushes against the ticket, in a real browser, and a green result cannot be earned by editing the test.</p>
    ${fresh ? `<div class="fresh"><b>New token</b>, shown once. Store it now.${copyable(fresh)}</div>` : ''}
    <h3>1 · MCP server</h3>
    <p class="muted">Claude Code (any Streamable HTTP client works with the same URL and header):</p>
    ${copyable(`claude mcp add --transport http sentinelqa ${b.agents.mcp} --header "Authorization: Bearer ${tok}"`)}
    <p class="muted">Tools: list_projects, run_check, commit_status, get_result, get_acceptance_criteria, list_runs. For stdio-only clients run <code>node sentinelqa.mjs mcp</code>.</p>
    <h3>2 · Command line</h3>
    ${copyable(`curl -fsSL ${b.agents.cli} -o sentinelqa.mjs\nnode sentinelqa.mjs login --token ${tok}\ngit push && node sentinelqa.mjs commit ${firstRepo} "$(git rev-parse HEAD)"`)}
    <p class="muted">Exit code 0 pass, 1 regression, 2 needs review, 3 inconclusive. <a href="${esc(b.agents.guide)}" target="_blank" rel="noopener">Guide for agents</a></p>
    <h3>3 · Your API tokens</h3>
    <div id="mine"></div>`,
  );
  wireCopy(s);
  const mine = s.querySelector<HTMLDivElement>('#mine')!;
  if (!me?.user) {
    mine.innerHTML = me?.signIn ? '<p>Sign in to make tokens for your agents.</p><div class="row"><button class="btn go" id="signin">Sign in with GitHub</button></div>' : '<p class="muted">Tokens open once sign-in is set up.</p>';
    s.querySelector<HTMLButtonElement>('#signin')?.addEventListener('click', () => me && goSignIn(me, '?open=agents'));
    return;
  }
  mine.innerHTML = `
    <div class="row"><input id="name" placeholder="Name, e.g. claude-code laptop" />
      <select id="scope"><option value="run">run: start checks</option><option value="read">read: results only</option></select><button class="btn go" id="mint">Create token</button></div>
    <div id="tokens" class="muted">Loading…</div>
    <h3>Usage today</h3>
    <p class="muted">${u ? `${u.runs} of ${me.limits.runsPerDay} runs · Fixer on the shared LLM key ${u.llm_runs} of ${me.limits.llmRunsPerDay}` : ''}${me.ownLlmKey ? ' · your own LLM key is set, so the Fixer has no daily cap' : ''}</p>
    <div class="row"><input id="llm" type="password" placeholder="${me.ownLlmKey ? 'Replace your Groq API key' : 'Your own Groq API key (optional)'}" /><button class="btn" id="saveKey">Save key</button>${me.ownLlmKey ? '<button class="btn" id="dropKey">Remove key</button>' : ''}</div>
    <p class="err" id="e"></p>`;
  const err = s.querySelector<HTMLParagraphElement>('#e')!;
  const list = s.querySelector<HTMLDivElement>('#tokens')!;
  const loadTokens = async () => {
    try {
      const rows = await getJson<TokenRow[]>('api/tokens');
      list.innerHTML = rows.length
        ? rows.map((t) => `<div class="repo-row"><div class="repo-t"><b>${esc(t.name)}</b><small>${esc(t.scope)} · ${esc(t.hint)} · ${t.last_used_at ? `used ${esc(t.last_used_at.slice(0, 16).replace('T', ' '))}` : 'never used'}</small></div><button class="btn" data-revoke="${t.id}">Revoke</button></div>`).join('')
        : 'No tokens yet.';
      list.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((btn) => {
        btn.onclick = async () => {
          await post(`api/tokens/${btn.dataset.revoke}`, undefined, 'DELETE').catch((e) => (err.textContent = (e as Error).message));
          void loadTokens();
        };
      });
    } catch (e) {
      list.textContent = (e as Error).message;
    }
  };
  s.querySelector<HTMLButtonElement>('#mint')!.onclick = async () => {
    err.textContent = '';
    try {
      const r = await post<{ token: string }>('api/tokens', { name: s.querySelector<HTMLInputElement>('#name')!.value, scope: s.querySelector<HTMLSelectElement>('#scope')!.value });
      await agentsSheet(r.token);
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  };
  const setKey = async (key: string | null) => {
    try {
      await post('api/me/llm-key', { key }, 'PUT');
      me = await getMe();
      void agentsSheet();
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  };
  s.querySelector<HTMLButtonElement>('#saveKey')!.onclick = () => void setKey(s.querySelector<HTMLInputElement>('#llm')!.value);
  s.querySelector<HTMLButtonElement>('#dropKey')?.addEventListener('click', () => void setKey(null));
  void loadTokens();
}

interface UserRow {
  id: number;
  login: string;
  role: string;
  disabled: number;
  repos: number;
  runs_today: number;
  created_at: string;
  ownLlmKey: boolean;
}

/** The operator's list of everyone in the tower. */
async function usersSheet() {
  const s = sheet('People', '<p class="muted">Loading…</p>');
  const body = s.querySelector<HTMLDivElement>('.sheet-body')!;
  try {
    const rows = await getJson<UserRow[]>('api/users');
    body.innerHTML = `<p>${rows.length} ${rows.length === 1 ? 'person has' : 'people have'} signed in. A blocked account is signed out and its pushes stop running.</p>
      <div class="repo-list">${rows
        .map(
          (u) => `<div class="repo-row"><div class="repo-t"><b>@${esc(u.login)}${u.role === 'operator' ? ' · operator' : ''}</b><small>${u.repos} repositories · ${u.runs_today} runs today${u.ownLlmKey ? ' · own LLM key' : ''} · joined ${esc(u.created_at.slice(0, 10))}</small></div>
            ${u.role === 'operator' ? '' : `<button class="btn" data-user="${u.id}" data-action="${u.disabled ? 'enable' : 'disable'}">${u.disabled ? 'Unblock' : 'Block'}</button>`}</div>`,
        )
        .join('')}</div>`;
    s.querySelectorAll<HTMLButtonElement>('[data-user]').forEach((b) => {
      b.onclick = async () => {
        await post(`api/users/${b.dataset.user}/${b.dataset.action}`, {});
        void usersSheet();
      };
    });
  } catch (e) {
    body.innerHTML = `<p class="err">${esc((e as Error).message)}</p>`;
  }
}

// ---------- interaction ----------
let tween: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number } | null = null;
function fly(name: string) {
  const v = world.views[name];
  if (!v) return;
  tween = { from: world.camera.position.clone(), to: v.pos.clone(), tFrom: world.controls.target.clone(), tTo: v.target.clone(), t: 0 };
}

let doorTimer: ReturnType<typeof setTimeout> | undefined;
function act(spot: LobbySpot) {
  if (spot === 'console') return void (location.href = at('console/'));
  fly(spot === 'users' ? 'overview' : spot);
  if (spot === 'elevator' || spot === 'directory') {
    world.setDoors(1);
    clearTimeout(doorTimer);
    doorTimer = setTimeout(() => world.setDoors(0), 8000);
    setTimeout(() => void openElevator('lobby'), spot === 'elevator' ? 700 : 300);
  } else if (spot === 'github') void githubSheet();
  else if (spot === 'jira') void jiraSheet();
  else if (spot === 'agents') void agentsSheet();
  else if (spot === 'reception') void ticketsSheet();
  else if (spot === 'users') void usersSheet();
}

const ray = new THREE.Raycaster();
let down: { x: number; y: number } | null = null;
const canvas = world.renderer.domElement;
const pick = (e: PointerEvent) => {
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), world.camera);
  const hit = ray.intersectObjects([...world.clickable.keys()], false)[0];
  return hit ? world.clickable.get(hit.object) : undefined;
};
canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
  const spot = pick(e);
  if (spot) act(spot);
});
canvas.addEventListener('pointermove', (e) => (canvas.style.cursor = pick(e) ? 'pointer' : 'grab'));
window.addEventListener('keydown', (e) => e.key === 'Escape' && document.querySelector('.sheet-wrap') && (document.querySelector('.sheet-wrap')!.remove(), fly('overview')));

// Back from signing in or installing: open what the visitor was doing.
const reopen = new URLSearchParams(location.search).get('open') ?? (/github=installed/.test(location.search) ? 'github' : null);

void refresh()
  .finally(opened)
  .then(() => {
    if (reopen && ['github', 'jira', 'agents', 'tickets'].includes(reopen)) act((reopen === 'tickets' ? 'reception' : reopen) as LobbySpot);
  });
setInterval(refresh, 10_000);
// Arena events move the building: a floor starts or finishes.
connect((m) => (m.t === 'episode' ? void refresh() : undefined), () => {});

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (tween) {
    tween.t = Math.min(1, tween.t + dt / 1.1);
    const k = 1 - Math.pow(1 - tween.t, 3);
    world.camera.position.lerpVectors(tween.from, tween.to, k);
    world.controls.target.lerpVectors(tween.tFrom, tween.tTo, k);
    if (tween.t >= 1) tween = null;
  }
  world.tick(dt);
  world.controls.update();
  world.renderer.render(world.scene, world.camera);
  world.labels.render(world.scene, world.camera);
  requestAnimationFrame(frame);
}
frame();

