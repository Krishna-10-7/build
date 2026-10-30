import * as THREE from 'three';
import { drawBuild, drawFrame, drawIdleScreen, drawScore, drawTerminal, drawTickets, type LogLine, type TicketNote } from './boards.ts';
import { FrameDecoder, connect, getJson, type AgentId, type ArenaInfo, type ArenaMsg, type EpisodeSnap, type Status } from './live.ts';
import { buildOffice } from './office.ts';
import './style.css';

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
/** ?episode=ID shows that run (from a GitHub check, say) instead of following the live one. */
const pinned = Number(new URLSearchParams(location.search).get('episode')) || null;
let liveId: number | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const el = <T extends HTMLElement>(html: string): T => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
};

// ---------- HUD ----------
const title = el<HTMLDivElement>(`<div class="title pill"><b>SentinelQA Office</b><div class="sub">connecting…</div><div class="sub" id="why" hidden></div><a class="btn live-btn" href="./" hidden>● Back to live</a></div>`);
const views = el<HTMLDivElement>(`<div class="views">
  <button class="btn" data-view="overview">Overview</button>
  <button class="btn" data-view="rival">Fixer's desk</button>
  <button class="btn" data-view="sentinel">Sentinel's desk</button>
  <button class="btn" data-view="boards">Boards</button>
  <a class="btn" href="../#/github" target="_blank" rel="noopener">GitHub ↗</a>
  <a class="btn" href="../" target="_blank" rel="noopener">Dashboard ↗</a>
</div>`);
const controls = el<HTMLDivElement>(`<div class="controls pill">
  <div class="row"><label style="flex:1">Ticket</label><label style="flex:1">Build under test</label></div>
  <div class="row">
    <select id="ticket" style="flex:1"></select>
    <select id="kind" style="flex:1"><option value="shoplite">ShopLite scenario</option><option value="repo">Repository branch</option><option value="url">Public URL</option></select>
  </div>
  <select id="scenario"></select>
  <div class="row" id="repoRow" hidden><select id="repo" style="flex:2"></select><select id="ref" style="flex:1"></select></div>
  <input id="url" placeholder="https://your-app.example.com" hidden />
  <input id="token" type="password" placeholder="Presenter token" hidden />
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
  const hit = ray.intersectObjects([...world.clickable.keys()], false)[0];
  if (hit) openPanel(world.clickable.get(hit.object)!.desk);
});
world.renderer.domElement.addEventListener('pointermove', (e) => {
  const r = world.renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), world.camera);
  world.renderer.domElement.style.cursor = ray.intersectObjects([...world.clickable.keys()], false).length ? 'pointer' : 'grab';
});

// ---------- live data ----------
const frames = new FrameDecoder((agent, img, data) => {
  lastFrame[agent] = data;
  drawFrame(world.desks[agent].browser, img, episode?.label ?? '');
  img.close();
  if (panel?.agent === agent) panel.root.querySelector('img')!.src = `data:image/jpeg;base64,${data}`;
});

/** A live message about another episode than the one on screen is skipped while a replay is pinned. */
const showing = (id: number | null | undefined) => !pinned || id === pinned;

function applyEpisode(ep: EpisodeSnap | null) {
  const fresh = ep && ep.id !== episode?.id;
  episode = ep;
  if (ep) {
    for (const id of ['rival', 'sentinel'] as AgentId[]) {
      logs[id] = ep.desks[id].log.map((l) => ({ text: l.text, tone: l.tone }));
      state[id] = { status: ep.desks[id].status, headline: ep.desks[id].headline };
      dirty.terminal[id] = true;
      if (fresh) delete lastFrame[id];
    }
    if (fresh) void loadCriteria(ep.request.ticket);
  }
  renderControls();
  title.querySelector('.sub')!.textContent = ep ? `#${ep.id} · ${ep.request.ticket} · ${ep.label || 'preparing'} · ${ep.status}${pinned ? ' (replay)' : ''}` : `${connected ? 'live' : 'offline'} · no episode yet`;
  const why = title.querySelector<HTMLDivElement>('#why')!;
  const tr = ep?.trigger;
  why.hidden = tr?.kind !== 'github';
  if (tr?.kind === 'github') why.textContent = `${tr.event === 'push' ? 'git push' : 'run'} · ${tr.repo}@${tr.ref} · ${tr.sha.slice(0, 7)} ${tr.message}`;
  renderStatus();
}

let liveSnap: EpisodeSnap | null = null;
function renderControls() {
  const busy = liveSnap && (liveSnap.status === 'preparing' || liveSnap.status === 'running');
  const waiting = liveSnap?.queue?.length ?? 0;
  $<HTMLButtonElement>('start').textContent = busy ? `＋ Add to queue${waiting ? ` (${waiting} waiting)` : ''}` : '▶ Start episode';
  title.querySelector<HTMLAnchorElement>('.live-btn')!.hidden = !pinned || pinned === liveId;
}

function onMsg(m: ArenaMsg) {
  if (m.t === 'hello' || m.t === 'episode') {
    liveSnap = m.episode;
    liveId = m.episode?.id ?? null;
    if (showing(liveId)) return applyEpisode(m.episode);
    return renderControls();
  }
  if (!showing(m.episode)) return;
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

async function loadCriteria(ticket: string) {
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
  const kind = $<HTMLSelectElement>('kind').value;
  const target =
    kind === 'shoplite'
      ? { kind, mutations: info?.scenarios.find((s) => s.id === $<HTMLSelectElement>('scenario').value)?.mutations ?? [] }
      : kind === 'repo'
        ? { kind, id: $<HTMLSelectElement>('repo').value, ref: $<HTMLSelectElement>('ref').value }
        : { kind, baseUrl: $<HTMLInputElement>('url').value.trim() };
  const token = $<HTMLInputElement>('token').value;
  try {
    localStorage.setItem('arenaToken', token);
  } catch {
    // private window
  }
  $('err').textContent = '';
  try {
    const r = await getJson<{ id: number; status: string }>('api/arena/episodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-arena-token': token },
      body: JSON.stringify({ ticket: $<HTMLSelectElement>('ticket').value, target }),
    });
    if (pinned) location.href = './';
    else if (r.status === 'queued') $('err').textContent = `Queued as #${r.id}; it starts when the current episode ends.`;
    else fly('overview');
  } catch (e) {
    $('err').textContent = (e as Error).message;
  }
};

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
  if (info.needsToken) {
    $('token').hidden = false;
    try {
      $<HTMLInputElement>('token').value = localStorage.getItem('arenaToken') ?? '';
    } catch {
      // private window
    }
  }
  syncKind();
  liveSnap = info.episode;
  liveId = info.episode?.id ?? null;
  if (pinned) {
    try {
      const r = await getJson<{ episode: EpisodeSnap; frames: Partial<Record<AgentId, string>> }>(`api/arena/episodes/${pinned}`);
      applyEpisode(r.episode);
      for (const [agent, data] of Object.entries(r.frames)) frames.push(agent as AgentId, data!);
    } catch (e) {
      $('err').textContent = `Episode #${pinned}: ${(e as Error).message}`;
    }
  } else applyEpisode(info.episode);
  await loadCriteria(episode?.request.ticket ?? info.tickets[0]?.key ?? 'SHOP-42');
  connect(onMsg, (c) => {
    connected = c;
    if (!episode) title.querySelector('.sub')!.textContent = `${c ? 'live' : 'offline'} · no episode yet`;
  });
}

renderStatus();
void init();

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
