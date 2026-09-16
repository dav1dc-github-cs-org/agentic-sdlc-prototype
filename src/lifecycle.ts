import { digest, type Approval, type Phase, type Plan } from './domain.ts';
import type { Cost, Report } from './contracts.ts';

export type Stage = 'research' | 'decompose' | 'code' | 'scan' | 'security' | 'test' | 'validate' | 'document' | 'review';

export interface Task {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  dependsOn: string[];
  issueNumber?: number;
  completed: boolean;
}

export interface Job {
  id: string;
  stage: Stage;
  inputSha: string;
  controlSha: string;
  planHash: string | null;
  taskId: string | null;
  feedback: string;
  attempt: number;
  createdAt: string;
  dispatchedAt?: string;
  runId?: number;
  costedRun?: number;
}

export interface Spend {
  runs: number;
  runnerMs: number;
  credits: number;
  nearLimit: number;
  preempted: number;
  historyComplete: boolean;
  models?: string[];
}

export type JobIdentity = Pick<Job, 'id' | 'stage' | 'inputSha' | 'controlSha' | 'planHash' | 'createdAt' | 'runId'> &
  Partial<Pick<Job, 'taskId' | 'attempt'>>;

export interface PendingCost {
  job: JobIdentity;
  expiresAt: string;
  observed?: Cost & { runnerMs: number };
  acceptedResult?: { outcome: Report['outcome']; outputSha: string };
}

export interface UsageRecord {
  job: JobIdentity;
  persona: string | null;
  observed?: PendingCost['observed'];
  acceptedResult?: PendingCost['acceptedResult'];
}

export interface Evidence {
  stage: Stage;
  sha: string;
  jobId: string;
  runId: number;
  summary: string;
}

export interface Lifecycle {
  schemaVersion: 2;
  issueNumber: number;
  requester: string;
  request: string;
  phase: Phase;
  baseSha: string;
  baseBranch: string;
  controlSha: string;
  headSha: string;
  branch: string;
  plan?: Plan;
  approval?: Approval;
  tasks: Task[];
  tasksLinked?: boolean;
  retiredTasks: number[];
  job?: Job;
  evidence: Evidence[];
  processedEvents: string[];
  sequence: number;
  repairs: number;
  failures: number;
  spend: Spend;
  pendingCosts?: PendingCost[];
  usageHistory?: UsageRecord[];
  feedback: string;
  resumePhase?: Phase;
  error?: string;
  prNumber?: number;
}

export function createLifecycle(issueNumber: number, requester: string, request: string, baseSha: string, baseBranch = 'main'): Lifecycle {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || !/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error('Lifecycle requires an issue number and immutable commit SHA');
  }
  return {
    schemaVersion: 2, issueNumber, requester, request, phase: 'researching',
    baseSha, headSha: baseSha, baseBranch, controlSha: baseSha, branch: `agentic/epic-${issueNumber}-v1`,
    tasks: [], retiredTasks: [], evidence: [], processedEvents: [], sequence: 0, repairs: 0, failures: 0, feedback: '',
    spend: { runs: 0, runnerMs: 0, credits: 0, nearLimit: 0, preempted: 0, historyComplete: true },
  };
}

export function deferCost(state: Lifecycle, job: Job, expiresAt: string, observed?: PendingCost['observed']): PendingCost | undefined {
  if (job.costedRun !== undefined || !job.dispatchedAt && job.runId === undefined) return;
  state.pendingCosts ??= [];
  let pending = state.pendingCosts.find(item => item.job.id === job.id);
  if (!pending) {
    pending = { job: { id: job.id, stage: job.stage, inputSha: job.inputSha, controlSha: job.controlSha,
      planHash: job.planHash, createdAt: job.createdAt, taskId: job.taskId, attempt: job.attempt }, expiresAt };
    state.pendingCosts.push(pending);
  }
  if (job.runId !== undefined) pending.job.runId = job.runId;
  if (observed) observeCost(pending, observed);
  return pending;
}

export function observeCost(pending: PendingCost, cost: NonNullable<PendingCost['observed']>): void {
  const previous = pending.observed;
  const creditLimit = cost.creditLimit ?? previous?.creditLimit;
  pending.observed = { ...cost, runnerMs: Math.max(cost.runnerMs, previous?.runnerMs ?? 0),
    credits: cost.credits ?? previous?.credits ?? null, preempted: cost.preempted ?? previous?.preempted ?? null };
  if (creditLimit !== undefined) pending.observed.creditLimit = creditLimit;
  const requestedModel = previous?.requestedModel ?? cost.requestedModel;
  if (requestedModel !== undefined) pending.observed.requestedModel = requestedModel;
  const snapshots = [previous?.tokenUsage, cost.tokenUsage].filter(snapshot => snapshot !== undefined);
  const ranks = { unavailable: 0, partial: 1, available: 2 };
  snapshots.sort((left, right) => ranks[right.status] - ranks[left.status] ||
    right.models.reduce((total, model) => total + model.requests, 0) - left.models.reduce((total, model) => total + model.requests, 0));
  if (snapshots[0]) pending.observed.tokenUsage = structuredClone(snapshots[0]);
  const models = [...new Set([...previous?.models ?? [], ...cost.models ?? []])].sort().slice(0, 20);
  if (models.length) pending.observed.models = models;
}

export function forgetCost(state: Lifecycle, jobId: string): void {
  if (!state.pendingCosts) return;
  state.pendingCosts = state.pendingCosts.filter(item => item.job.id !== jobId);
  if (!state.pendingCosts.length) delete state.pendingCosts;
}

// A run the limiter pre-empted is counted only as pre-empted: the two outcomes are exclusive.
export function recordSpend(state: Lifecycle, cost: NonNullable<PendingCost['observed']>, maxCredits: number): void {
  const creditLimit = cost.creditLimit ?? maxCredits;
  state.spend.runs += 1;
  state.spend.runnerMs += Math.max(0, cost.runnerMs);
  state.spend.credits += Math.max(0, cost.credits ?? 0);
  if (cost.models?.length) state.spend.models = [...new Set([...state.spend.models ?? [], ...cost.models])].sort();
  if (cost.credits === null || cost.preempted === null) state.spend.historyComplete = false;
  if (cost.preempted) state.spend.preempted += 1;
  else if (cost.preempted === false && cost.credits !== null && creditLimit > 0 && cost.credits >= creditLimit * 0.8) {
    state.spend.nearLimit += 1;
  }
}

export function settleCost(state: Lifecycle, pending: PendingCost, maxCredits: number): void {
  const existing = state.usageHistory?.find(record => record.job.id === pending.job.id);
  if (existing) {
    for (const key of ['stage', 'inputSha', 'controlSha', 'planHash', 'createdAt', 'runId', 'taskId', 'attempt'] as const) {
      if (existing.job[key] !== pending.job[key]) throw new Error('Settled cost job identity changed');
    }
    return;
  }
  if (pending.job.runId !== undefined && state.usageHistory?.some(record => record.job.runId === pending.job.runId)) {
    throw new Error('Usage run already belongs to another job');
  }
  const persona = ['scan', 'validate'].includes(pending.job.stage) ? null : `sdlc-${pending.job.stage}`;
  state.usageHistory ??= [];
  state.usageHistory.push({ job: { ...pending.job }, persona,
    ...(pending.observed ? { observed: structuredClone(pending.observed) } : {}),
    ...(pending.acceptedResult ? { acceptedResult: { ...pending.acceptedResult } } : {}) });
  if (pending.observed) recordSpend(state, pending.observed, maxCredits);
}

export function recordUsageResult(state: Lifecycle, job: Job, outcome: Report['outcome'], outputSha: string): void {
  const record = state.usageHistory?.find(item => item.job.id === job.id) ??
    state.pendingCosts?.find(item => item.job.id === job.id);
  if (record && record.job.runId === job.runId && record.job.inputSha === job.inputSha) {
    record.acceptedResult = { outcome, outputSha };
  }
}

export function formatObservedModels(models: readonly string[] = []): string {
  if (!models.length) return 'unavailable';
  const displayed = models.slice(0, 20).map(model => `\`${model}\``).join(', ');
  return displayed + (models.length > 20 ? ` (+${models.length - 20} more recorded)` : '');
}

export function validateTasks(tasks: Task[], maximum: number): void {
  if (!tasks.length || tasks.length > maximum) throw new Error('Task count exceeds policy');
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('Duplicate task IDs');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error('Cyclic task dependencies');
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error('Unknown task dependency');
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  tasks.forEach(task => visit(task.id));
}

export function nextTask(state: Lifecycle): Task | undefined {
  return state.tasks.find(task => !task.completed && task.dependsOn.every(id =>
    state.tasks.some(dependency => dependency.id === id && dependency.completed)));
}

export function assertApproved(state: Lifecycle): void {
  if (!state.plan || !state.approval || state.plan.hash !== state.approval.planHash ||
      state.plan.hash !== digest({ version: state.plan.version, body: state.plan.body })) {
    throw new Error('An intact approved plan is required');
  }
}

export function startJob(state: Lifecycle, stage: Stage, at: string): Job {
  if (state.job) throw new Error('A job is already active');
  const phases: Record<Stage, Phase> = {
    research: 'researching', decompose: 'decomposing', code: 'coding',
    scan: 'scanning', security: 'security', test: 'testing', validate: 'validating',
    document: 'documenting', review: 'reviewing',
  };
  if (state.phase !== phases[stage]) throw new Error('Stage does not match lifecycle phase');
  if (stage !== 'research') assertApproved(state);
  const task = stage === 'code' ? nextTask(state) : undefined;
  if (stage === 'code' && !task && !state.feedback) throw new Error('No dependency-ready task');
  state.sequence += 1;
  state.job = {
    id: `${state.issueNumber}-${state.sequence}`, stage, inputSha: state.headSha, controlSha: state.controlSha,
    planHash: state.plan?.hash ?? null, taskId: task?.id ?? null,
    feedback: state.feedback, attempt: 1, createdAt: at,
  };
  return state.job;
}

export function assertCurrentResult(state: Lifecycle, jobId: string, sha: string, runId: number): Job {
  const job = state.job;
  if (!job || job.id !== jobId || job.inputSha !== sha || job.runId !== runId ||
      state.headSha !== sha || job.controlSha !== state.controlSha || job.planHash !== (state.plan?.hash ?? null)) {
    throw new Error('Stale or unrecognized worker result');
  }
  if (['paused', 'cancelled', 'blocked'].includes(state.phase)) throw new Error('Lifecycle is not running');
  if (job.stage !== 'research') assertApproved(state);
  return job;
}

export function recordChange(state: Lifecycle, sha: string): void {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Changes require an immutable commit SHA');
  if (sha !== state.headSha) {
    state.headSha = sha;
    state.evidence = [];
  }
}

export function requestRepair(state: Lifecycle, feedback: string, maximum: number): void {
  state.job = undefined;
  state.evidence = [];
  state.feedback = feedback;
  state.repairs += 1;
  if (state.repairs > maximum) {
    state.phase = 'blocked';
    state.resumePhase = 'coding';
    state.error = 'Repair budget exhausted; maintainer intervention required';
  } else {
    state.phase = 'coding';
  }
}

export function assertPublishable(state: Lifecycle): void {
  assertApproved(state);
  if (state.phase !== 'publishing' || state.job || !state.tasks.length ||
      state.tasks.some(task => !task.completed) || state.headSha === state.baseSha) {
    throw new Error('Lifecycle is not ready for publication');
  }
  for (const stage of ['scan', 'security', 'test', 'validate', 'document', 'review'] as const) {
    if (!state.evidence.some(item => item.stage === stage && item.sha === state.headSha)) {
      throw new Error(`Missing current ${stage} evidence`);
    }
  }
}