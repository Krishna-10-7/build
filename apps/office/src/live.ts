import type { LogLine, Tone } from './boards.ts';

export type AgentId = 'rival' | 'sentinel';
export type Status = 'idle' | 'working' | 'thinking' | 'done' | 'alert';

export interface DeskSnap {
  status: Status;
  headline: string;
  log: (LogLine & { at: number })[];
}

export type Trigger =
  | { kind: 'manual' }
  | { kind: 'github'; event: 'push' | 'manual'; repo: string; ref: string; sha: string; message: string; author: string; url: string };

export interface EpisodeSnap {
  id: number;
  status: 'queued' | 'preparing' | 'running' | 'finished' | 'failed';
  request: { ticket: string; target: { kind: string; mutations?: string[]; baseUrl?: string; id?: string; repo?: string; ref?: string; sha?: string } };
  trigger?: Trigger;
  /** Episodes waiting behind this one; only on the live snapshot. */
  queue?: { id: number; label: string; trigger: Trigger }[];
  label: string;
  truth: string | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  desks: Record<AgentId, DeskSnap>;
  results: {
    rival: { criterion: string; green: boolean; editedAssertions: boolean }[] | null;
    sentinel: { criterion: string; verdict: string }[] | null;
  };
}

export interface ArenaInfo {
  episode: EpisodeSnap | null;
  desks: Record<AgentId, { name: string; role: string }>;
  scenarios: { id: string; title: string; mutations: string[]; truth: string }[];
  repos: { id: string; title: string; refs: string[] }[];
  model: string | null;
  needsToken: boolean;
  github: boolean;
  tickets: { key: string; title: string; stage: string }[];
}

export type ArenaMsg =
  | { t: 'hello'; episode: EpisodeSnap | null }
  | { t: 'episode'; episode: EpisodeSnap | null }
  | { t: 'log'; episode: number; agent: AgentId; text: string; tone: Tone; at: number }
  | { t: 'state'; episode: number; agent: AgentId; status: Status; headline: string }
  | { t: 'frame'; episode: number; agent: AgentId; data: string };

/** The lobby is <server>/ and the floors are <server>/office/, one level down from the API. */
export const base = new URL(/\/office\/?(index\.html)?$/.test(location.pathname) ? '../' : './', location.href.split(/[?#]/)[0]);
export const at = (path: string) => new URL(path, base).toString();

export interface FloorSummary {
  id: number;
  status: EpisodeSnap['status'];
  label: string;
  conclusion: string | null;
  title: string | null;
  startedAt: number;
}

export interface FloorInfo {
  n: number;
  id: string;
  title: string;
  kind: 'demo' | 'github';
  url: string | null;
  defaultRef: string | null;
  options: { id: string; title: string }[];
  last: FloorSummary | null;
  live: boolean;
  queued: number;
}

export interface Building {
  floors: FloorInfo[];
  live: { id: number; floor: string; label: string; status: string } | null;
  github: { configured: boolean; canSetup: boolean };
  agents: { mcp: string; cli: string; guide: string };
  needsToken: boolean;
}

/** Which floor an episode belongs to: its repository for a GitHub run, otherwise the demo floor. */
export const floorOf = (ep: { trigger?: Trigger } | null | undefined) => (ep?.trigger?.kind === 'github' ? ep.trigger.repo : 'demo');

export function readToken(): string {
  try {
    return localStorage.getItem('arenaToken') ?? '';
  } catch {
    return '';
  }
}

export function saveToken(t: string) {
  try {
    localStorage.setItem('arenaToken', t);
  } catch {
    // private window
  }
}

export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(path, base), init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status}`);
  return data as T;
}

export function connect(onMsg: (m: ArenaMsg) => void, onStatus: (connected: boolean) => void): void {
  const url = new URL('arena/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const open = () => {
    const ws = new WebSocket(url);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = () => {
      onStatus(false);
      setTimeout(open, 2000);
    };
  };
  open();
}

/** Decodes a base64 JPEG frame off the main path; only the newest frame per agent is kept. */
export class FrameDecoder {
  private pending: Partial<Record<AgentId, string>> = {};
  private busy: Partial<Record<AgentId, boolean>> = {};

  constructor(private onImage: (agent: AgentId, img: ImageBitmap, data: string) => void) {}

  push(agent: AgentId, data: string) {
    this.pending[agent] = data;
    if (!this.busy[agent]) void this.drain(agent);
  }

  private async drain(agent: AgentId) {
    this.busy[agent] = true;
    while (this.pending[agent]) {
      const data = this.pending[agent]!;
      delete this.pending[agent];
      try {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const img = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        this.onImage(agent, img, data);
      } catch {
        // skip a broken frame
      }
    }
    this.busy[agent] = false;
  }
}
