/**
 * A ticket moves through fixed stages. Each action is only allowed from the
 * stages listed here, so the order compile -> generate -> baseline -> check
 * cannot be skipped, and changing the contract sends the ticket back.
 */
export const STAGES = ['received', 'compiled', 'generated', 'baselined', 'checked'] as const;
export type Stage = (typeof STAGES)[number];

export type Action = 'compile' | 'edit-contract' | 'generate' | 'baseline' | 'check' | 'approve-heal';

interface Transition {
  action: Action;
  from: Stage[];
  to: Stage;
  why: string;
}

export const TRANSITIONS: Transition[] = [
  { action: 'compile', from: ['received', 'compiled', 'generated', 'baselined', 'checked'], to: 'compiled', why: 'criteria compiled into a contract; spec and baseline must be redone' },
  { action: 'edit-contract', from: ['compiled', 'generated', 'baselined', 'checked'], to: 'compiled', why: 'contract edited by a person; spec and baseline must be redone' },
  { action: 'generate', from: ['compiled', 'generated', 'baselined', 'checked'], to: 'generated', why: 'spec generated from the contract and hash-locked' },
  { action: 'baseline', from: ['generated', 'baselined', 'checked'], to: 'baselined', why: 'baseline recorded on the known-good build' },
  { action: 'check', from: ['baselined', 'checked'], to: 'checked', why: 'suite run against the target build' },
  { action: 'approve-heal', from: ['checked'], to: 'checked', why: 'a reviewer approved a proposed locator repair' },
];

export class StageError extends Error {
  constructor(readonly action: Action, readonly stage: Stage, readonly allowed: Stage[]) {
    super(`cannot ${action} a ticket that is "${stage}"; allowed from: ${allowed.join(', ')}`);
  }
}

export function transition(stage: Stage, action: Action): Transition {
  const t = TRANSITIONS.find((x) => x.action === action);
  if (!t) throw new Error(`unknown action ${action}`);
  if (!t.from.includes(stage)) throw new StageError(action, stage, t.from);
  return t;
}

/** Actions a ticket in this stage can take next, for the dashboard. */
export function nextActions(stage: Stage): Action[] {
  return TRANSITIONS.filter((t) => t.from.includes(stage)).map((t) => t.action);
}
