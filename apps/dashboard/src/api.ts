import type { Contract, CriterionResult, HealRecord, LocatorMap, Baseline, Ticket, Verdict } from '@sentinelqa/core';

export type { Contract, CriterionResult, HealRecord, LocatorMap, Baseline, Ticket, Verdict };

export type Stage = 'received' | 'compiled' | 'generated' | 'baselined' | 'checked';

export interface TicketRow extends Ticket {
  stage: Stage;
  updatedAt: string;
}

export interface RunRow {
  id: number;
  ticket: string;
  kind: 'baseline' | 'check';
  mode: string;
  mutations: string[];
  status: 'queued' | 'running' | 'done' | 'failed';
  verdict: Verdict | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface HealRow {
  id: number;
  run_id: number;
  ticket: string;
  criterion: string;
  key: string;
  decision: string;
  status: 'accepted' | 'pending' | 'approved' | 'rejected' | 'refused';
  rule: string;
  record: HealRecord;
}

export interface TicketDetail {
  ticket: TicketRow;
  nextActions: string[];
  contract: Contract | null;
  locators: LocatorMap;
  baseline: Baseline | null;
  spec: string | null;
  specGate: { ok: boolean; detail: string } | null;
  runs: RunRow[];
}

export interface Mutation {
  id: string;
  kind: 'drift' | 'regression';
  title: string;
}

export interface LiveEvent {
  type: string;
  ticket?: string;
  runId?: number;
  message: string;
  at: string;
  data?: unknown;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  tickets: () => call<TicketRow[]>('GET', 'api/tickets'),
  ticket: (key: string) => call<TicketDetail>('GET', `api/tickets/${key}`),
  createTicket: (t: { key: string; title: string; criteria: string }) => call<TicketRow>('POST', 'api/tickets', t),
  compile: (key: string, mode: 'auto' | 'llm' | 'parser' = 'auto') => call<{ source: string; warnings: string[] }>('POST', `api/tickets/${key}/compile`, { mode }),
  saveContract: (key: string, c: unknown) => call<Contract>('PUT', `api/tickets/${key}/contract`, c),
  generate: (key: string) => call<{ sha256: string }>('POST', `api/tickets/${key}/generate`),
  baseline: (key: string) => call<{ runId: number }>('POST', `api/tickets/${key}/baseline`),
  check: (key: string, mutations: string[], mode = 'sentinel') => call<{ runId: number }>('POST', `api/tickets/${key}/runs`, { mutations, mode }),
  runs: () => call<RunRow[]>('GET', 'api/runs'),
  run: (id: number) => call<{ run: RunRow; results: CriterionResult[]; heals: HealRow[] }>('GET', `api/runs/${id}`),
  heals: (status?: string) => call<HealRow[]>('GET', `api/heals${status ? `?status=${status}` : ''}`),
  approve: (id: number) => call<{ ok: true }>('POST', `api/heals/${id}/approve`),
  reject: (id: number) => call<{ ok: true }>('POST', `api/heals/${id}/reject`),
  mutations: () => call<Mutation[]>('GET', 'api/mutations'),
  events: () => call<(LiveEvent & { id: number })[]>('GET', 'api/events'),
};

/** Subscribes to server events; reconnects when the socket drops. */
export function subscribe(onEvent: (e: LiveEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout>;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${location.pathname.replace(/\/$/, '')}/ws`.replace(/\/#.*$/, ''));
    ws.onmessage = (m) => onEvent(JSON.parse(m.data));
    ws.onclose = () => {
      if (!closed) retry = setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    ws?.close();
  };
}
