import * as THREE from 'three';
import { arrive, floorHref, light, openElevator, ride } from './elevator.ts';
import { buildLobby, type LobbySpot } from './lobby-scene.ts';
import { at, connect, getJson, readToken, saveToken, type Building } from './live.ts';
import { roundRect, wrap } from './toon.ts';
import './style.css';
import './lobby.css';

const opened = arrive();
const world = buildLobby(document.getElementById('stage')!);
const ui = document.getElementById('ui')!;
let building: Building | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const el = <T extends HTMLElement>(html: string): T => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
};

// ---------- HUD ----------
const title = el<HTMLDivElement>(`<div class="title pill"><b>SentinelQA Tower</b><div class="sub">Ground floor · lobby</div></div>`);
const views = el<HTMLDivElement>(`<div class="views">
  <button class="btn go" data-act="elevator">Elevator</button>
  <button class="btn" data-act="github">GitHub</button>
  <button class="btn" data-act="agents">Agent access</button>
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
  world.bubble.innerHTML = `<div class="bubble"><span class="state s-${live ? 'working' : 'idle'}">${live ? 'BUSY' : 'WELCOME'}</span><div class="head">${
    live ? `Floor ${live.n} is checking ${esc(b.live!.label || live.title)}` : 'All quiet. Take the lift to a floor.'
  }</div></div><div class="name">Reception</div>`;
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

async function refresh() {
  try {
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
  wrapEl.onclick = (e) => (e.target === wrapEl || (e.target as HTMLElement).dataset.close !== undefined) && close();
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

/** Operator calls carry the presenter token. */
async function post<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const send = method === 'POST';
  return getJson<T>(path, { method, headers: { ...(send ? { 'content-type': 'application/json' } : {}), 'x-arena-token': readToken() }, body: send ? JSON.stringify(body ?? {}) : undefined });
}

interface GithubStatus {
  configured: boolean;
  canSetup: boolean;
  app: { slug: string; owner: string; url: string; installUrl: string } | null;
  repos: { repo: string; defaultBranch: string; private: boolean; url: string }[];
  error: string | null;
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
  const floors = building?.floors ?? [];
  const floorFor = (repo: string) => floors.find((f) => f.id === repo);
  if (!g.configured) {
    body.innerHTML = g.canSetup
      ? `<p>Connect your GitHub account the way you would on a hosting platform. GitHub shows you a private app (read code, write checks, receive pushes) and asks you to confirm; then you pick repositories.</p>
         <p>Each repository you add gets its own floor, and every push to it runs both agents there and posts a <b>SentinelQA</b> check on the commit.</p>
         <div class="row"><input id="tok" type="password" placeholder="Presenter token" value="${esc(readToken())}" /><button class="btn go" id="connect">Connect GitHub</button></div>
         <p class="err" id="e"></p>`
      : `<p>This server has no public address (PUBLIC_URL), so GitHub cannot send it pushes.</p>`;
    s.querySelector<HTMLButtonElement>('#connect')?.addEventListener('click', async () => {
      saveToken(s.querySelector<HTMLInputElement>('#tok')!.value);
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
  body.innerHTML = `
    <p>Connected through the app <a href="${esc(g.app!.url)}" target="_blank" rel="noopener">${esc(g.app!.slug)}</a> of <b>${esc(g.app!.owner)}</b>. Pushes to these repositories run on their floor and get a check on the commit.</p>
    ${g.error ? `<p class="err">${esc(g.error)}</p>` : ''}
    <div class="repo-list">${
      g.repos.length
        ? g.repos
            .map((r) => {
              const f = floorFor(r.repo);
              const l = f ? light(f) : { cls: 'idle', text: '' };
              return `<div class="repo-row"><span class="dir-n">${f?.n ?? '·'}</span><div class="repo-t"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.repo)}</a><small><i class="dot ${l.cls}"></i>${esc(l.text)}</small></div>
                <button class="btn" data-ride="${esc(r.repo)}">Ride up</button></div>`;
            })
            .join('')
        : '<p class="muted">No repositories yet.</p>'
    }</div>
    <div class="row"><a class="btn go" href="${esc(g.app!.installUrl)}">Add or remove repositories</a><a class="btn" href="${at('console/#/github')}">Runs in the control room</a></div>`;
  body.querySelectorAll<HTMLButtonElement>('[data-ride]').forEach((b) => {
    const f = floorFor(b.dataset.ride!);
    b.onclick = () => f && ride(0, { n: f.n, label: f.title, href: floorHref(f.id) });
  });
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
  const firstRepo = b.floors.find((f) => f.kind === 'github')?.id ?? 'demo';
  const s = sheet(
    'Agent access',
    `<p>Most code is now pushed by coding agents. Give them SentinelQA as a tool: they check their own pushes against the ticket, in a real browser, and a green result cannot be earned by editing the test.</p>
    ${fresh ? `<div class="fresh"><b>New token</b>, shown once. Store it now.${copyable(fresh)}</div>` : ''}
    <h3>1 · MCP server</h3>
    <p class="muted">Claude Code (any Streamable HTTP client works with the same URL and header):</p>
    ${copyable(`claude mcp add --transport http sentinelqa ${b.agents.mcp} --header "Authorization: Bearer ${tok}"`)}
    <p class="muted">Tools: list_projects, run_check, commit_status, get_result, get_acceptance_criteria, list_runs. For stdio-only clients run <code>node sentinelqa.mjs mcp</code>.</p>
    <h3>2 · Command line</h3>
    ${copyable(`curl -fsSL ${b.agents.cli} -o sentinelqa.mjs\nnode sentinelqa.mjs login --token ${tok}\ngit push && node sentinelqa.mjs commit ${firstRepo === 'demo' ? 'owner/repo' : firstRepo} "$(git rev-parse HEAD)"`)}
    <p class="muted">Exit code 0 pass, 1 regression, 2 needs review, 3 inconclusive. <a href="${esc(b.agents.guide)}" target="_blank" rel="noopener">Guide for agents</a></p>
    <h3>3 · API tokens</h3>
    <div class="row"><input id="tok" type="password" placeholder="Presenter token" value="${esc(readToken())}" /><input id="name" placeholder="Name, e.g. claude-code laptop" />
      <select id="scope"><option value="run">run: start checks</option><option value="read">read: results only</option></select><button class="btn go" id="mint">Create token</button></div>
    <p class="err" id="e"></p>
    <div id="tokens" class="muted">Enter the presenter token to see and revoke tokens.</div>`,
  );
  wireCopy(s);
  const err = s.querySelector<HTMLParagraphElement>('#e')!;
  const list = s.querySelector<HTMLDivElement>('#tokens')!;
  const loadTokens = async () => {
    if (!readToken() && b.needsToken) return;
    try {
      const rows = await post<TokenRow[]>('api/tokens', undefined, 'GET');
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
  s.querySelector<HTMLInputElement>('#tok')!.onchange = (e) => (saveToken((e.target as HTMLInputElement).value), void loadTokens());
  s.querySelector<HTMLButtonElement>('#mint')!.onclick = async () => {
    saveToken(s.querySelector<HTMLInputElement>('#tok')!.value);
    err.textContent = '';
    try {
      const r = await post<{ token: string }>('api/tokens', { name: s.querySelector<HTMLInputElement>('#name')!.value, scope: s.querySelector<HTMLSelectElement>('#scope')!.value });
      await agentsSheet(r.token);
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  };
  void loadTokens();
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
  fly(spot === 'directory' ? 'directory' : spot);
  if (spot === 'elevator' || spot === 'directory') {
    world.setDoors(1);
    clearTimeout(doorTimer);
    doorTimer = setTimeout(() => world.setDoors(0), 8000);
    setTimeout(() => void openElevator('lobby'), spot === 'elevator' ? 700 : 300);
  } else if (spot === 'github') void githubSheet();
  else if (spot === 'agents') void agentsSheet();
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

// Back from GitHub's install page: show what is connected.
if (/github=installed|installation_id=/.test(location.search)) setTimeout(() => act('github'), 600);

void refresh().finally(opened);
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

