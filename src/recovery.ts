import { isProtectedPath, isTestPath, validateChanges } from './changes.ts';
import type { Blocker, Change, Policy, Recovery, Report } from './contracts.ts';
import { approvePlan, digest, type Approval } from './domain.ts';
import { assertApproved, nextTask, type Job, type Lifecycle, type Task } from './lifecycle.ts';

export function previousPlanVersion(state: Lifecycle): number {
  return Math.max(state.planVersion ?? 0, state.plan?.version ?? 0, ...(state.amendmentHistory ?? []).map(item => item.version));
}

export function enterPreflight(state: Lifecycle, kind: NonNullable<Lifecycle['preflight']>['kind'],
  resumePhase: NonNullable<Lifecycle['preflight']>['resumePhase'], sourceSha = state.headSha): void {
  state.preflight = { kind, sourceSha, resumePhase };
  state.phase = 'preflighting';
  state.job = undefined;
  state.evidence = [];
}

export function activateVendorRepair(state: Lifecycle): boolean {
  const recovery = state.recoveries?.find(item => item.id === state.vendorRepair);
  if (!recovery) return false;
  recovery.status = 'active';
  state.phase = 'coding';
  state.feedback = `Repair only the approved dependency files before feature implementation.\n${JSON.stringify(recovery.blocker)}`;
  return true;
}

export function validateMaintenance(state: Lifecycle, changes: Change[], policy: Policy): Recovery {
  const recovery = state.recoveries?.find(item => item.id === state.maintenanceRecovery);
  if (!recovery || recovery.status !== 'waiting_maintainer' || !recovery.maintenanceBase || state.job?.stage !== 'maintain') {
    throw new Error('No registered maintenance proposal');
  }
  if (!changes.length || changes.length > policy.maxFiles ||
      changes.reduce((total, change) => total + Buffer.byteLength(change.content ?? ''), 0) > policy.maxChangeBytes ||
      Buffer.byteLength(JSON.stringify(changes)) > 300_000) {
    throw new Error('Maintenance proposal exceeds change budgets');
  }
  const paths = new Set<string>();
  for (const change of changes) {
    if (!recovery.blocker.paths.includes(change.path) || !/^[a-zA-Z0-9_./-]+$/.test(change.path) || change.path.startsWith('/') ||
        change.path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') ||
        paths.has(change.path.toLowerCase()) || change.content === null || change.content.includes('\0')) {
      throw new Error('Maintenance proposals may only replace the exact diagnosed baseline files');
    }
    paths.add(change.path.toLowerCase());
  }
  return recovery;
}

export function beginAmendment(state: Lifecycle, target: { sha: string; branch: string }, request: string,
  feedback: string, maintainer: boolean, trustedChange: boolean): void {
  assertApproved(state);
  if (target.branch !== state.baseBranch) throw new Error('A default-branch rename requires full replanning');
  if (trustedChange && !maintainer) throw new Error('A maintainer must request a trusted-baseline amendment');
  if ((state.amendmentHistory?.length ?? 0) >= 40) throw new Error('Amendment history budget exhausted');
  const version = Math.max(previousPlanVersion(state), state.amendment?.version ?? 0) + 1;
  const requiredMaintainer = trustedChange || state.amendment?.requiredMaintainer === true ||
    state.recoveries?.some(item => item.status === 'waiting_maintainer') === true;
  state.amendment = { version, baseSha: state.baseSha, sourceSha: state.headSha,
    targetSha: target.sha, controlSha: target.sha, request, feedback, previousPlan: structuredClone(state.plan!),
    previousApproval: structuredClone(state.approval!), tasks: structuredClone(state.tasks),
    requiredMaintainer,
    status: 'researching' };
  state.planVersion = version;
  state.controlSha = target.sha;
  state.job = undefined;
  state.evidence = [];
  state.feedback = feedback;
  state.error = undefined;
  state.retryAt = undefined;
  state.preflight = undefined;
  state.maintenanceRecovery = undefined;
  state.vendorRepair = undefined;
  for (const recovery of state.recoveries ?? []) recovery.checkpoint = undefined;
  state.phase = 'amending';
}

export function decideAmendment(state: Lifecycle, version: number, actor: string, commentId: number, at: string,
  maintainer: boolean, target: { sha: string; branch: string }, request: string, accept: boolean): void {
  const amendment = state.amendment;
  if (!amendment || amendment.version !== version || amendment.status !== 'awaiting_approval' || !amendment.plan ||
      state.phase !== 'awaiting_amendment') throw new Error('There is no matching amendment awaiting approval');
  if (amendment.requiredMaintainer && !maintainer) throw new Error('This amendment requires a maintainer');
  if (accept && (state.headSha !== amendment.sourceSha || state.controlSha !== amendment.controlSha ||
      target.sha !== amendment.targetSha || target.branch !== state.baseBranch || request !== amendment.request)) {
    throw new Error('Amendment source, request, or trusted baseline changed; obtain a fresh proposal');
  }
  const approval: Approval = approvePlan({ phase: 'awaiting_approval', plan: amendment.plan, version,
    authorized: true, actor, commentId, at });
  state.amendmentHistory ??= [];
  state.amendmentHistory.push({ version, sourceSha: amendment.sourceSha, targetSha: amendment.targetSha,
    controlSha: amendment.controlSha, planHash: amendment.plan.hash, decision: accept ? 'approved' : 'rejected', actor, commentId, at });
  state.evidence = [];
  if (!accept) {
    state.amendment = undefined;
    state.phase = 'blocked';
    state.resumePhase = undefined;
    state.error = 'Amendment rejected. Preserved work requires another amendment or full replanning.';
    return;
  }
  amendment.approval = approval;
  amendment.status = 'approved';
  state.plan = amendment.plan;
  state.approval = approval;
  state.request = amendment.request;
  state.branch = `agentic/epic-${state.issueNumber}-v${version}`;
  state.phase = 'integrating';
  state.error = undefined;
}

export function assertIntegration(state: Lifecycle): void {
  assertApproved(state);
  const amendment = state.amendment;
  if (!amendment || amendment.status !== 'approved' || state.phase !== 'integrating' ||
      state.job?.stage !== 'integrate' || state.headSha !== amendment.sourceSha || state.baseSha !== amendment.baseSha ||
      state.controlSha !== amendment.controlSha || state.plan!.hash !== amendment.plan?.hash ||
      state.approval!.commentId !== amendment.approval?.commentId) throw new Error('Integration lacks an exact approved amendment');
}

export function retainCompletedTasks(state: Lifecycle, tasks: Task[]): Task[] {
  const amendment = state.amendment;
  if (!amendment || amendment.status !== 'integrated') return tasks;
  const previousRequirements = amendment.previousPlan.policy?.requirements;
  const sameRequirements = state.plan?.policy?.requirements?.length && previousRequirements?.length &&
    digest(state.plan.policy.requirements) === digest(previousRequirements);
  const taskShape = (task: Task) => ({ id: task.id, title: task.title, description: task.description,
    acceptance: task.acceptance, dependsOn: task.dependsOn, requirementIds: task.requirementIds });
  const retained = tasks.map(task => {
    const previous = sameRequirements && amendment.tasks.find(item => item.completed && digest(taskShape(item)) === digest(taskShape(task)));
    return previous ? { ...task, completed: true, ...(previous.issueNumber ? { issueNumber: previous.issueNumber } : {}) } : task;
  });
  for (let iteration = 0; iteration < retained.length; iteration += 1) for (const task of retained) {
    if (task.completed && task.dependsOn.some(id => !retained.some(dependency => dependency.id === id && dependency.completed))) {
      task.completed = false;
    }
  }
  state.retiredTasks.push(...amendment.tasks.flatMap(task => task.issueNumber &&
    !retained.some(item => item.issueNumber === task.issueNumber) ? [task.issueNumber] : []));
  state.amendment = undefined;
  return retained;
}

export function splitTask(state: Lifecycle, job: Job, steps: NonNullable<Report['split']>): void {
  assertApproved(state);
  if (!state.plan!.policy?.allowTaskSplits || job.stage !== 'code') throw new Error('Task splitting requires approved permission');
  const task = state.tasks.find(item => item.id === job.taskId);
  if (!task || task.completed || task.steps || steps.length < 2 || steps.length > 12) throw new Error('Task cannot be split again');
  if (new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('Duplicate execution step');
  const covered = new Set(steps.flatMap(step => step.acceptanceIndexes));
  if (covered.size !== task.acceptance.length || [...covered].some(index =>
      !Number.isInteger(index) || index < 0 || index >= task.acceptance.length) || steps.some(step => !step.acceptanceIndexes.length)) {
    throw new Error('A split must retain every original acceptance criterion');
  }
  task.steps = steps.map(step => ({ ...step, completed: false }));
}

export function validateRequirementCoverage(tasks: Task[], state: Lifecycle): void {
  const requirements = state.plan?.policy?.requirements;
  if (!requirements?.length) return;
  const required = new Set(requirements.map(item => item.id));
  const assigned = new Set(tasks.flatMap(task => task.requirementIds ?? []));
  if (required.size !== requirements.length || assigned.size !== required.size || [...assigned].some(id => !required.has(id))) {
    throw new Error('Task breakdown must cover the approved requirement identifiers exactly');
  }
}

export function resolveBlocker(blocker: Blocker, policy: Policy, baselineTests: readonly string[]): Blocker {
  const paths = [...new Set([...blocker.paths, ...blocker.diagnostics.flatMap(item => item.path ? [item.path] : [])])].sort();
  if (paths.some(path => !/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith('/') ||
      path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))) {
    return { ...blocker, paths, category: 'unsafe_output', scope: 'repository' };
  }
  if (blocker.category === 'unsafe_output') return { ...blocker, paths, scope: 'repository' };
  const immutable = paths.some(path => isProtectedPath(path, policy) ||
    isTestPath(path, policy) && baselineTests.includes(path));
  if (immutable) return { ...blocker, paths, category: 'baseline_defect', scope: 'repository' };
  if (blocker.category === 'baseline_defect' && paths.length) {
    validateChanges(paths.map(path => ({ path, content: '' })), 'code', policy, baselineTests);
    return { ...blocker, paths, category: 'candidate_defect' };
  }
  return { ...blocker, paths };
}

export function recoveryFingerprint(blocker: Blocker, taskId: string | null): string {
  return digest({ category: blocker.category, scope: blocker.scope, taskId,
    paths: [...blocker.paths].sort(), diagnostics: blocker.diagnostics.map(item =>
      ({ tool: item.tool, ruleId: item.ruleId ?? null, path: item.path ?? null }))
      .sort((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second))) });
}

export function routeRecovery(state: Lifecycle, job: Job, report: Report, policy: Policy,
  baselineTests: readonly string[], at: string): Recovery {
  if (!report.blocker) throw new Error('Structured recovery requires a blocker');
  const blocker = resolveBlocker(report.blocker, policy, baselineTests);
  if (job.purpose === 'baseline_preflight' && !['unsafe_output', 'transient', 'incomplete_work'].includes(blocker.category)) {
    blocker.category = 'baseline_defect';
    blocker.scope = 'repository';
  }
  const fingerprint = digest({ blocker: recoveryFingerprint(blocker, blocker.scope === 'task' ? job.taskId : null),
    stage: job.stage, stepId: job.stepId ?? null, planHash: job.planHash, baseSha: state.baseSha });
  state.recoveries ??= [];
  let recovery = state.recoveries.find(item => item.fingerprint === fingerprint);
  if (!recovery) {
    if (state.recoveries.length >= 40) throw new Error('Recovery history budget exhausted');
    const { id, stage, inputSha, controlSha, planHash, createdAt, runId, taskId, attempt } = job;
    recovery = { id, fingerprint, job: { id, stage, inputSha, controlSha, planHash, createdAt, runId, taskId, attempt },
      blocker, action: 'reject', status: 'active', resumePhase: state.phase, attempts: 0, attemptedKeys: [] };
    state.recoveries.push(recovery);
  }
  recovery.blocker = blocker;
  recovery.action = {
    transient: 'retry', candidate_defect: 'repair', incomplete_work: 'continue',
    approval_conflict: 'amend', baseline_defect: 'maintain', unsafe_output: 'reject',
  }[blocker.category] as Recovery['action'];
  if (report.split && blocker.category === 'incomplete_work') {
    splitTask(state, job, report.split);
    recovery.action = 'split';
  }
  const actionKey = digest({ inputSha: job.inputSha, controlSha: job.controlSha, planHash: job.planHash,
    action: recovery.action, changes: report.changes });
  const automatic = ['retry', 'repair', 'continue', 'split'].includes(recovery.action);
  if (automatic && (recovery.attempts >= policy.maxJobAttempts ||
      recovery.action === 'repair' && (recovery.attemptedKeys.includes(actionKey) || state.repairs >= policy.maxRepairs))) {
    recovery.status = 'exhausted';
  } else if (automatic) {
    recovery.status = 'active';
    recovery.attempts += 1;
    recovery.attemptedKeys.push(actionKey);
    if (recovery.action === 'repair') state.repairs += 1;
  } else recovery.status = recovery.action === 'reject' ? 'rejected' :
    recovery.action === 'maintain' ? 'waiting_maintainer' : 'waiting_approval';
  if (recovery.action === 'continue' && report.changes.length && recovery.status === 'active') {
    validateChanges(report.changes, job.stage, policy, baselineTests);
    const { id, stage, inputSha, controlSha, planHash, createdAt, runId, taskId, attempt, stepId, executionHash } = job;
    for (const previous of state.recoveries) previous.checkpoint = undefined;
    if (Buffer.byteLength(JSON.stringify(report.changes)) > 300_000) throw new Error('Checkpoint storage budget exceeded');
    recovery.checkpoint = { job: { id, stage, inputSha, controlSha, planHash, createdAt, runId, taskId, attempt },
      changes: report.changes, summary: report.summary };
    if (stepId) recovery.checkpoint.job.stepId = stepId;
    if (executionHash) recovery.checkpoint.job.executionHash = executionHash;
  }
  state.job = undefined;
  state.evidence = [];
  state.feedback = `${report.summary}\n\nRecovery ${recovery.id}: ${JSON.stringify(blocker)}`.slice(0, 24000);
  state.retryAt = undefined;
  if (recovery.status === 'active') {
    state.phase = recovery.action === 'repair' ? 'coding' : recovery.resumePhase;
    state.error = undefined;
    if (recovery.action === 'retry') state.retryAt = new Date(Date.parse(at) + 30_000 * 2 ** (recovery.attempts - 1)).toISOString();
  } else {
    const task = blocker.scope === 'task' ? state.tasks.find(item => item.id === job.taskId) : undefined;
    if (task) task.blockedBy = recovery.id;
    state.resumePhase = recovery.resumePhase;
    state.phase = task && nextTask(state) ? 'coding' : 'blocked';
    if (state.phase === 'coding') state.feedback = '';
    state.error = `Recovery ${recovery.id} (${recovery.status}): ${report.summary}`.slice(0, 12000);
  }
  if (recovery.action === 'maintain' && !recovery.maintenance && job.stage !== 'maintain') {
    recovery.maintenanceBase = state.controlSha;
    state.maintenanceRecovery = recovery.id;
    state.preflight = undefined;
    state.phase = 'maintaining';
    state.feedback = `Prepare a proposed baseline repair only. Do not modify the source checkout or publish it.\n${JSON.stringify(blocker)}`.slice(0, 24000);
  }
  if (state.phase !== 'preflighting') state.preflight = undefined;
  if (Buffer.byteLength(JSON.stringify(state, null, 2)) > 900_000) throw new Error('Recovery state storage budget exceeded');
  return recovery;
}

export function resolveTaskRecoveries(state: Lifecycle, job: Job): void {
  for (const recovery of state.recoveries ?? []) {
    if (recovery.status !== 'active' || recovery.job.taskId !== job.taskId || recovery.job.stage !== job.stage) continue;
    recovery.status = 'resolved';
    recovery.checkpoint = undefined;
    const task = state.tasks.find(item => item.blockedBy === recovery.id);
    if (task) task.blockedBy = undefined;
  }
}