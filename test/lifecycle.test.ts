import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { approvePlan, makePlan } from '../src/domain.ts';
import { lifecycleSchema, policySchema, type Cost } from '../src/contracts.ts';
import { beginAmendment, resolveBlocker, retainCompletedTasks, routeRecovery, splitTask, validateRequirementCoverage } from '../src/recovery.ts';
import {
  assertCurrentResult, assertPublishable, createLifecycle, deferCost, forgetCost, formatObservedModels, nextTask, observeCost, recordChange, recordSpend,
  recordUsageResult, requestRepair, settleCost, startJob, validateTasks, type Task,
} from '../src/lifecycle.ts';

const at = '2026-09-08T12:00:00Z';
const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const baseSha = 'a'.repeat(40);
const finalSha = 'b'.repeat(40);
const tasks: Task[] = [
  { id: 'api', title: 'API', description: 'Implement API', acceptance: ['Works'], dependsOn: ['model'], completed: false },
  { id: 'model', title: 'Model', description: 'Implement model', acceptance: ['Works'], dependsOn: [], completed: false },
];

function approvedState() {
  const state = createLifecycle(123, 'requester', 'Add a feature', baseSha);
  state.plan = makePlan('An agreed implementation plan', 0);
  state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
    authorized: true, actor: 'requester', commentId: 1, at });
  state.tasks = structuredClone(tasks);
  return state;
}

test('structured recovery verifies baseline ownership and stops identical deterministic repairs', () => {
  const state = approvedState();
  state.phase = 'coding';
  const blocker = { category: 'baseline_defect' as const, scope: 'task' as const, paths: ['test/feature/new.test.ts'],
    constraint: 'Agent incorrectly considers every existing file immutable', diagnostics: [], remedies: ['Repair the assertion'] };
  assert.equal(resolveBlocker(blocker, policy, ['test/existing.test.ts']).category, 'candidate_defect');
  assert.equal(resolveBlocker({ ...blocker, paths: ['test/existing.test.ts'] }, policy,
    ['test/existing.test.ts']).scope, 'repository');
  assert.equal(resolveBlocker({ ...blocker, paths: ['../escape'] }, policy, []).category, 'unsafe_output');
  const job = startJob(state, 'code', at);
  const report = { jobId: job.id, inputSha: baseSha, outcome: 'blocked' as const, summary: 'Repair needed', changes: [], blocker };
  const recovery = routeRecovery(state, job, report, policy, [], at);
  assert.equal(recovery.action, 'repair');
  assert.equal(state.phase, 'coding');
  assert.equal(state.repairs, 1);
  const retry = startJob(state, 'code', at);
  routeRecovery(state, retry, { ...report, jobId: retry.id }, policy, [], at);
  assert.equal(state.phase, 'blocked');
  assert.equal(state.recoveries!.length, 1);
  assert.equal(state.recoveries![0]!.status, 'exhausted');
  assert.equal(state.repairs, 1);
  assert.deepEqual(lifecycleSchema.parse(JSON.parse(JSON.stringify(state))), JSON.parse(JSON.stringify(state)));
});

test('task-local approval conflicts leave unrelated tasks available without authorizing the blocked task', () => {
  const state = approvedState();
  state.tasks.push({ id: 'independent', title: 'Independent', description: 'Separate work',
    acceptance: ['Works'], dependsOn: [], completed: false });
  state.phase = 'coding';
  const job = startJob(state, 'code', at);
  routeRecovery(state, job, { jobId: job.id, inputSha: baseSha, outcome: 'blocked', summary: 'Dependency decision required',
    changes: [], blocker: { category: 'approval_conflict', scope: 'task', paths: ['apps/vendor/library.js'],
      constraint: 'Approved pin does not permit a patch', diagnostics: [], remedies: ['Approve a bounded patch'] } }, policy, [], at);
  assert.equal(state.phase, 'coding');
  assert.equal(nextTask(state)!.id, 'independent');
  assert.equal(state.tasks.find(task => task.id === 'model')!.blockedBy, job.id);
  assert.equal(state.approval!.planHash, state.plan!.hash);
});

test('approved task splits preserve acceptance and invalidate an older execution breakdown', () => {
  const state = approvedState();
  state.plan = makePlan('Same outcomes with execution flexibility', 1, {
    allowTaskSplits: true, vendorSecurityPatches: [], dependencies: [], requirements: [{ id: 'REQ-001', text: 'Works' }],
  });
  state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 2,
    authorized: true, actor: 'requester', commentId: 2, at });
  state.tasks[1]!.acceptance.push('Invalid inputs are rejected');
  state.tasks[1]!.requirementIds = ['REQ-001'];
  assert.doesNotThrow(() => validateRequirementCoverage(state.tasks, state));
  assert.throws(() => validateRequirementCoverage([], state), /requirement identifiers/);
  state.phase = 'coding';
  const job = startJob(state, 'code', at);
  job.runId = 1;
  assert.throws(() => splitTask(state, job, [
    { id: 'one', description: 'First step', acceptanceIndexes: [0] },
    { id: 'two', description: 'Second step', acceptanceIndexes: [0] },
  ]), /every original/);
  splitTask(state, job, [
    { id: 'one', description: 'First step', acceptanceIndexes: [0] },
    { id: 'two', description: 'Second step', acceptanceIndexes: [1] },
  ]);
  assert.throws(() => assertCurrentResult(state, job.id, baseSha, 1), /breakdown changed/);
  state.job = undefined;
  assert.equal(startJob(state, 'code', at).stepId, 'one');
  assert.deepEqual(lifecycleSchema.parse(JSON.parse(JSON.stringify(state))), JSON.parse(JSON.stringify(state)));
});

test('amendments retain only identical completed tasks whose original requirements and dependencies remain intact', () => {
  for (const changed of ['none', 'dependency', 'requirements', 'legacy'] as const) {
    const state = approvedState();
    const permissions = { allowTaskSplits: true, vendorSecurityPatches: [], dependencies: [],
      requirements: [{ id: 'REQ-001', text: 'Original requirement' }] };
    state.plan = makePlan('Original plan', 0, changed === 'legacy' ? undefined : permissions);
    state.approval!.planHash = state.plan.hash;
    state.tasks = state.tasks.map((task, index) => ({ ...task, completed: true, issueNumber: 124 + index, requirementIds: ['REQ-001'] }));
    beginAmendment(state, { branch: 'main', sha: baseSha }, state.request, 'Retain completed work', true, false);
    state.amendment!.status = 'integrated';
    state.plan = makePlan('Amended plan', 1, changed === 'requirements' ? {
      ...permissions, requirements: [{ id: 'REQ-001', text: 'Changed requirement' }],
    } : permissions);
    const proposed = state.tasks.map(task => ({ id: task.id, title: task.title, description: task.description,
      acceptance: [...task.acceptance], dependsOn: [...task.dependsOn], requirementIds: task.requirementIds, completed: false }));
    if (changed === 'dependency') proposed.find(task => task.id === 'model')!.acceptance.push('New criterion');
    const retained = retainCompletedTasks(state, proposed);
    assert.equal(retained.every(task => task.completed), changed === 'none');
    if (changed !== 'none') assert.equal(retained.some(task => task.completed), false);
    assert.equal(state.amendment, undefined);
  }
});

test('deferred costs preserve original job identity across interruption and serialization', () => {
  const state = approvedState();
  state.phase = 'coding';
  const job = startJob(state, 'code', at);
  const expiresAt = '2026-09-08T14:00:00Z';
  deferCost(state, job, expiresAt);
  assert.equal(state.pendingCosts, undefined);
  job.dispatchedAt = at;
  deferCost(state, job, expiresAt);
  job.runId = 10;
  deferCost(state, job, '2026-09-08T15:00:00Z', { runnerMs: 60_000, credits: null, preempted: null });
  state.job = undefined;
  state.phase = 'cancelled';
  const restored = lifecycleSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored, JSON.parse(JSON.stringify(state)));
  assert.equal(restored.pendingCosts!.length, 1);
  assert.equal(restored.pendingCosts![0]!.expiresAt, expiresAt);
  assert.deepEqual(restored.pendingCosts![0]!.job, {
    id: job.id, stage: 'code', inputSha: job.inputSha, controlSha: job.controlSha,
    planHash: job.planHash, createdAt: at, runId: 10, taskId: job.taskId, attempt: 1,
  });
  assert.deepEqual(restored.pendingCosts![0]!.observed, { runnerMs: 60_000, credits: null, preempted: null });
  job.feedback = 'Later changes cannot rewrite retained identity';
  job.controlSha = finalSha;
  assert.equal(restored.pendingCosts![0]!.job.controlSha, baseSha);
  forgetCost(restored, job.id);
  assert.equal(restored.pendingCosts, undefined);
  forgetCost(restored, job.id);
  job.costedRun = 10;
  deferCost(restored, job, expiresAt);
  assert.equal(restored.pendingCosts, undefined);
});

test('model observations survive partial receipts and accumulate independently of credit totals', () => {
  const state = approvedState();
  state.phase = 'coding';
  const job = startJob(state, 'code', at);
  job.runId = 10;
  const pending = deferCost(state, job, '2026-09-08T14:00:00Z', {
    runnerMs: 60_000, credits: null, preempted: null, models: ['gpt-5.4'],
  })!;
  observeCost(pending, { runnerMs: 120_000, credits: 12, preempted: false, models: ['claude-sonnet-4.6', 'gpt-5.4'] });
  observeCost(pending, { runnerMs: 60_000, credits: null, preempted: null, models: [] });
  observeCost(pending, { runnerMs: 0, credits: null, preempted: null });
  const restored = lifecycleSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.pendingCosts![0]!.observed, {
    runnerMs: 120_000, credits: 12, preempted: false, models: ['claude-sonnet-4.6', 'gpt-5.4'],
  });
  recordSpend(restored, restored.pendingCosts![0]!.observed!, 250);
  recordSpend(restored, { runnerMs: 60_000, credits: 2, preempted: false, models: ['gpt-5.4'] }, 250);
  recordSpend(restored, { runnerMs: 60_000, credits: 0, preempted: false }, 250);
  assert.deepEqual(lifecycleSchema.parse(JSON.parse(JSON.stringify(restored))).spend, {
    runs: 3, runnerMs: 240_000, credits: 14, nearLimit: 0, preempted: 0, historyComplete: true,
    models: ['claude-sonnet-4.6', 'gpt-5.4'],
  });
});

test('settlement retains model attribution after pending cleanup and charges a registered job once', () => {
  const state = approvedState();
  state.phase = 'coding';
  const job = startJob(state, 'code', at);
  job.runId = 10;
  const pending = deferCost(state, job, '2026-09-08T14:00:00Z', {
    runnerMs: 60_000, credits: 12, preempted: false, models: ['gpt-5.4'],
  })!;
  settleCost(state, pending, 250);
  forgetCost(state, job.id);
  state.job = undefined;
  recordChange(state, finalSha);
  const restored = lifecycleSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.usageHistory, [{
    job: pending.job, persona: 'sdlc-code', observed: pending.observed,
  }]);
  assert.equal(restored.pendingCosts, undefined);
  assert.equal(restored.usageHistory![0]!.job.inputSha, baseSha);
  const before = structuredClone(restored.spend);
  settleCost(restored, pending, 250);
  assert.deepEqual(restored.spend, before);
  assert.equal(restored.usageHistory!.length, 1);
  for (const changed of [{ runId: 11 }, { controlSha: finalSha }, { inputSha: finalSha },
    { planHash: null }, { taskId: 'different' }, { attempt: 2 }]) {
    assert.throws(() => settleCost(restored, { ...pending, job: { ...pending.job, ...changed } }, 250), /identity changed/);
  }
  assert.throws(() => settleCost(restored, { ...pending, job: { ...pending.job, id: '123-2' } }, 250),
    /already belongs to another job/);
  assert.deepEqual(restored.spend, before);
});

test('usage history marks missing observations without inventing a persona for deterministic jobs', () => {
  const state = approvedState();
  const job = startJob(state, 'research', at);
  const before = structuredClone(state.spend);
  for (const [index, stage] of ['research', 'decompose', 'code', 'scan', 'security', 'test', 'validate', 'document', 'review'].entries()) {
    const pending = { job: { id: `123-${index + 1}`, stage: stage as typeof job.stage, inputSha: baseSha,
      controlSha: baseSha, planHash: job.planHash, createdAt: at }, expiresAt: '2026-09-08T14:00:00Z' };
    settleCost(state, pending, 250);
    assert.equal(state.usageHistory![index]!.persona, ['scan', 'validate'].includes(stage) ? null : `sdlc-${stage}`);
    assert.equal(state.usageHistory![index]!.observed, undefined);
  }
  const restored = lifecycleSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.usageHistory!.length, 9);
  assert.deepEqual(restored.spend, before);
  assert.equal(restored.usageHistory![0]!.job.taskId, undefined);
  assert.equal(restored.usageHistory![0]!.job.attempt, undefined);
  const record = restored.usageHistory![0]!;
  for (const usageHistory of [[record, record], [{ ...record, persona: 'sdlc-review' }],
    [{ ...record, approved: true }], [{ ...record, observed: { runnerMs: -1, credits: null, preempted: null } }],
    [{ ...record, job: { ...record.job, runId: 1 } }, { ...record, job: { ...record.job, id: '123-2', runId: 1 } }]]) {
    assert.equal(lifecycleSchema.safeParse({ ...restored, usageHistory }).success, false);
  }
});

test('token snapshots and configured selectors survive retries without summing repeated observations', () => {
  const state = approvedState();
  const job = startJob(state, 'research', at);
  job.runId = 10;
  const usage: NonNullable<Cost['tokenUsage']> = { status: 'available', models: [{
    model: 'gpt-5.4', requests: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0,
  }] };
  const missing: Cost = { credits: null, preempted: null };
  const observed = { ...missing, runnerMs: 60_000, requestedModel: 'auto', models: ['gpt-5.4'], tokenUsage: usage };
  const pending = deferCost(state, job, '2026-09-08T14:00:00Z', observed)!;
  for (const cost of [observed, { ...missing, runnerMs: 0 },
    { ...observed, requestedModel: 'later-selector', tokenUsage: { status: 'unavailable' as const, models: [] } },
    { ...observed, tokenUsage: { status: 'partial' as const, models: [{ ...usage.models[0]!, requests: 3, inputTokens: null }] } }]) {
    observeCost(pending, cost);
  }
  assert.equal(pending.observed!.requestedModel, 'auto');
  assert.deepEqual(pending.observed!.tokenUsage, usage);
  const newer = { ...usage, models: [{ ...usage.models[0]!, requests: 3, inputTokens: 150 }] };
  observeCost(pending, { ...observed, tokenUsage: newer, credits: 12, preempted: false });
  settleCost(state, pending, 250);
  forgetCost(state, job.id);
  const restored = lifecycleSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.usageHistory![0]!.observed!.tokenUsage, newer);
  assert.equal(restored.usageHistory![0]!.observed!.requestedModel, 'auto');
  assert.equal(restored.spend.credits, 12);
});

test('accepted usage results attach only to existing bound accounting and never become gate evidence', () => {
  const state = approvedState();
  const job = startJob(state, 'research', at);
  job.runId = 10;
  recordUsageResult(state, job, 'pass', baseSha);
  assert.equal(state.usageHistory, undefined);
  const pending = deferCost(state, job, '2026-09-08T14:00:00Z')!;
  recordUsageResult(state, { ...job, runId: 11 }, 'pass', finalSha);
  recordUsageResult(state, { ...job, inputSha: finalSha }, 'pass', finalSha);
  assert.equal(pending.acceptedResult, undefined);
  recordUsageResult(state, job, 'blocked', baseSha);
  settleCost(state, pending, 250);
  forgetCost(state, job.id);
  assert.deepEqual(state.usageHistory![0]!.acceptedResult, { outcome: 'blocked', outputSha: baseSha });
  assert.deepEqual(state.evidence, []);
  assert.deepEqual(lifecycleSchema.parse(JSON.parse(JSON.stringify(state))).usageHistory, state.usageHistory);
});

test('missing model telemetry never invents models or invalidates measured credit history', () => {
  const state = lifecycleSchema.parse(JSON.parse(JSON.stringify(approvedState())));
  assert.equal(state.spend.models, undefined);
  recordSpend(state, { runnerMs: 60_000, credits: 10, preempted: false }, 250);
  recordSpend(state, { runnerMs: 60_000, credits: 10, preempted: false, models: [] }, 250);
  assert.equal(state.spend.models, undefined);
  assert.equal(state.spend.historyComplete, true);
  assert.equal(state.spend.credits, 20);
});

test('model reporting bounds display size without discarding stored observations', () => {
  assert.equal(formatObservedModels(), 'unavailable');
  assert.equal(formatObservedModels([]), 'unavailable');
  assert.equal(formatObservedModels(['gpt-5.4']), '`gpt-5.4`');
  const models = Array.from({ length: 2000 }, (_, index) => `model-${index}`);
  const original = [...models];
  assert.equal(formatObservedModels(models),
    models.slice(0, 20).map(model => `\`${model}\``).join(', ') + ' (+1980 more recorded)');
  assert.deepEqual(models, original);
});

test('pending-cost schema rejects duplicates, malformed observations, and extra authority', () => {
  const state = approvedState();
  state.phase = 'coding';
  const job = startJob(state, 'code', at);
  job.dispatchedAt = at;
  deferCost(state, job, '2026-09-08T14:00:00Z');
  const pending = state.pendingCosts![0]!;
  for (const pendingCosts of [
    [pending, pending],
    [{ ...pending, expiresAt: 'invalid' }],
    [{ ...pending, job: { ...pending.job, approved: true } }],
    [{ ...pending, observed: { runnerMs: -1, credits: null, preempted: null } }],
  ]) assert.throws(() => lifecycleSchema.parse({ ...state, pendingCosts }));
});

test('task ordering follows dependencies rather than list order', () => {
  const state = approvedState();
  validateTasks(state.tasks, 5);
  assert.equal(nextTask(state)?.id, 'model');
  state.tasks[1]!.completed = true;
  assert.equal(nextTask(state)?.id, 'api');
});

test('task graphs reject cycles, duplicates, missing dependencies, and excess tasks', () => {
  assert.throws(() => validateTasks([tasks[0]!], 5), /Unknown/);
  assert.throws(() => validateTasks([tasks[1]!, tasks[1]!], 5), /Duplicate/);
  assert.throws(() => validateTasks(tasks, 1), /count/);
  assert.throws(() => validateTasks([tasks[0]!, { ...tasks[1]!, dependsOn: ['api'] }], 5), /Cyclic/);
});

test('coding cannot start without approval or in the wrong phase', () => {
  const state = approvedState();
  assert.throws(() => startJob(state, 'code', at), /phase/);
  state.phase = 'coding';
  state.approval = undefined;
  assert.throws(() => startJob(state, 'code', at), /approved plan/);
});

test('worker results must match the exact job, run, plan, and input commit', () => {
  const state = approvedState();
  state.phase = 'coding';
  const job = startJob(state, 'code', at);
  job.runId = 10;
  assert.equal(assertCurrentResult(state, job.id, baseSha, 10), job);
  assert.throws(() => assertCurrentResult(state, job.id, baseSha, 11), /Stale/);
  recordChange(state, finalSha);
  assert.throws(() => assertCurrentResult(state, job.id, baseSha, 10), /Stale/);
});

test('paused lifecycles reject in-flight output', () => {
  const state = approvedState();
  state.phase = 'coding';
  const job = startJob(state, 'code', at);
  job.runId = 10;
  state.phase = 'paused';
  assert.throws(() => assertCurrentResult(state, job.id, baseSha, 10), /not running/);
});

test('new code invalidates all prior gate evidence', () => {
  const state = approvedState();
  state.evidence = [{ stage: 'security', sha: baseSha, jobId: '123-1', runId: 1, summary: 'Pass' }];
  recordChange(state, finalSha);
  assert.deepEqual(state.evidence, []);
});

test('repair attempts stop at the configured budget', () => {
  const state = approvedState();
  requestRepair(state, 'Fix the regression', 1);
  assert.equal(state.phase, 'coding');
  requestRepair(state, 'Still failing', 1);
  assert.equal(state.phase, 'blocked');
});

test('publication requires every task and all gate evidence on the final commit', () => {
  const state = approvedState();
  state.phase = 'publishing';
  state.headSha = finalSha;
  state.tasks.forEach(task => { task.completed = true; });
  assert.throws(() => assertPublishable(state), /scan/);
  state.evidence = ['scan', 'security', 'test', 'validate', 'document', 'review'].map(stage => ({
    stage: stage as 'scan' | 'security' | 'test' | 'validate' | 'document' | 'review', sha: finalSha,
    jobId: `123-${stage}`, runId: 1, summary: 'Pass',
  }));
  assert.doesNotThrow(() => assertPublishable(state));
  state.evidence[0]!.sha = 'old';
  assert.throws(() => assertPublishable(state), /scan/);
});