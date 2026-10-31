import * as THREE from 'three';
import { drawBuild, drawFrame, drawIdleScreen, drawScore, drawTerminal, drawTickets, type LogLine, type TicketNote } from './boards.ts';
import { arrive, floorHref, openElevator } from './elevator.ts';
import { FrameDecoder, at, connect, floorOf, getJson, getMe, goSignIn, type AgentId, type ArenaInfo, type ArenaMsg, type Building, type EpisodeSnap, type FloorInfo, type Me, type Status } from './live.ts';
import { buildOffice } from './office.ts';
import './style.css';

const opened = arrive();
const world = buildOffice(document.getElementById('stage')!);
const ui = document.getElementById('ui')!;

const NAMES: Record<AgentId, string> = { rival: 'Fixer', sentinel: 'Sentinel' };
const COLORS: Record<AgentId, string> = { rival: '#b3a4ff', sentinel: '#ffb38a' };
const DOT: Record<Status, string> = { idle: '#e9e3da', working: '#ffd166', thinking: '#b9a4ff', done: '#5fd68a', alert: '#ff5c5c' };

let info: ArenaInfo | null = null;
let episode: EpisodeSnap | null = null;
const logs: Record<AgentId, LogLine[]> = { rival: [], sentinel: [] };
const state: Record<AgentId, { status: Status; headline: string }> = {
  rival: { status: 'idle', headline: 'waiting for a build' },
  sentinel: { status: 'idle', headline: 'waiting for a build' },
};
const lastFrame: Partial<Record<AgentId, string>> = {};
let criteria: { id: string; text: string }[] = [];
let connected = false;
const params = new URLSearchParams(location.search);
/** ?episode=ID shows that run (from a GitHub check, say) instead of following the floor live. */
const pinned = Number(params.get('episode')) || null;
/** ?floor=<project>: the demo, or owner/repo of a connected repository. */
let myFloor = params.get('floor') ?? 'demo';
let floor: FloorInfo | null = null;
/** The episode on screen; live messages about any other are skipped. */
let shownId: number | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const el = <T extends HTMLElement>(html: string): T => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
};

// ---------- HUD ----------
const title = el<HTMLDivElement>(`<div class="title pill"><b class="floor-name">SentinelQA Office</b><div class="sub">connecting…</div><div class="sub" id="why" hidden></div><a class="btn live-btn" hidden>● Follow this floor live</a></div>`);
const views = el<HTMLDivElement>(`<div class="views">
  <button class="btn" data-view="overview">Overview</button>
  <button class="btn" data-view="rival">Fixer's desk</button>
  <button class="btn" data-view="sentinel">Sentinel's desk</button>
  <button class="btn" data-view="boards">Boards</button>
  <button class="btn go" data-act="elevator">Elevator</button>
  <a class="btn" href="${at('console/')}">Control room ↗</a>
</div>`);
const controls = el<HTMLDivElement>(`<div class="controls pill">
  <div class="row"><label style="flex:1">Ticket</label><label style="flex:1" class="demo-only">Build under test</label><label style="flex:1" class="repo-only" hidden>Branch</label></div>
  <div class="row">
    <select id="ticket" style="flex:1"></select>
    <select id="kind" style="flex:1" class="demo-only"><option value="shoplite">ShopLite scenario</option><option value="repo">Repository branch</option><option value="url">Public URL</option></select>
    <input id="branch" class="repo-only" placeholder="main" style="flex:1" hidden />
  </div>
  <select id="scenario" class="demo-only"></select>
  <div class="row" id="repoRow" hidden><select id="repo" style="flex:2"></select><select id="ref" style="flex:1"></select></div>
  <input id="url" placeholder="https://your-app.example.com" hidden />
  <div class="row"><button class="btn go" id="start" style="flex:1">▶ Start episode</button><span class="note" id="model"></span></div>
  <div class="err" id="err"></div>
</div>`);
const status = el<HTMLDivElement>(`<div class="status"></div>`);
const hint = el<HTMLDivElement>(`<div class="hint pill">Drag to look around · click a screen to open it</div>`);
ui.append(title, views, controls, status, hint);
const $ = <T extends HTMLElement>(id: string) => controls.querySelector<T>(`#${id}`)!;

for (const id of ['rival', 'sentinel'] as AgentId[]) {
  const card = el<HTMLDivElement>(`<div class="agent pill" data-agent="${id}"><span class="dot"></span><div style="min-width:0"><div class="who">${NAMES[id]}</div><div class="what"></div></div></div>`);
  card.onclick = () => openPanel(id);
  status.append(card);
}

// ---------- camera ----------
let tween: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number } | null = null;
function fly(name: string) {
  const v = world.views[name];
  if (!v) return;
  tween = { from: world.camera.position.clone(), to: v.pos.clone(), tFrom: world.controls.target.clone(), tTo: v.target.clone(), t: 0 };
  views.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.view === name));
}
views.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => (b.onclick = () => fly(b.dataset.view!)));

// ---------- drawing ----------
const dirty = { terminal: { rival: true, sentinel: true }, boards: true };

function renderStatus() {
  for (const id of ['rival', 'sentinel'] as AgentId[]) {
    const s = state[id];
    const desk = world.desks[id];
    desk.robot.setMood(s.status);
    desk.tag.innerHTML = `<div class="bubble"><span class="state s-${s.status}">${s.status.toUpperCase()}</span><div class="head">${esc(s.headline)}</div></div><div class="name">${NAMES[id]}</div>`;
    const card = status.querySelector<HTMLDivElement>(`[data-agent="${id}"]`)!;
    card.querySelector<HTMLSpanElement>('.dot')!.style.background = DOT[s.status];
    card.querySelector<HTMLDivElement>('.what')!.textContent = `${s.status} · ${s.headline}`;
    if (!lastFrame[id]) drawIdleScreen(desk.browser, NAMES[id], COLORS[id], s.status === 'idle' ? 'waiting for a build' : 'starting the browser…');
  }
  dirty.boards = true;
}

function elapsed(): string {
  if (!episode) return '';
  const end = episode.finishedAt ?? Date.now();
  return `${Math.round((end - episode.startedAt) / 1000)} s`;
}

function scenarioOf(ep: EpisodeSnap) {
  const muts = ep.request.target.mutations ?? [];
  return info?.scenarios.find((s) => s.mutations.join() === muts.join());
}

function buildLine(ep: EpisodeSnap): string {
  const t = ep.request.target;
  if (ep.trigger?.kind === 'jira') return `Jira ${ep.trigger.key} reached QA: its criteria, on this build`;
  if (ep.trigger?.kind === 'github' && ep.trigger.event === 'jira') return `Jira ${ep.request.ticket} reached QA: checking ${ep.trigger.ref}`.slice(0, 90);
  if (ep.trigger?.kind === 'github') return `${ep.trigger.event === 'push' ? 'Pushed' : 'Run'} by ${ep.trigger.author || 'GitHub'}: ${ep.trigger.message}`.slice(0, 90);
  if (t.kind === 'url') return `Deployed at ${t.baseUrl}`;
  return `Branch ${t.ref} of ${t.id}`;
}

function renderBoards() {
  if (!dirty.boards) return;
  dirty.boards = false;
  if (episode) {
    drawScore(world.score, {
      status: episode.status === 'failed' ? `failed: ${episode.error}` : episode.status,
      label: episode.label || 'preparing',
      truth: episode.status === 'finished' ? episode.truth : null,
      rival: state.rival,
      sentinel: state.sentinel,
      elapsed: elapsed(),
    });
    const sc = scenarioOf(episode);
    drawBuild(world.build, episode.label || 'preparing…', [
      sc ? sc.title : buildLine(episode),
      episode.truth ? `Ground truth: ${episode.truth} (revealed when both agents finish)` : episode.trigger?.kind === 'github' ? 'A real commit: no answer key, the verdict is the result' : 'Ground truth: unknown to the agents',
      'Both agents get the same ticket, the same test and the same build.',
    ]);
  } else {
    drawScore(world.score, null);
  }
  const notes: TicketNote[] = criteria.map((c) => {
    const r = episode?.results.rival?.find((x) => x.criterion === c.id);
    const s = episode?.results.sentinel?.find((x) => x.criterion === c.id);
    return { id: c.id, text: c.text, rival: r ? (r.green ? (r.editedAssertions ? 'rewrote' : 'green') : 'red') : null, sentinel: s?.verdict ?? null };
  });
  const t = info?.tickets.find((x) => x.key === (episode?.request.ticket ?? $<HTMLSelectElement>('ticket').value));
  drawTickets(world.tickets, t?.key ?? 'SHOP-42', t?.title ?? '', notes);
}

function renderTerminals() {
  for (const id of ['rival', 'sentinel'] as AgentId[]) {
    if (!dirty.terminal[id]) continue;
    dirty.terminal[id] = false;
    drawTerminal(world.desks[id].terminal, `${NAMES[id].toLowerCase()}@office`, logs[id].length ? logs[id] : [{ text: '$ ready', tone: 'dim' }]);
    if (panel?.agent === id) fillPanelLog();
  }
}

// ---------- full-size panel ----------
let panel: { agent: AgentId; root: HTMLDivElement } | null = null;

function openPanel(agent: AgentId) {
  closePanel();
  const root = el<HTMLDivElement>(`<div class="overlay"><div class="panel">
    <header><span class="dot" style="width:12px;height:12px;border-radius:50%;border:2px solid #2a2420"></span><b>${NAMES[agent]}</b><span class="grow"></span><button class="btn" data-close>Close (Esc)</button></header>
    <div class="body"><div class="shot"><img alt="${NAMES[agent]}'s browser, live" /></div><pre class="term"></pre></div>
  </div></div>`);
  root.onclick = (e) => {
    if (e.target === root || (e.target as HTMLElement).dataset.close !== undefined) closePanel();
  };
  ui.append(root);
  panel = { agent, root };
  fillPanelLog();
  if (lastFrame[agent]) root.querySelector('img')!.src = `data:image/jpeg;base64,${lastFrame[agent]}`;
}

function fillPanelLog() {
  if (!panel) return;
  const { agent, root } = panel;
  const s = state[agent];
  root.querySelector<HTMLSpanElement>('.dot')!.style.background = DOT[s.status];
  root.querySelector<HTMLSpanElement>('.grow')!.textContent = `${info?.desks[agent].role ?? ''} · ${s.status}: ${s.headline}`;
  const term = root.querySelector<HTMLPreElement>('.term')!;
  const atBottom = term.scrollTop + term.clientHeight >= term.scrollHeight - 30;
  term.innerHTML = logs[agent].map((l) => `<span class="t-${l.tone}">${esc(l.text)}</span>`).join('\n');
  if (atBottom) term.scrollTop = term.scrollHeight;
}

function closePanel() {
  panel?.root.remove();
  panel = null;
}
window.addEventListener('keydown', (e) => e.key === 'Escape' && closePanel());

// Click a monitor or laptop in the scene to open it.
const ray = new THREE.Raycaster();
let down: { x: number; y: number } | null = null;
world.renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
world.renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
  const r = world.renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), world.camera);
  const hit = ray.intersectObjects([...world.clickable.keys(), ...world.lift], false)[0];
  if (hit && world.lift.has(hit.object)) void openElevator(myFloor);
  else if (hit) openPanel(world.clickable.get(hit.object)!.desk);
});
world.renderer.domElement.addEventListener('pointermove', (e) => {
  const r = world.renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), world.camera);
  world.renderer.domElement.style.cursor = ray.intersectObjects([...world.clickable.keys(), ...world.lift], false).length ? 'pointer' : 'grab';
});

// ---------- live data ----------
const frames = new FrameDecoder((agent, img, data) => {
  lastFrame[agent] = data;
  drawFrame(world.desks[agent].browser, img, episode?.label ?? '');
  img.close();
  if (panel?.agent === agent) panel.root.querySelector('img')!.src = `data:image/jpeg;base64,${data}`;
});

function applyEpisode(ep: EpisodeSnap | null) {
  const fresh = ep && ep.id !== episode?.id;
  episode = ep;
  shownId = ep?.id ?? null;
  if (ep) {
    for (const id of ['rival', 'sentinel'] as AgentId[]) {
      logs[id] = ep.desks[id].log.map((l) => ({ text: l.text, tone: l.tone }));
      state[id] = { status: ep.desks[id].status, headline: ep.desks[id].headline };
      dirty.terminal[id] = true;
      if (fresh) delete lastFrame[id];
    }
    if (fresh) void loadCriteria(ep.request.ticket, ep.criteria);
  }
  renderControls();
  title.querySelector('.sub')!.textContent = ep
    ? `#${ep.id} · ${ep.request.ticket} · ${ep.label || 'preparing'} · ${ep.status}${pinned ? ' (replay)' : ''}`
    : `${connected ? 'live' : 'offline'} · no runs on this floor yet`;
  const why = title.querySelector<HTMLDivElement>('#why')!;
  const tr = ep?.trigger;
  why.hidden = tr?.kind !== 'github' && tr?.kind !== 'jira';
  if (tr?.kind === 'github') why.textContent = `${tr.event === 'push' ? 'git push' : tr.event === 'jira' ? `Jira ${ep!.request.ticket}` : 'run'} · ${tr.repo}@${tr.ref} · ${tr.sha.slice(0, 7)} ${tr.message}`;
  if (tr?.kind === 'jira') why.textContent = `Jira ${tr.key} moved to QA`;
  renderStatus();
}

let liveSnap: EpisodeSnap | null = null;
/** The arena is busy, maybe with a run this viewer cannot see, and how many wait in all. */
let liveBusy = false;
let liveWaiting = 0;
let me: Me | null = null;
/** A floor someone else owns: nothing of it is shown. */
let privateFloor = false;

function renderControls() {
  const busy = liveBusy;
  const waiting = liveWaiting;
  const verb = floor?.kind === 'github' ? 'Run branch' : 'Start episode';
  const start = $<HTMLButtonElement>('start');
  if (!info?.signedIn) start.textContent = me?.signIn ? '→ Sign in with GitHub to run' : '▶ Sign-in is not open yet';
  else start.textContent = busy ? `＋ ${verb} (queued${waiting ? `, ${waiting} waiting` : ''})` : `▶ ${verb}`;
  start.disabled = Boolean(!info?.signedIn && !me?.signIn) || privateFloor;
  const follow = title.querySelector<HTMLAnchorElement>('.live-btn')!;
  follow.hidden = !pinned;
  follow.href = floorHref(myFloor);
  // The queue is shared by the whole building: say when another floor has it.
  const elsewhere = busy && (!liveSnap || floorOf(liveSnap) !== myFloor);
  $('model').textContent = elsewhere ? 'Another floor has the arena; runs here wait their turn' : info?.model ? `Fixer uses ${info.model}` : '';
}

function onMsg(m: ArenaMsg) {
  if (m.t === 'hello' || m.t === 'episode') {
    liveSnap = m.episode;
    liveBusy = m.busy;
    liveWaiting = m.waiting;
    if (privateFloor) return renderControls();
    // Follow this floor: a new run here takes the screens; runs on other floors do not.
    const mine = m.episode && floorOf(m.episode) === myFloor;
    if (m.episode && (m.episode.id === shownId || (!pinned && mine))) return applyEpisode(m.episode);
    return renderControls();
  }
  if (m.episode !== shownId) return;
  if (m.t === 'frame') return frames.push(m.agent, m.data);
  if (m.t === 'log') {
    logs[m.agent].push({ text: m.text, tone: m.tone });
    if (logs[m.agent].length > 600) logs[m.agent].splice(0, logs[m.agent].length - 600);
    dirty.terminal[m.agent] = true;
    return;
  }
  if (m.t === 'state') {
    state[m.agent] = { status: m.status, headline: m.headline };
    renderStatus();
  }
}

async function loadCriteria(ticket: string, known?: { id: string; text: string }[]) {
  if (known?.length) {
    criteria = known;
    dirty.boards = true;
    return;
  }
  try {
    const d = await getJson<{ ticket: { criteria: { id: string; text: string }[] } }>(`api/tickets/${ticket}`);
    criteria = d.ticket.criteria;
  } catch {
    criteria = [];
  }
  dirty.boards = true;
}

// ---------- controls ----------
function syncKind() {
  const kind = $<HTMLSelectElement>('kind').value;
  $('scenario').hidden = kind !== 'shoplite';
  $('repoRow').hidden = kind !== 'repo';
  $('url').hidden = kind !== 'url';
}
$<HTMLSelectElement>('kind').onchange = syncKind;
$<HTMLSelectElement>('repo').onchange = () => {
  const r = info?.repos.find((x) => x.id === $<HTMLSelectElement>('repo').value);
  $<HTMLSelectElement>('ref').innerHTML = (r?.refs ?? []).map((ref) => `<option>${esc(ref)}</option>`).join('');
};
$<HTMLSelectElement>('ticket').onchange = () => void loadCriteria($<HTMLSelectElement>('ticket').value);

$<HTMLButtonElement>('start').onclick = async () => {
  $('err').textContent = '';
  if (!info?.signedIn) {
    if (me) goSignIn(me, `office/?floor=${encodeURIComponent(myFloor)}`);
    return;
  }
  if (floor?.kind === 'github') {
    try {
      const r = await getJson<{ id: number }>('api/github/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: myFloor, ref: $<HTMLInputElement>('branch').value.trim() || floor.defaultRef, ticket: $<HTMLSelectElement>('ticket').value }),
      });
      if (pinned) location.href = floorHref(myFloor);
      else $('err').textContent = `Run #${r.id} is on its way to this floor.`;
    } catch (e) {
      $('err').textContent = (e as Error).message;
    }
    return;
  }
  const kind = $<HTMLSelectElement>('kind').value;
  const target =
    kind === 'shoplite'
      ? { kind, mutations: info?.scenarios.find((s) => s.id === $<HTMLSelectElement>('scenario').value)?.mutations ?? [] }
      : kind === 'repo'
        ? { kind, id: $<HTMLSelectElement>('repo').value, ref: $<HTMLSelectElement>('ref').value }
        : { kind, baseUrl: $<HTMLInputElement>('url').value.trim() };
  try {
    const r = await getJson<{ id: number; status: string }>('api/arena/episodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: $<HTMLSelectElement>('ticket').value, target }),
    });
    if (pinned) location.href = floorHref(myFloor);
    else if (r.status === 'queued') $('err').textContent = `Queued as #${r.id}; it starts when the current episode ends.`;
    else fly('overview');
  } catch (e) {
    $('err').textContent = (e as Error).message;
  }
};

/** Floor number, name and the controls that fit it. */
async function loadFloor() {
  try {
    const b = await getJson<Building>('api/building');
    floor = b.floors.find((f) => f.id === myFloor) ?? null;
  } catch {
    floor = null;
  }
  // Someone else's repository: the floor exists, but nothing of it is shown.
  privateFloor = myFloor !== 'demo' && !floor;
  const name = floor ? `Floor ${floor.n} · ${floor.title}${floor.jira.length ? ` · Jira ${floor.jira.join(', ')}` : ''}` : myFloor === 'demo' ? 'ShopLite demo' : 'Private floor';
  title.querySelector('.floor-name')!.textContent = name;
  document.title = `${name} · SentinelQA Tower`;
  const repo = floor?.kind === 'github';
  controls.querySelectorAll<HTMLElement>('.demo-only').forEach((e) => (e.hidden = repo));
  controls.querySelectorAll<HTMLElement>('.repo-only').forEach((e) => (e.hidden = !repo));
  if (repo) {
    $('scenario').hidden = $('repoRow').hidden = $('url').hidden = true;
    $<HTMLInputElement>('branch').placeholder = floor!.defaultRef ?? 'main';
    // Start from the repository's default ticket.
    const mine = await getJson<{ repos: { repo: string; defaultTicket: string | null }[] }>('api/github').catch(() => null);
    const t = mine?.repos.find((r) => r.repo === myFloor)?.defaultTicket;
    if (t) $<HTMLSelectElement>('ticket').value = t;
  }
  if (privateFloor) {
    applyEpisode(null);
    title.querySelector('.sub')!.textContent = me?.user ? 'This floor belongs to someone else.' : 'Sign in to see your own floors.';
    $('err').textContent = '';
  }
  renderControls();
}

views.querySelector<HTMLButtonElement>('[data-act="elevator"]')!.onclick = () => void openElevator(myFloor);

async function init() {
  try {
    info = await getJson<ArenaInfo>('api/arena');
  } catch (e) {
    $('err').textContent = `Cannot reach the SentinelQA server: ${(e as Error).message}`;
    return;
  }
  $<HTMLSelectElement>('ticket').innerHTML = info.tickets.map((t) => `<option value="${esc(t.key)}">${esc(t.key)} · ${esc(t.title)}</option>`).join('');
  $<HTMLSelectElement>('scenario').innerHTML = info.scenarios.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
  $<HTMLSelectElement>('repo').innerHTML = info.repos.map((r) => `<option value="${esc(r.id)}">${esc(r.title)}</option>`).join('');
  $<HTMLSelectElement>('repo').dispatchEvent(new Event('change'));
  if (!info.repos.length) $<HTMLSelectElement>('kind').querySelector('option[value="repo"]')!.setAttribute('disabled', '');
  $('model').textContent = info.model ? `Fixer uses ${info.model}` : 'No LLM key: the Fixer cannot run';
  me = await getMe().catch(() => null);
  syncKind();
  liveSnap = info.episode;
  liveBusy = info.busy;
  liveWaiting = info.waiting;
  const replay = async (id: number) => {
    const r = await getJson<{ episode: EpisodeSnap; frames: Partial<Record<AgentId, string>> }>(`api/arena/episodes/${id}`);
    if (!params.get('floor')) myFloor = floorOf(r.episode);
    applyEpisode(r.episode);
    for (const [agent, data] of Object.entries(r.frames)) frames.push(agent as AgentId, data!);
  };
  try {
    if (pinned) await replay(pinned);
    else if (info.episode && floorOf(info.episode) === myFloor) applyEpisode(info.episode);
    else {
      // A quiet floor shows its last run until a new one starts here.
      const [last] = await getJson<{ id: number }[]>(`api/arena/episodes?floor=${encodeURIComponent(myFloor)}&limit=1`);
      if (last) await replay(last.id);
      else applyEpisode(null);
    }
  } catch (e) {
    $('err').textContent = (e as Error).message;
  }
  await loadFloor();
  await loadCriteria(episode?.request.ticket ?? info.tickets[0]?.key ?? 'SHOP-42', episode?.criteria);
  connect(onMsg, (c) => {
    connected = c;
    if (!episode) title.querySelector('.sub')!.textContent = `${c ? 'live' : 'offline'} · no runs on this floor yet`;
  });
}

renderStatus();
void init().finally(opened);

// ---------- loop ----------
const clock = new THREE.Clock();
let secondTimer = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (tween) {
    tween.t = Math.min(1, tween.t + dt / 1.1);
    const k = 1 - Math.pow(1 - tween.t, 3);
    world.camera.position.lerpVectors(tween.from, tween.to, k);
    world.controls.target.lerpVectors(tween.tFrom, tween.tTo, k);
    if (tween.t >= 1) tween = null;
  }
  secondTimer += dt;
  if (secondTimer > 1 && episode && !episode.finishedAt) {
    secondTimer = 0;
    dirty.boards = true;
  }
  renderTerminals();
  renderBoards();
  world.tick(dt);
  world.controls.update();
  world.renderer.render(world.scene, world.camera);
  world.labels.render(world.scene, world.camera);
  requestAnimationFrame(frame);
}
frame();
