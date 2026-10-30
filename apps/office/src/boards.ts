import { CanvasPanel, roundRect, wrap } from './toon.ts';

export type Tone = 'info' | 'ok' | 'warn' | 'bad' | 'dim' | 'cmd' | 'add' | 'del';
export interface LogLine {
  text: string;
  tone: Tone;
}

const TONE: Record<Tone, string> = {
  info: '#e6e1da',
  ok: '#6fe08f',
  warn: '#ffc861',
  bad: '#ff6b6b',
  dim: '#8b94a3',
  cmd: '#8fd0ff',
  add: '#6fe08f',
  del: '#ff8a8a',
};

const STICKY = ['#fff1a8', '#ffd3e2', '#cdeefd', '#d7f7c8', '#ffe0b8'];

export interface TicketNote {
  id: string;
  text: string;
  rival?: 'green' | 'red' | 'rewrote' | null;
  sentinel?: string | null;
}

/** Cork board with one sticky note per acceptance criterion and each agent's mark on it. */
export function drawTickets(p: CanvasPanel, ticket: string, title: string, notes: TicketNote[]) {
  const g = p.ctx;
  g.fillStyle = '#c99a62';
  g.fillRect(0, 0, p.w, p.h);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(110,70,30,${Math.random() * 0.12})`;
    g.fillRect(Math.random() * p.w, Math.random() * p.h, 3, 3);
  }
  roundRect(g, 30, 22, p.w - 60, 74, 16);
  g.fillStyle = '#fffaf2';
  g.fill();
  g.fillStyle = '#1c1814';
  g.font = '900 40px Nunito, sans-serif';
  g.fillText(`📌 ${ticket}`, 52, 72);
  const titleX = 52 + g.measureText(`📌 ${ticket}`).width + 24;
  g.font = '700 30px Nunito, sans-serif';
  g.fillStyle = '#5a5047';
  g.fillText(title.slice(0, 48), titleX, 70);

  const cols = Math.max(1, Math.min(3, notes.length));
  const w = (p.w - 60 - (cols - 1) * 28) / cols;
  notes.slice(0, 3).forEach((n, i) => {
    const x = 30 + i * (w + 28);
    const y = 124;
    const h = p.h - 150;
    g.save();
    g.translate(x + w / 2, y + h / 2);
    g.rotate(((i % 2 ? 1 : -1) * Math.PI) / 120);
    g.translate(-(x + w / 2), -(y + h / 2));
    g.fillStyle = 'rgba(0,0,0,.18)';
    g.fillRect(x + 8, y + 10, w, h);
    g.fillStyle = STICKY[i % STICKY.length];
    g.fillRect(x, y, w, h);
    g.fillStyle = '#e04b4b';
    g.beginPath();
    g.arc(x + w / 2, y + 18, 11, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1c1814';
    g.font = '900 38px Nunito, sans-serif';
    g.fillText(n.id, x + 22, y + 72);
    g.font = '600 25px Nunito, sans-serif';
    g.fillStyle = '#3a332c';
    wrap(g, n.text.replace(/"/g, ''), w - 44)
      .slice(0, 9)
      .forEach((l, k) => g.fillText(l, x + 22, y + 112 + k * 31));
    const mark = (label: string, color: string, row: number) => {
      roundRect(g, x + 18, y + h - 104 + row * 46, w - 36, 38, 10);
      g.fillStyle = color;
      g.fill();
      g.fillStyle = '#fff';
      g.font = '800 22px Nunito, sans-serif';
      g.fillText(label, x + 30, y + h - 78 + row * 46);
    };
    if (n.rival) mark(`Fixer: ${n.rival === 'green' ? 'green' : n.rival === 'rewrote' ? 'green, test rewritten' : 'red'}`, n.rival === 'red' ? '#7a7067' : n.rival === 'rewrote' ? '#c1203a' : '#8f7ae6', 0);
    if (n.sentinel) mark(`Sentinel: ${n.sentinel.toLowerCase().replace('_', ' ')}`, n.sentinel === 'REGRESSION' ? '#c1203a' : n.sentinel === 'NEEDS_REVIEW' ? '#b7791f' : '#2f8a4e', 1);
    g.restore();
  });
  p.commit();
}

export interface ScoreView {
  status: string;
  label: string;
  truth: string | null;
  rival: { headline: string; status: string };
  sentinel: { headline: string; status: string };
  elapsed: string;
}

/** The big screen between the boards: who said what, and what was actually true. */
export function drawScore(p: CanvasPanel, s: ScoreView | null) {
  const g = p.ctx;
  const grd = g.createLinearGradient(0, 0, 0, p.h);
  grd.addColorStop(0, '#1d2230');
  grd.addColorStop(1, '#151923');
  g.fillStyle = grd;
  g.fillRect(0, 0, p.w, p.h);
  g.fillStyle = '#ffb38a';
  g.font = '900 46px Nunito, sans-serif';
  g.fillText('SCOREBOARD', 48, 80);
  if (!s) {
    g.fillStyle = '#8b94a3';
    g.font = '700 34px Nunito, sans-serif';
    g.fillText('Pick a scenario and press Start.', 48, 170);
    g.fillText('Both agents get the same ticket and the same build.', 48, 220);
    p.commit();
    return;
  }
  g.fillStyle = '#8b94a3';
  g.font = '700 28px Nunito, sans-serif';
  g.fillText(`${s.label}  ·  ${s.status}  ·  ${s.elapsed}`, 48, 126);

  const card = (x: number, name: string, color: string, d: { headline: string; status: string }) => {
    roundRect(g, x, 160, p.w / 2 - 72, 250, 22);
    g.fillStyle = '#232a3a';
    g.fill();
    g.fillStyle = color;
    g.font = '900 40px Nunito, sans-serif';
    g.fillText(name, x + 28, 216);
    g.fillStyle = d.status === 'alert' ? '#ff6b6b' : d.status === 'done' ? '#6fe08f' : '#ffc861';
    g.font = '800 26px Nunito, sans-serif';
    g.fillText(d.status.toUpperCase(), x + 28, 258);
    g.fillStyle = '#f2ede6';
    g.font = '800 36px Nunito, sans-serif';
    wrap(g, d.headline, p.w / 2 - 130)
      .slice(0, 3)
      .forEach((l, i) => g.fillText(l, x + 28, 312 + i * 42));
  };
  card(48, 'Fixer', '#b3a4ff', s.rival);
  card(p.w / 2 + 24, 'Sentinel', '#ffb38a', s.sentinel);

  if (s.truth) {
    const isBug = s.truth === 'regression';
    roundRect(g, 48, 440, p.w - 96, 150, 22);
    g.fillStyle = isBug ? '#4a1d26' : '#1d3a2a';
    g.fill();
    g.fillStyle = isBug ? '#ff9a9a' : '#8ff0ad';
    g.font = '900 36px Nunito, sans-serif';
    g.fillText(`Ground truth: ${isBug ? 'a real bug shipped in this build' : s.truth === 'drift' ? 'markup changed, behaviour did not' : 'nothing changed'}`, 76, 498);
    g.fillStyle = '#e6e1da';
    g.font = '700 28px Nunito, sans-serif';
    g.fillText(isBug ? 'The right answer is to fail the build and say why.' : 'The right answer is green, with any repair explained.', 76, 548);
  }
  p.commit();
}

/** Cork board describing the build under test. */
export function drawBuild(p: CanvasPanel, title: string, lines: string[]) {
  const g = p.ctx;
  g.fillStyle = '#c99a62';
  g.fillRect(0, 0, p.w, p.h);
  g.fillStyle = '#fffaf2';
  roundRect(g, 40, 40, p.w - 80, p.h - 80, 18);
  g.fill();
  g.fillStyle = '#d9652f';
  g.font = '900 40px Nunito, sans-serif';
  g.fillText('BUILD UNDER TEST', 80, 110);
  g.fillStyle = '#1c1814';
  g.font = '800 34px Nunito, sans-serif';
  wrap(g, title, p.w - 160)
    .slice(0, 2)
    .forEach((l, i) => g.fillText(l, 80, 168 + i * 42));
  g.fillStyle = '#4a423b';
  g.font = '600 27px Nunito, sans-serif';
  let y = 270;
  for (const line of lines) {
    for (const l of wrap(g, line, p.w - 160)) {
      if (y > p.h - 70) break;
      g.fillText(l, 80, y);
      y += 36;
    }
    y += 8;
  }
  p.commit();
}

/** Terminal on the agent's laptop: newest lines at the bottom. */
export function drawTerminal(p: CanvasPanel, title: string, lines: LogLine[]) {
  const g = p.ctx;
  g.fillStyle = '#12151c';
  g.fillRect(0, 0, p.w, p.h);
  g.fillStyle = '#1f2430';
  g.fillRect(0, 0, p.w, 38);
  for (const [i, c] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
    g.fillStyle = c;
    g.beginPath();
    g.arc(22 + i * 22, 19, 7, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#8b94a3';
  g.font = '600 18px "JetBrains Mono", monospace';
  g.fillText(title, 96, 25);
  const size = 17;
  g.font = `400 ${size}px "JetBrains Mono", monospace`;
  const maxChars = Math.floor((p.w - 24) / (size * 0.6));
  const rows: LogLine[] = [];
  for (const l of lines) for (let i = 0; i < Math.max(1, l.text.length); i += maxChars) rows.push({ text: l.text.slice(i, i + maxChars), tone: l.tone });
  const visible = Math.floor((p.h - 52) / (size + 5));
  rows.slice(-visible).forEach((l, i) => {
    g.fillStyle = TONE[l.tone] ?? TONE.info;
    g.fillText(l.text, 12, 62 + i * (size + 5));
  });
  p.commit();
}

/** Monitor with nothing streaming yet. */
export function drawIdleScreen(p: CanvasPanel, name: string, color: string, note: string) {
  const g = p.ctx;
  const grd = g.createLinearGradient(0, 0, p.w, p.h);
  grd.addColorStop(0, '#1b2030');
  grd.addColorStop(1, '#262c3d');
  g.fillStyle = grd;
  g.fillRect(0, 0, p.w, p.h);
  g.fillStyle = color;
  g.font = '900 64px Nunito, sans-serif';
  g.fillText(name, 60, p.h / 2 - 10);
  g.fillStyle = '#8b94a3';
  g.font = '700 32px Nunito, sans-serif';
  g.fillText(note, 60, p.h / 2 + 46);
  p.commit();
}

/** Draws a live browser frame, letterboxed into the monitor. */
export function drawFrame(p: CanvasPanel, img: CanvasImageSource & { width: number; height: number }, caption: string) {
  const g = p.ctx;
  g.fillStyle = '#e9edf3';
  g.fillRect(0, 0, p.w, p.h);
  // Browser chrome.
  g.fillStyle = '#d6dbe3';
  g.fillRect(0, 0, p.w, 44);
  roundRect(g, 110, 9, p.w - 140, 26, 13);
  g.fillStyle = '#fff';
  g.fill();
  g.fillStyle = '#5a6270';
  g.font = '600 17px "JetBrains Mono", monospace';
  g.fillText(caption.slice(0, 70), 126, 28);
  for (const [i, c] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
    g.fillStyle = c;
    g.beginPath();
    g.arc(24 + i * 22, 22, 7, 0, Math.PI * 2);
    g.fill();
  }
  const ah = p.h - 44;
  const scale = Math.min(p.w / img.width, ah / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  g.drawImage(img, (p.w - w) / 2, 44 + (ah - h) / 2, w, h);
  p.commit();
}
