import { at, getJson, type Building, type FloorInfo } from './live.ts';
import './elevator.css';

/**
 * The lift between the lobby (G) and the floors: one floor per project. Picking a floor closes the
 * doors, counts the floors past and opens them on the next page.
 */

const KEY = 'sqa-ride';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function floorHref(id: string): string {
  return id === 'lobby' ? at('./') : at(`office/?floor=${encodeURIComponent(id)}`);
}

export function light(f: Pick<FloorInfo, 'live' | 'queued' | 'last'>): { cls: string; text: string } {
  if (f.live) return { cls: 'run', text: 'running now' };
  if (f.queued) return { cls: 'run', text: `${f.queued} queued` };
  const c = f.last?.conclusion;
  if (!f.last) return { cls: 'idle', text: 'no runs yet' };
  if (!c) return { cls: 'run', text: f.last.status };
  return { cls: c === 'success' ? 'ok' : c === 'failure' ? 'bad' : 'warn', text: f.last.title ?? c };
}

/** Doors close over the page, the indicator counts to the target, then we go there. */
export function ride(fromN: number, to: { n: number; label: string; href: string }) {
  const doors = doorsEl(fromN, 'closing');
  document.body.append(doors);
  const ind = doors.querySelector<HTMLDivElement>('.lift-num')!;
  const dir = doors.querySelector<HTMLDivElement>('.lift-dir')!;
  dir.textContent = to.n > fromN ? '▲' : to.n < fromN ? '▼' : '•';
  doors.querySelector('.lift-to')!.textContent = to.label;
  requestAnimationFrame(() => doors.classList.add('shut'));
  let n = fromN;
  const step = () => {
    if (n !== to.n) {
      n += Math.sign(to.n - n);
      ind.textContent = label(n);
      setTimeout(step, Math.max(160, 600 / Math.max(1, Math.abs(to.n - fromN))));
      return;
    }
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ n: to.n, label: to.label }));
    } catch {
      // private window: no arrival animation
    }
    setTimeout(() => (location.href = to.href), 250);
  };
  setTimeout(step, 650);
}

/**
 * Call as a page starts: if we came by lift, the doors are shut over it at once. The returned
 * function opens them; call it when the floor is ready.
 */
export function arrive(): () => void {
  let r: { n: number; label: string } | null = null;
  try {
    r = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    sessionStorage.removeItem(KEY);
  } catch {
    r = null;
  }
  if (!r) return () => {};
  const doors = doorsEl(r.n, 'arriving');
  doors.classList.add('shut');
  doors.querySelector('.lift-to')!.textContent = r.label;
  document.body.append(doors);
  let opened = false;
  const open = () => {
    if (opened) return;
    opened = true;
    setTimeout(() => doors.classList.remove('shut'), 250);
    setTimeout(() => doors.remove(), 1300);
  };
  // Never keep anyone shut in a lift.
  setTimeout(open, 4000);
  return open;
}

const label = (n: number) => (n === 0 ? 'G' : String(n));

function doorsEl(n: number, mode: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = `lift ${mode}`;
  d.innerHTML = `<div class="lift-door l"></div><div class="lift-door r"></div>
    <div class="lift-display"><span class="lift-dir"></span><span class="lift-num">${label(n)}</span><span class="lift-to"></span></div>`;
  return d;
}

/** The panel of floor buttons. `current` is 'lobby' or a floor id. */
export async function openElevator(current: string) {
  document.querySelector('.lift-panel-wrap')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'lift-panel-wrap';
  wrap.innerHTML = `<div class="lift-panel" role="dialog" aria-label="Elevator">
    <div class="lift-head"><b>Elevator</b><span>Pick a floor</span><button class="lift-x" aria-label="Close">✕</button></div>
    <div class="lift-buttons"><div class="lift-loading">Calling the lift…</div></div>
  </div>`;
  const close = () => wrap.remove();
  wrap.onclick = (e) => e.target === wrap && close();
  wrap.querySelector<HTMLButtonElement>('.lift-x')!.onclick = close;
  window.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') (close(), window.removeEventListener('keydown', esc));
  });
  document.body.append(wrap);

  let b: Building;
  try {
    b = await getJson<Building>('api/building');
  } catch (e) {
    wrap.querySelector('.lift-buttons')!.innerHTML = `<div class="lift-loading">The lift is out of order: ${esc((e as Error).message)}</div>`;
    return;
  }
  const here = current === 'lobby' ? 0 : (b.floors.find((f) => f.id === current)?.n ?? 0);
  const rows = [...b.floors].reverse().map((f) => {
    const l = light(f);
    return `<button class="lift-btn ${f.n === here ? 'here' : ''}" data-n="${f.n}" data-id="${esc(f.id)}" data-label="${esc(f.title)}">
      <span class="lift-round">${f.n}</span>
      <span class="lift-name"><b>${esc(f.title)}</b><small><i class="dot ${l.cls}"></i>${esc(l.text)}</small></span>
    </button>`;
  });
  rows.push(`<button class="lift-btn ${here === 0 ? 'here' : ''}" data-n="0" data-id="lobby" data-label="Lobby">
    <span class="lift-round">G</span><span class="lift-name"><b>Lobby</b><small>GitHub, agent access, control room</small></span></button>`);
  if (!b.github.configured) rows.splice(rows.length - 1, 0, `<div class="lift-note">Connect GitHub in the lobby: every repository you add gets its own floor.</div>`);
  wrap.querySelector('.lift-buttons')!.innerHTML = rows.join('');
  wrap.querySelectorAll<HTMLButtonElement>('.lift-btn').forEach((btn) => {
    btn.onclick = () => {
      const n = Number(btn.dataset.n);
      if (n === here) return close();
      close();
      ride(here, { n, label: btn.dataset.label!, href: floorHref(btn.dataset.id!) });
    };
  });
}
