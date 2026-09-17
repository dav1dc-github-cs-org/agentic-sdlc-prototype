import { createHash } from 'node:crypto';
import type { PlanPolicy } from './contracts.ts';

export type Phase =
  | 'researching' | 'awaiting_approval' | 'decomposing' | 'coding'
  | 'scanning' | 'security' | 'testing' | 'validating' | 'documenting' | 'reviewing' | 'publishing'
  | 'pr_open' | 'merged' | 'blocked' | 'paused' | 'cancelled'
  | 'amending' | 'awaiting_amendment' | 'integrating' | 'preflighting' | 'maintaining';

export interface Plan {
  version: number;
  body: string;
  hash: string;
  policy?: PlanPolicy;
}

export interface Approval {
  actor: string;
  commentId: number;
  planHash: string;
  at: string;
}

export type Command =
  | { kind: 'approve'; version: number }
  | { kind: 'approve-amendment' | 'reject-amendment'; version: number }
  | { kind: 'amend'; feedback: string }
  | { kind: 'propose-maintenance'; recoveryId: string; hash: string }
  | { kind: 'revise'; feedback: string }
  | { kind: 'pause' | 'resume' | 'cancel' | 'retry' };

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([first], [second]) => first.localeCompare(second)).map(([key, entry]) => [key, ordered(entry)]));
  return value;
}

export function planHash(plan: Pick<Plan, 'version' | 'body' | 'policy'>): string {
  return digest({ version: plan.version, body: plan.body, ...(plan.policy ? { policy: ordered(plan.policy) } : {}) });
}

export function makePlan(body: string, previousVersion: number, policy?: PlanPolicy): Plan {
  const normalized = body.trim();
  if (!normalized || normalized.length > 24000) throw new Error('Invalid plan length');
  if (!Number.isSafeInteger(previousVersion) || previousVersion < 0 ||
      previousVersion >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid plan version');
  const version = previousVersion + 1;
  const plan = { version, body: normalized, ...(policy ? { policy: structuredClone(policy) } : {}) };
  return { ...plan, hash: planHash(plan) };
}

export function parseCommand(body: string): Command | undefined {
  const text = body.trim();
  const maintenance = /^\/sdlc propose-maintenance (\d+-\d+) ([a-f0-9]{64})$/.exec(text);
  if (maintenance) return { kind: 'propose-maintenance', recoveryId: maintenance[1]!, hash: maintenance[2]! };
  const amendment = /^\/sdlc (approve-amendment|reject-amendment) v([1-9]\d*)$/.exec(text);
  if (amendment && Number.isSafeInteger(Number(amendment[2]))) return {
    kind: amendment[1] as 'approve-amendment' | 'reject-amendment', version: Number(amendment[2]),
  };
  const change = /^\/sdlc amend ([\s\S]+)$/.exec(text);
  if (change?.[1]?.trim()) return { kind: 'amend', feedback: change[1].trim() };
  const approval = /^\/sdlc approve v([1-9]\d*)$/.exec(text);
  if (approval && Number.isSafeInteger(Number(approval[1]))) {
    return { kind: 'approve', version: Number(approval[1]) };
  }
  const revision = /^\/sdlc revise\s+([\s\S]+)$/.exec(text);
  if (revision?.[1]?.trim()) return { kind: 'revise', feedback: revision[1].trim() };
  const control = /^\/sdlc (pause|resume|cancel|retry)$/.exec(text);
  if (control) return { kind: control[1] as 'pause' | 'resume' | 'cancel' | 'retry' };
  return undefined;
}

export function approvePlan(input: {
  phase: Phase;
  plan: Plan | undefined;
  version: number;
  authorized: boolean;
  actor: string;
  commentId: number;
  at: string;
}): Approval {
  if (!input.authorized) throw new Error('Actor is not authorized to approve this plan');
  if (input.phase !== 'awaiting_approval' || !input.plan) {
    throw new Error('There is no plan awaiting approval');
  }
  if (input.plan.version !== input.version) throw new Error('Approval refers to a stale plan');
  if (input.plan.hash !== planHash(input.plan)) {
    throw new Error('Plan integrity check failed');
  }
  return {
    actor: input.actor,
    commentId: input.commentId,
    planHash: input.plan.hash,
    at: input.at,
  };
}