import { approvePlan, makePlan, parseCommand, type Phase } from './domain.ts';
import { reportSchema, type Change, type Cost, type Intake, type Policy, type Report } from './contracts.ts';
import { validateChanges } from './changes.ts';
import {
  assertCurrentResult, assertPublishable, createLifecycle, deferCost, forgetCost, formatObservedModels, nextTask, observeCost, recordChange,
  recordUsageResult, requestRepair, settleCost, startJob, validateTasks, type Job, type JobIdentity, type Lifecycle, type PendingCost, type Stage, type Task,
} from './lifecycle.ts';

export interface Issue {
  number: number;
  title: string;
  body: string;
  author: string;
  open: boolean;
  labeled: boolean;
}
export interface Comment { id: number; body: string; actor: string; human: boolean; createdAt: string }
export interface Run { id: number; status: string; conclusion: string | null; url: string }
export interface RecordState { state: Lifecycle; version?: string; needsMigration?: boolean }

export class RetryablePlatformError extends Error {
  readonly retryable = true;
}

export interface Platform {
  issue(number: number): Promise<Issue>;
  comments(number: number): Promise<Comment[]>;
  canWrite(actor: string): Promise<boolean>;
  baseline(): Promise<{ branch: string; sha: string }>;
  trustedPathsChanged(from: string, to: string): Promise<boolean>;
  load(number: number): Promise<RecordState | undefined>;
  save(record: RecordState): Promise<void>;
  comment(number: number, key: string, body: string): Promise<void>;
  task(parent: Lifecycle, task: Task): Promise<number>;
  linkTasks(state: Lifecycle): Promise<void>;
  dispatch(job: Job, state: Lifecycle): Promise<void>;
  findRun(job: JobIdentity): Promise<Run | undefined>;
  cancelRun(runId: number): Promise<void>;
  report(run: Run, job: Job): Promise<Report>;
  cost(run: Run, job: JobIdentity): Promise<Cost & { runnerMs: number }>;
  applyChanges(state: Lifecycle, job: Job, changes: Change[]): Promise<string>;
  publish(state: Lifecycle): Promise<number>;
  pullRequest(number: number): Promise<'open' | 'closed' | 'merged'>;
  closeTasks(state: Lifecycle): Promise<void>;
  retireTasks(numbers: number[]): Promise<void>;
}

const stages: Partial<Record<Phase, Stage>> = {
  researching: 'research', decomposing: 'decompose', coding: 'code', scanning: 'scan',
  security: 'security', testing: 'test', validating: 'validate', documenting: 'document', reviewing: 'review',
};
const terminalPhases: Phase[] = ['cancelled', 'merged'];

function transientPlatformError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { status?: unknown; code?: unknown; cause?: { code?: unknown };
    retryable?: unknown; response?: { headers?: Record<string, string> } };
  const status = Number(candidate.status);
  const code = String(candidate.code ?? candidate.cause?.code ?? '');
  const transientCodes = new Set(['EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);
  const headers = candidate.response?.headers;
  return candidate.retryable === true || transientCodes.has(code) || status === 404 || status === 408 ||
    status === 429 || status >= 500 && status <= 599 ||
    status === 403 && (headers?.['retry-after'] !== undefined || headers?.['x-ratelimit-remaining'] === '0');
}

export class Controller {
  readonly platform: Platform;
  readonly policy: Policy;
  readonly clock: () => Date;

  constructor(platform: Platform, policy: Policy, clock = () => new Date()) {
    this.platform = platform;
    this.policy = policy;
    this.clock = clock;
  }

  async tick(number: number, intake?: Intake): Promise<void> {
    const issue = await this.platform.issue(number);
    let record = await this.platform.load(number);
    if (record?.needsMigration) await this.platform.save(record);
    if (!record) {
      if (!intake || intake.issueNumber !== number || !issue.open || !issue.labeled ||
          issue.author.toLowerCase() !== intake.requester.toLowerCase() || !await this.platform.canWrite(intake.actor)) return;
      const baseline = await this.platform.baseline();
      record = { state: createLifecycle(number, intake.requester,
        this.requestText(intake.title, intake.body), baseline.sha, baseline.branch) };
      await this.platform.save(record);
    }
    const state = record.state;
    await this.reconcileCosts(record);
    if (state.phase === 'merged' || state.phase === 'cancelled' && !state.prNumber) {
      await this.status(state);
      return;
    }
    if (state.prNumber) {
      const disposition = await this.platform.pullRequest(state.prNumber);
      if (disposition === 'merged') {
        state.phase = 'merged';
        await this.platform.closeTasks(state);
        await this.platform.save(record);
        await this.status(state);
        return;
      }
      if (disposition === 'closed' && state.phase !== 'cancelled') {
        state.phase = 'cancelled';
        await this.platform.save(record);
        await this.status(state);
      }
    }
    if (!issue.open || !issue.labeled) {
      if (state.phase !== 'cancelled') await this.interrupt(record, 'cancelled');
      await this.status(state);
      return;
    }
    if (terminalPhases.includes(state.phase)) return;

    const comments = (await this.platform.comments(number)).sort((first, second) => first.id - second.id);
    const present = new Set(comments.map(comment => `comment:${comment.id}`));
    state.processedEvents = state.processedEvents.filter(key => present.has(key));
    for (const comment of comments) {
      const key = `comment:${comment.id}`;
      if (!comment.human || state.processedEvents.includes(key)) continue;
      const command = parseCommand(comment.body);
      if (!command) continue;
      const maintainer = await this.platform.canWrite(comment.actor);
      const requester = comment.actor.toLowerCase() === state.requester.toLowerCase();
      state.processedEvents.push(key);
      if (!maintainer && !requester) {
        await this.platform.comment(number, key,
          'Command rejected: only the requester or a repository maintainer can control this lifecycle.');
        await this.platform.save(record);
        continue;
      }
      try {
        if (state.phase === 'pr_open') {
          throw new Error(`The feature pull request #${state.prNumber} is open; manage this change through PR review.`);
        }
        if (command.kind === 'approve') {
          if (this.request(issue) !== state.request) throw new Error('Issue changed; request a revised plan first');
          const baseline = await this.platform.baseline();
          if (baseline.branch !== state.baseBranch ||
              await this.platform.trustedPathsChanged(state.controlSha, baseline.sha)) {
            throw new Error('The trusted revision changed since this plan; request a revised plan first');
          }
          state.approval = approvePlan({
            phase: state.phase, plan: state.plan, version: command.version, authorized: true,
            actor: comment.actor, commentId: comment.id, at: comment.createdAt,
          });
          // No work exists yet, so the approved plan starts from the revision it is approved against.
          state.baseSha = baseline.sha;
          state.headSha = baseline.sha;
          state.controlSha = baseline.sha;
          state.phase = 'decomposing';
        } else if (command.kind === 'revise') {
          const baseline = await this.platform.baseline();
          const previousJob = state.job;
          if (previousJob) this.retainCost(state, previousJob);
          state.retiredTasks.push(...state.tasks.flatMap(task => task.issueNumber ? [task.issueNumber] : []));
          state.job = undefined;
          state.request = this.request(issue);
          state.approval = undefined;
          state.baseSha = baseline.sha;
          state.controlSha = baseline.sha;
          state.headSha = baseline.sha;
          state.baseBranch = baseline.branch;
          state.branch = `agentic/epic-${number}-v${(state.plan?.version ?? 0) + 1}`;
          state.tasks = [];
          state.tasksLinked = undefined;
          state.evidence = [];
          state.feedback = command.feedback.slice(0, 24000);
          state.error = undefined;
          state.phase = 'researching';
          state.resumePhase = undefined;
          await this.platform.save(record);
          if (previousJob) {
            const run = await this.platform.findRun(previousJob);
            if (run && run.status !== 'completed') await this.platform.cancelRun(run.id);
          }
        } else if (command.kind === 'cancel' || command.kind === 'pause') {
          await this.interrupt(record, command.kind === 'pause' ? 'paused' : 'cancelled');
        } else {
          if (!maintainer) throw new Error('Only maintainers can resume or retry execution');
          const expected = command.kind === 'retry' ? 'blocked' : 'paused';
          if (state.phase !== expected || !state.resumePhase) throw new Error(`Lifecycle is not ${expected}`);
          state.phase = state.resumePhase;
          if (state.job) this.retainCost(state, state.job);
          state.job = undefined;
          state.failures = 0;
          state.error = undefined;
        }
      } catch (error) {
        if (error instanceof Error && 'status' in error) throw error;
        await this.platform.comment(number, key, `Command rejected: ${this.message(error)}`);
      }
      await this.platform.save(record);
      if (terminalPhases.includes(state.phase)) break;
    }

    if (state.phase === 'pr_open') {
      await this.status(state);
      return;
    }

    if (state.retiredTasks.length) {
      await this.platform.retireTasks(state.retiredTasks);
      state.retiredTasks = [];
      await this.platform.save(record);
    }

    if (this.request(issue) !== state.request && !['paused', 'blocked', 'cancelled'].includes(state.phase)) {
      await this.interrupt(record, 'blocked');
      state.error = 'Issue text changed. Use /sdlc revise <feedback> to approve the changed scope.';
      await this.platform.save(record);
    }
    await this.status(state);
    if (['awaiting_approval', 'paused', 'blocked', 'cancelled'].includes(state.phase)) return;
    const current = await this.platform.baseline();
    if (current.branch !== state.baseBranch ||
        await this.platform.trustedPathsChanged(state.controlSha, current.sha)) {
      await this.interrupt(record, 'blocked');
      state.error = 'The trusted revision changed. Use /sdlc revise <feedback> to replan against it.';
      await this.platform.save(record);
      await this.status(state);
      return;
    }

    if (state.job) {
      await this.collect(record);
      if (state.job || ['blocked', 'awaiting_approval'].includes(state.phase)) {
        await this.status(state);
        return;
      }
    }
    if (current.sha !== state.controlSha) {
      // No job is registered here, so adopting the head cannot invalidate a pending result, and
      // workflow_dispatch only ever runs at the head: a stale pin would silently skip every worker.
      state.controlSha = current.sha;
      await this.platform.save(record);
    }
    if (state.tasks.length) {
      for (const task of state.tasks) {
        if (!task.issueNumber) {
          task.issueNumber = await this.platform.task(state, task);
          state.tasksLinked = undefined;
          await this.platform.save(record);
        }
      }
      if (!state.tasksLinked) {
        await this.platform.linkTasks(state);
        state.tasksLinked = true;
        await this.platform.save(record);
      }
    }
    if (state.phase === 'publishing') {
      try { assertPublishable(state); }
      catch (error) {
        state.resumePhase = 'coding';
        state.phase = 'blocked';
        state.error = this.message(error);
        await this.platform.save(record);
        await this.status(state);
        return;
      }
      state.prNumber = await this.platform.publish(state);
      state.phase = 'pr_open';
      await this.platform.save(record);
      await this.status(state);
      return;
    }
    const stage = stages[state.phase];
    if (stage) {
      if (state.sequence >= this.policy.maxJobs) {
        state.resumePhase = state.phase;
        state.phase = 'blocked';
        state.error = 'Total job budget exhausted. A maintainer must assess the remaining work.';
        await this.platform.save(record);
      } else {
        startJob(state, stage, this.clock().toISOString());
        await this.platform.save(record);
        await this.send(record);
      }
    }
    await this.status(state);
  }

  private async send(record: RecordState): Promise<void> {
    const job = record.state.job!;
    job.dispatchedAt = this.clock().toISOString();
    await this.platform.save(record);
    await this.platform.dispatch(job, record.state);
  }

  private async collect(record: RecordState): Promise<void> {
    const state = record.state;
    const job = state.job!;
    const run = await this.platform.findRun(job);
    if (!run) {
      if (!job.dispatchedAt) return this.send(record);
      const age = this.clock().getTime() - Date.parse(job.dispatchedAt);
      if (age < this.policy.dispatchGraceMinutes * 60_000) return;
      if (job.attempt >= this.policy.maxJobAttempts) return this.failed(record, 'Worker dispatch did not produce a run');
      job.attempt += 1;
      return this.send(record);
    }
    job.runId = run.id;
    await this.platform.save(record);
    if (run.status !== 'completed') {
      if (this.clock().getTime() - Date.parse(job.createdAt) > this.policy.jobTimeoutMinutes * 60_000) {
        await this.platform.cancelRun(run.id);
        await this.failed(record, `Worker timed out: ${run.url}`);
      }
      return;
    }
    const failed = run.conclusion !== 'success' &&
      !(run.conclusion === 'failure' && ['scan', 'validate'].includes(job.stage));
    // Every completed run is charged, accepted or not: a rejected result still consumed the budget.
    if (job.costedRun !== run.id) {
      let cost: Cost & { runnerMs: number };
      try {
        cost = await this.platform.cost(run, job);
      } catch (error) {
        const retryable = transientPlatformError(error);
        const age = this.clock().getTime() - Date.parse(job.createdAt);
        if (retryable && age <= this.policy.jobTimeoutMinutes * 60_000) throw error;
        const pending = this.retainCost(state, job);
        if (pending) settleCost(state, pending, this.policy.maxJobCredits);
        forgetCost(state, job.id);
        state.spend.historyComplete = false;
        const reason = retryable ? 'remained unavailable past the job timeout' : 'was rejected';
        return this.failed(record, `Cost receipt for ${job.stage} job ${job.id} ${reason}: ` +
          `${this.message(error).slice(0, 6000)}. Inspect ${run.url}.`, false);
      }
      const pending = this.retainCost(state, job, cost)!;
      cost = pending.observed!;
      if (failed || cost.preempted === true || cost.credits === null || cost.preempted === null) {
        await this.attemptDiagnostics(state, job, run, cost, failed);
      }
      if (cost.credits !== null && cost.preempted !== null) {
        await this.finishCost(record, pending, run);
      } else if (this.clock().getTime() > Date.parse(pending.expiresAt)) {
        await this.finishCost(record, pending, run, 'Telemetry remained incomplete past the collection deadline.');
      } else await this.platform.save(record);
    }
    if (failed) {
      return this.failed(record, `Worker ${run.conclusion ?? 'failed'}: ${run.url}. ` +
        `The ${job.stage} stage is incomplete; see the attempt diagnostics.`);
    }
    let report: Report;
    try {
      report = reportSchema.parse(await this.platform.report(run, job));
      assertCurrentResult(state, report.jobId, report.inputSha, run.id);
      validateChanges(report.changes, job.stage, this.policy);
      if (job.stage === 'decompose' && report.outcome === 'pass') {
        validateTasks((report.tasks ?? []).map(task => ({ ...task, completed: false })), this.policy.maxTasks);
      }
      if (job.stage === 'research' && report.outcome === 'pass') makePlan(report.plan ?? '', state.plan?.version ?? 0);
    } catch (error) {
      if (transientPlatformError(error)) {
        const age = this.clock().getTime() - Date.parse(job.createdAt);
        if (age <= this.policy.jobTimeoutMinutes * 60_000) throw error;
        return this.failed(record, `Worker result remained unavailable: ${this.message(error)}`);
      }
      return this.failed(record, `Worker output rejected: ${this.message(error)}`);
    }
    if (report.outcome !== 'pass') recordUsageResult(state, job, report.outcome, state.headSha);
    if (report.outcome === 'blocked') {
      state.resumePhase = state.phase;
      state.phase = 'blocked';
      state.error = report.summary;
      state.job = undefined;
      await this.platform.save(record);
      return;
    }
    if (report.outcome === 'changes_requested') {
      if (['research', 'decompose'].includes(job.stage)) return this.failed(record, report.summary);
      requestRepair(state, report.summary, this.policy.maxRepairs);
      await this.platform.save(record);
      return;
    }
    if (report.changes.length) {
      try {
        const sha = await this.platform.applyChanges(state, job, report.changes);
        recordChange(state, sha);
      } catch (error) {
        if (error instanceof Error && 'status' in error) throw error;
        return this.failed(record, `Publisher rejected changes: ${this.message(error)}`);
      }
    }
    recordUsageResult(state, job, report.outcome, state.headSha);
    state.job = undefined;
    state.failures = 0;
    state.error = undefined;
    if (job.stage === 'research') {
      state.plan = makePlan(report.plan!, state.plan?.version ?? 0);
      state.phase = 'awaiting_approval';
      state.feedback = '';
    } else if (job.stage === 'decompose') {
      state.tasks = report.tasks!.map(task => ({ ...task, completed: false }));
      state.tasksLinked = undefined;
      state.phase = 'coding';
    } else if (job.stage === 'code') {
      const task = state.tasks.find(task => task.id === job.taskId);
      if (task) task.completed = true;
      state.feedback = '';
      state.phase = nextTask(state) ? 'coding' : 'scanning';
    } else {
      state.evidence = state.evidence.filter(item => item.stage !== job.stage);
      state.evidence.push({ stage: job.stage, sha: state.headSha, jobId: job.id, runId: run.id, summary: report.summary });
      if (job.stage === 'scan') state.phase = 'security';
      if (job.stage === 'security') state.phase = state.evidence.some(item => item.stage === 'test' && item.sha === state.headSha)
        ? 'validating' : 'testing';
      if (job.stage === 'test') state.phase = report.changes.length ? 'scanning' : 'validating';
      if (job.stage === 'validate') state.phase = 'documenting';
      if (job.stage === 'document') state.phase = report.changes.length ? 'scanning' : 'reviewing';
      if (job.stage === 'review') state.phase = 'publishing';
    }
    await this.platform.save(record);
    await this.platform.comment(state.issueNumber, `job:${job.id}`, `### ${job.stage}\n\n${report.summary}\n\n[Workflow evidence](${run.url})`);
  }

  private async attemptDiagnostics(state: Lifecycle, job: Job, run: Run, cost: Cost & { runnerMs: number }, failed: boolean): Promise<void> {
    let checkpoint = '';
    if (job.stage === 'security' && failed) {
      try {
        const report = reportSchema.parse(await this.platform.report(run, job));
        assertCurrentResult(state, report.jobId, report.inputSha, run.id);
        validateChanges(report.changes, job.stage, this.policy);
        checkpoint = `\n\nLast Security checkpoint/result (untrusted diagnostic only, not accepted evidence):\n\n${report.summary.slice(0, 6000)}`;
      } catch {
        checkpoint = '\n\nNo valid current-job Security checkpoint was available. Review completeness is unknown.';
      }
    }
    const credits = cost.credits === null ? 'unavailable' : `${cost.credits.toFixed(1)} AI credits`;
    const cap = cost.creditLimit === undefined ? `${this.policy.maxJobCredits} (current configuration fallback)` : String(cost.creditLimit);
    const preemption = cost.preempted === null ? 'unknown (signal unavailable)' :
      cost.preempted ? 'reported by the workflow' : 'not reported (does not establish completeness)';
    await this.platform.comment(state.issueNumber, `attempt:${job.id}:${run.id}`,
      `### Worker attempt diagnostics\n\nStage: **${job.stage}**. Job: \`${job.id}\`. [Run ${run.id}](${run.url}).\n\n` +
      `Source: \`${job.inputSha}\`. Trusted revision: \`${job.controlSha}\`. Plan: \`${job.planHash ?? 'not yet approved'}\`.\n\n` +
      `Workflow conclusion: ${run.conclusion ?? 'unknown'}. Measured usage: ${credits}. ` +
      `Credit limit: ${cap}. Runner time: ${(cost.runnerMs / 60_000).toFixed(1)} minutes.\n\n` +
      `Pre-emption: ${preemption}. ` +
      (failed ? 'This attempt did not complete the stage and cannot supply passing evidence.' :
        'Telemetry warning: inspect the run and remaining work. Telemetry alone does not prove review completion.') + checkpoint);
  }

  private retainCost(state: Lifecycle, job: Job, observed?: PendingCost['observed']): PendingCost | undefined {
    const expiresAt = new Date(this.clock().getTime() + this.policy.jobTimeoutMinutes * 60_000).toISOString();
    return deferCost(state, job, expiresAt, observed);
  }

  private async reconcileCosts(record: RecordState): Promise<void> {
    for (const pending of [...record.state.pendingCosts ?? []]) {
      if (pending.job.id === record.state.job?.id) continue;
      let run: Run | undefined;
      let cost: PendingCost['observed'];
      let failure: { message: string; retryable: boolean } | undefined;
      try {
        run = await this.platform.findRun(pending.job);
        if (run?.status === 'completed') cost = await this.platform.cost(run, pending.job);
        else if (run) await this.platform.cancelRun(run.id);
      } catch (error) {
        failure = { message: this.message(error),
          retryable: run !== undefined && run.status !== 'completed' || transientPlatformError(error) };
      }
      const discovered = run !== undefined && pending.job.runId !== run.id;
      if (run) pending.job.runId = run.id;
      if (cost) observeCost(pending, cost);
      if (pending.observed && pending.observed.credits !== null && pending.observed.preempted !== null) {
        await this.finishCost(record, pending, run);
      } else if (this.clock().getTime() > Date.parse(pending.expiresAt) || failure && !failure.retryable) {
        const reason = failure ? `Cost collection failed: ${failure.message.slice(0, 6000)}` :
          'The run or its complete telemetry remained unavailable past the collection deadline.';
        await this.finishCost(record, pending, run, reason);
      } else if (discovered || cost) await this.platform.save(record);
    }
  }

  private async finishCost(record: RecordState, pending: PendingCost, run?: Run, reason?: string): Promise<void> {
    const state = record.state;
    if (reason) {
      await this.platform.comment(state.issueNumber, `accounting:${pending.job.id}`,
        `### Incomplete cost accounting\n\nJob: \`${pending.job.id}\` (${pending.job.stage}). ` +
        (run ? `[Run ${run.id}](${run.url}). ` : `Run: ${pending.job.runId ?? 'not discovered'}. `) +
        `Source: \`${pending.job.inputSha}\`. Trusted revision: \`${pending.job.controlSha}\`. ` +
        `Plan: \`${pending.job.planHash ?? 'not yet approved'}\`.\n\n${reason}\n\n` +
        'Only observed values were recorded. Missing telemetry is not measured zero. ' +
        'Automatic collection has stopped; this accounting record does not accept any worker result.');
    }
    settleCost(state, pending, this.policy.maxJobCredits);
    if (reason) state.spend.historyComplete = false;
    if (state.job?.id === pending.job.id && pending.job.runId !== undefined) state.job.costedRun = pending.job.runId;
    forgetCost(state, pending.job.id);
    await this.platform.save(record);
  }

  private async failed(record: RecordState, message: string, retainCost = true): Promise<void> {
    const state = record.state;
    if (retainCost && state.job) this.retainCost(state, state.job);
    state.failures += 1;
    state.job = undefined;
    state.error = message;
    if (state.failures >= this.policy.maxJobAttempts) {
      state.resumePhase = state.phase;
      state.phase = 'blocked';
    }
    await this.platform.save(record);
  }

  private async interrupt(record: RecordState, phase: 'paused' | 'cancelled' | 'blocked'): Promise<void> {
    const state = record.state;
    const job = state.job;
    if (!['paused', 'blocked', 'cancelled', 'merged'].includes(state.phase)) state.resumePhase = state.phase;
    state.phase = phase;
    if (job) this.retainCost(state, job);
    state.job = undefined;
    await this.platform.save(record);
    if (job) {
      const run = await this.platform.findRun(job);
      if (run && run.status !== 'completed') await this.platform.cancelRun(run.id);
    }
  }

  private spend(state: Lifecycle): string {
    const { runs, runnerMs, credits, nearLimit, preempted } = state.spend;
    const label = state.spend.historyComplete ? 'Cost' : 'Recorded cost (earlier costs unavailable)';
    return `${label}: ${(runnerMs / 60_000).toFixed(1)} runner minutes, ${credits.toFixed(1)} AI credits ` +
      `over ${runs} run${runs === 1 ? '' : 's'}. Near-limit runs: ${nearLimit}. Pre-empted: ${preempted}. ` +
      (state.pendingCosts?.length ? `Pending cost collection: ${state.pendingCosts.length} job(s), excluded from these totals. ` : '') +
        `Current per-job limit: ${this.policy.maxJobCredits} AI credits.\n\n` +
      `Observed agent models: ${formatObservedModels(state.spend.models)}. ` +
        'Available primary-agent telemetry only; missing/legacy runs and separate detection inference are not covered.';
  }

  private async status(state: Lifecycle): Promise<void> {
    if (state.phase === 'awaiting_approval' && state.plan) {
      await this.platform.comment(state.issueNumber, `plan:${state.plan.hash}`,
        `## Proposed plan v${state.plan.version}\n\n${state.plan.body}\n\nPlan hash: \`${state.plan.hash}\`\n\n` +
        `@${state.requester}: approve with \`/sdlc approve v${state.plan.version}\` or request changes with \`/sdlc revise <feedback>\`.`);
    }
    await this.platform.comment(state.issueNumber, 'status',
      `## Agentic SDLC\n\nState: **${state.phase}**\n\n` +
      `Tasks: ${state.tasks.filter(task => task.completed).length}/${state.tasks.length}. ` +
      `Jobs: ${state.sequence}/${this.policy.maxJobs}. Repairs: ${state.repairs}/${this.policy.maxRepairs}.\n\n` +
      `${this.spend(state)}\n\n` +
      (state.job ? `Active job: \`${state.job.id}\` (${state.job.stage}).\n\n` : '') +
      (state.error ? `${state.error}\n\n` : '') +
      (state.prNumber ? `Feature PR: #${state.prNumber}\n\n` : '') +
      (['pr_open', 'merged', 'cancelled'].includes(state.phase)
        ? 'This lifecycle no longer accepts `/sdlc` commands. Continue through pull request review.'
        : 'Controls: `/sdlc pause`, `/sdlc resume`, `/sdlc cancel`, `/sdlc retry`.'));
  }

  private request(issue: Issue): string { return this.requestText(issue.title, issue.body); }
  private requestText(title: string, body: string): string { return `${title}\n\n${body}`.trim().slice(0, 60000); }
  private message(error: unknown): string { return (error instanceof Error ? error.message : 'Unexpected controller failure').slice(0, 12000); }
}