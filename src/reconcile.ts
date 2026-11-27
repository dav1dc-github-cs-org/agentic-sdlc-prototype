import type { Octokit } from '@octokit/rest';
import { Controller } from './controller.ts';
import { parseIntakeEvent, type Intake, type Policy } from './contracts.ts';
import { GitHub } from './github.ts';
import { pollReceipts } from './receipts.ts';
import { parseRunTitle, type Registry, type Target } from './targets.ts';

export interface ReconcileOptions {
  repository: string;
  sha?: string;
  policy: Policy;
  botLogin: string;
  model?: string;
  controlApi: Octokit;
  registry: Registry;
  event: Record<string, unknown>;
  issue?: string;
  target?: string;
  targetApi: (target: Target) => Promise<Octokit>;
  template: () => string;
  clock?: () => Date;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

function selection(value: string | number, label: string): number {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(number)) throw new Error(`Invalid ${label}`);
  return number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'controller failure';
}

// Returns false when any lifecycle failed, so the workflow reports failure without one target blocking the rest.
export async function reconcile(options: ReconcileOptions): Promise<boolean> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const { repository, policy, botLogin, controlApi } = options;
  const self = new GitHub(repository, policy, botLogin, controlApi, options.model);
  if (options.sha && (await self.controlRevision()).sha !== options.sha) {
    throw new Error('Controller revision is stale; the next reconciliation must run on the current default branch');
  }
  const event = options.event as { issue?: { number?: number; pull_request?: unknown }; workflow_run?: { display_title?: string } };
  if (event.issue?.pull_request) return true;
  const run = parseRunTitle(event.workflow_run?.display_title ?? '');
  const requested = options.target ? selection(options.target, 'target ID') : undefined;
  const targetId = requested ?? run?.targetId;

  const tick = async (controller: Controller, number: number, target?: Target, intake?: Intake) => {
    const name = target ? `${target.repository}#${number}` : `issue #${number}`;
    try {
      await controller.tick(number, intake);
      log(`Reconciled ${name}`);
      return true;
    } catch (failure) {
      error(`${target ? name : `Issue #${number}`}: ${message(failure)}`);
      return false;
    }
  };

  const reconcileTarget = async (target: Target, issues?: number[]) => {
    let ok = true;
    try {
      const api = await options.targetApi(target);
      const github = new GitHub(repository, policy, botLogin, controlApi, options.model,
        { id: target.id, repository: target.repository, api });
      // Receipts persist target issue text into control-plane state, so identity and exposure are proven first.
      await github.verifyTarget();
      const controller = new Controller(github, policy, options.clock);
      const ticked = new Set<number>();
      // Issue numbers repeat across repositories, so only this target's receipts and records select its issues.
      if (!issues) {
        try {
          for (const outcome of await pollReceipts(github, controller, target, options.template(), options.clock?.())) {
            if (outcome.outcome === 'accepted') ticked.add(outcome.issue!);
            if (outcome.outcome === 'failed') { ok = false; error(`${target.repository} receipt ${outcome.runId}: ${outcome.reason}`); }
            else if (outcome.outcome !== 'ignored') log(`${target.repository} receipt ${outcome.runId}: ${outcome.outcome} (${outcome.reason})`);
          }
        } catch (failure) {
          ok = false;
          error(`${target.repository} intake: ${message(failure)}`);
        }
      }
      for (const number of issues ?? await github.activeIssues()) {
        if (!ticked.has(number)) ok = await tick(controller, number, target) && ok;
      }
    } catch (failure) {
      error(`${target.repository}: ${message(failure)}`);
      return false;
    }
    return ok;
  };

  if (targetId !== undefined) {
    const target = options.registry.targets.find(item => item.id === targetId && item.enabled);
    if (!target) {
      error(`Target ${targetId} is not an enabled registered target`);
      // A completed worker for a since-disabled target is not a controller failure; a manual request for one is.
      return requested === undefined;
    }
    const issue = options.issue ? selection(options.issue, 'issue number') : requested === undefined ? run?.issue : undefined;
    return reconcileTarget(target, issue ? [issue] : undefined);
  }

  const intake = parseIntakeEvent(event, policy.label);
  const selected = options.issue || intake?.issueNumber || event.issue?.number || run?.issue;
  const controller = new Controller(self, policy, options.clock);
  let ok = true;
  for (const number of selected ? [selection(selected, 'issue number')] : await self.activeIssues()) {
    ok = await tick(controller, number, undefined, intake?.issueNumber === number ? intake : undefined) && ok;
  }
  if (!selected) {
    for (const target of options.registry.targets.filter(item => item.enabled)) ok = await reconcileTarget(target) && ok;
  }
  return ok;
}
