import { unzipSync } from 'fflate';
import { z } from 'zod';
import { repositorySchema, shaSchema, type Intake } from './contracts.ts';
import type { Controller } from './controller.ts';
import type { GitHub } from './github.ts';
import { intakeWorkflow, receiptWorkflow, type Target } from './targets.ts';

export const receiptArtifact = 'sdlc-intake';
// Receipts older than the lookback are never accepted, which bounds both the scan window and replay exposure.
export const receiptLookbackMs = 24 * 60 * 60 * 1000;
// Run listings are eventually consistent, so the scan window trails the clock instead of jumping to it.
export const listingMarginMs = 60 * 60 * 1000;
export const artifactGraceMs = 15 * 60 * 1000;
export const maxInspectedRuns = 50;
const maxProcessedRuns = 1000;
const maxReceiptBytes = 1_000_000;
const maxCallerBytes = 64_000;
const placeholders = ['__CONTROL_REPOSITORY__', '__RECEIPT_REF__', '__LABEL__'] as const;
const safeLabel = /^[A-Za-z0-9](?:[A-Za-z0-9 ._:-]{0,48}[A-Za-z0-9])?$/;

const login = z.string().min(1).max(100);

export const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.string().max(50),
  label: z.string().max(100),
  repository: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), fullName: repositorySchema }).strict(),
  issue: z.object({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    title: z.string().min(1).max(256).regex(/\S/),
    body: z.string().max(65536),
    author: login,
  }).strict(),
  sender: z.object({ login, type: z.string().max(50) }).strict(),
}).strict();

export type Receipt = z.infer<typeof receiptSchema>;

const cursorSchema = z.object({
  schemaVersion: z.literal(1),
  targetId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  since: z.iso.datetime(),
  processed: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(maxProcessedRuns),
}).strict();

type Cursor = z.infer<typeof cursorSchema>;

export interface ReceiptOutcome {
  runId: number;
  issue?: number;
  outcome: 'accepted' | 'rejected' | 'ignored' | 'deferred' | 'failed';
  reason: string;
}

interface ReceiptRun {
  id: number;
  event: string;
  path: string;
  status: string | null;
  conclusion: string | null;
  run_attempt?: number;
  created_at: string;
  updated_at: string;
  head_sha: string;
  repository: { id: number };
  actor?: { login: string } | null;
  triggering_actor?: { login: string } | null;
  referenced_workflows?: { path: string; sha: string; ref?: string }[] | null;
}

type Verdict = { kind: 'accept'; intake: Intake } | { kind: 'reject' | 'ignore' | 'defer'; reason: string };

export function renderIntakeWorkflow(template: string, control: string, receiptRef: string, label: string): string {
  repositorySchema.parse(control);
  shaSchema.parse(receiptRef);
  // The label is interpolated into a quoted workflow expression, so only characters that cannot escape it are allowed.
  if (!safeLabel.test(label)) throw new Error('The intake label cannot be rendered safely into a workflow');
  if (placeholders.some(placeholder => !template.includes(placeholder))) throw new Error('The intake template is missing a placeholder');
  return template.replaceAll('__CONTROL_REPOSITORY__', control).replaceAll('__RECEIPT_REF__', receiptRef)
    .replaceAll('__LABEL__', label);
}

export function decodeReceiptArchive(bytes: Uint8Array): Receipt {
  if (bytes.byteLength > maxReceiptBytes) throw new Error('Receipt artifact exceeds size limit');
  const files = unzipSync(bytes, { filter: file => file.name === 'receipt.json' && file.originalSize <= maxReceiptBytes });
  const receipt = files['receipt.json'];
  if (!receipt) throw new Error('Missing receipt.json');
  return receiptSchema.parse(JSON.parse(Buffer.from(receipt).toString('utf8')));
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'status' in error && error.status === 404;
}

function cursorPath(target: Target): string {
  return `targets/${target.id}/intake.json`;
}

async function loadCursor(github: GitHub, target: Target): Promise<{ cursor: Cursor; version: string } | undefined> {
  try {
    const { data } = await github.controlApi.repos.getContent({ ...github.control, path: cursorPath(target), ref: github.policy.stateBranch });
    if (Array.isArray(data) || data.type !== 'file' || data.size > 1_000_000) throw new Error('Invalid intake cursor');
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')));
    if (cursor.targetId !== target.id) throw new Error('Intake cursor belongs to another target');
    return { cursor, version: data.sha };
  } catch (error) { if (missing(error)) return undefined; throw error; }
}

async function saveCursor(github: GitHub, target: Target, cursor: Cursor, version?: string): Promise<void> {
  const content = JSON.stringify(cursorSchema.parse(cursor), null, 2) + '\n';
  await github.ensureStateBranch();
  // The stored version makes this a compare-and-swap; a concurrent writer fails here instead of losing receipts.
  await github.controlApi.repos.createOrUpdateFileContents({ ...github.control, branch: github.policy.stateBranch,
    path: cursorPath(target), message: `SDLC ${target.id}: intake cursor`, content: Buffer.from(content).toString('base64'),
    ...(version ? { sha: version } : {}) });
}

// A fork-network or unmerged commit can be addressed through the control repository, so the pin must be on its default branch.
async function assertReceiptRef(github: GitHub, target: Target): Promise<void> {
  const head = await github.controlRevision();
  try {
    const { data } = await github.controlApi.repos.compareCommits({ ...github.control, base: target.intake.receiptRef, head: head.sha });
    if (data.status === 'ahead' || data.status === 'identical') return;
  } catch (error) { if (!missing(error)) throw error; }
  throw new Error(`Receipt pin ${target.intake.receiptRef} is not on the control default branch ${head.branch}`);
}

function screen(github: GitHub, target: Target, run: ReceiptRun): Verdict | undefined {
  const reject = (reason: string): Verdict => ({ kind: 'reject', reason });
  if (run.event !== 'issues' || run.path !== intakeWorkflow || run.repository.id !== target.id) {
    return reject('not an issues-event intake run of this target');
  }
  // A skipped run is the template's own label filter, not an attack, so it is recorded without noise.
  if (run.conclusion === 'skipped') return { kind: 'ignore', reason: 'the event did not carry the intake label' };
  if (run.run_attempt !== 1) return reject('re-run attempts are not receipts');
  if (Date.parse(run.created_at) < Date.parse(target.activatedAt)) return reject('the run predates target activation');
  if (run.conclusion !== 'success') return reject(`the run concluded ${run.conclusion ?? 'without a result'}`);
  const actor = run.actor?.login;
  if (!actor || run.triggering_actor?.login !== actor) return reject('the triggering actor differs from the event actor');
  const callee = `${github.control.owner}/${github.control.repo}/${receiptWorkflow}@${target.intake.receiptRef}`.toLowerCase();
  const references = run.referenced_workflows ?? [];
  if (references.length !== 1 || references[0]!.sha !== target.intake.receiptRef || references[0]!.path.toLowerCase() !== callee) {
    return reject('the run did not call the pinned receipt workflow');
  }
  return undefined;
}

async function callerMatches(github: GitHub, sha: string, expected: string): Promise<boolean> {
  try {
    const { data } = await github.api.repos.getContent({ ...github.scope, path: intakeWorkflow, ref: sha });
    if (Array.isArray(data) || data.type !== 'file' || data.size > maxCallerBytes) return false;
    return Buffer.from(data.content, 'base64').toString('utf8').replaceAll('\r\n', '\n') === expected;
  } catch (error) { if (missing(error)) return false; throw error; }
}

async function inspect(github: GitHub, target: Target, run: ReceiptRun, callers: Map<string, boolean>,
  expected: string, now: number): Promise<Verdict> {
  const reject = (reason: string): Verdict => ({ kind: 'reject', reason });
  // The caller decides which callee runs and with what inputs, so only the exact rendered template is trusted.
  let matches = callers.get(run.head_sha);
  if (matches === undefined) {
    matches = await callerMatches(github, run.head_sha, expected);
    callers.set(run.head_sha, matches);
  }
  if (!matches) return reject('the caller workflow differs from the rendered template');
  const artifacts = (await github.api.paginate(github.api.actions.listWorkflowRunArtifacts, {
    ...github.scope, run_id: run.id, per_page: 100,
  })).filter(artifact => artifact.name === receiptArtifact);
  if (!artifacts.length) {
    return now - Date.parse(run.updated_at) < artifactGraceMs
      ? { kind: 'defer', reason: 'the receipt artifact is not available yet' } : reject('the run produced no receipt artifact');
  }
  const artifact = artifacts[0]!;
  if (artifacts.length !== 1 || artifact.expired || artifact.size_in_bytes > maxReceiptBytes) {
    return reject('duplicate, expired, or oversized receipt artifact');
  }
  const response = await github.api.actions.downloadArtifact({ ...github.scope, artifact_id: artifact.id, archive_format: 'zip' });
  let receipt: Receipt;
  try { receipt = decodeReceiptArchive(new Uint8Array(response.data as ArrayBuffer)); }
  catch { return reject('the receipt artifact is malformed'); }
  if (receipt.repository.id !== target.id || receipt.action !== 'labeled' || receipt.label !== github.policy.label) {
    return reject('the receipt is not an intake-label event for this target');
  }
  if (receipt.sender.type !== 'User' || receipt.sender.login.toLowerCase() !== run.actor!.login.toLowerCase()) {
    return reject('the receipt sender is not the human who triggered the run');
  }
  return { kind: 'accept', intake: { issueNumber: receipt.issue.number, actor: receipt.sender.login,
    requester: receipt.issue.author, title: receipt.issue.title, body: receipt.issue.body } };
}

// Each authenticated receipt is evaluated once; the controller still rechecks the issue state and labeler's write access.
export async function pollReceipts(github: GitHub, controller: Pick<Controller, 'tick'>, target: Target,
  template: string, now = new Date()): Promise<ReceiptOutcome[]> {
  if (github.target?.id !== target.id) throw new Error('Receipt polling requires the adapter bound to this target');
  if (!target.enabled) return [];
  const expected = renderIntakeWorkflow(template, `${github.control.owner}/${github.control.repo}`,
    target.intake.receiptRef, github.policy.label);
  const stored = await loadCursor(github, target);
  const cursor = stored?.cursor ?? { schemaVersion: 1, targetId: target.id, since: target.activatedAt, processed: [] };
  const clock = now.getTime();
  const since = Math.max(Date.parse(cursor.since), Date.parse(target.activatedAt), clock - receiptLookbackMs);
  const runs: ReceiptRun[] = await github.api.paginate(github.api.actions.listWorkflowRuns, {
    ...github.scope, workflow_id: intakeWorkflow.split('/').pop()!, event: 'issues',
    created: `>=${new Date(since).toISOString()}`, per_page: 100,
  });
  const processed = new Set(cursor.processed);
  const created = new Map<number, number>();
  const callers = new Map<string, boolean>();
  const outcomes: ReceiptOutcome[] = [];
  let hold = clock - listingMarginMs;
  let inspected = 0;
  let pinned = false;
  let decided = false;
  for (const run of [...runs].sort((first, second) => first.id - second.id)) {
    const at = Date.parse(run.created_at);
    created.set(run.id, at);
    if (processed.has(run.id)) continue;
    const defer = (outcome: 'deferred' | 'failed', reason: string, issue?: number) => {
      hold = Math.min(hold, at);
      outcomes.push({ runId: run.id, outcome, reason, ...(issue ? { issue } : {}) });
    };
    if (run.status !== 'completed') { defer('deferred', 'the receipt run has not completed'); continue; }
    let verdict = screen(github, target, run);
    if (!verdict) {
      if (inspected >= maxInspectedRuns) { defer('deferred', 'the receipt budget for this reconciliation is spent'); continue; }
      inspected++;
      if (!pinned) { await assertReceiptRef(github, target); pinned = true; }
      verdict = await inspect(github, target, run, callers, expected, clock);
    }
    if (verdict.kind === 'defer') { defer('deferred', verdict.reason); continue; }
    if (verdict.kind !== 'accept') {
      processed.add(run.id);
      decided = true;
      outcomes.push({ runId: run.id, outcome: verdict.kind === 'ignore' ? 'ignored' : 'rejected', reason: verdict.reason });
      continue;
    }
    // The tick runs before the cursor records the receipt, so an interruption repeats an idempotent tick instead of losing intake.
    try {
      await controller.tick(verdict.intake.issueNumber, verdict.intake);
      processed.add(run.id);
      decided = true;
      outcomes.push({ runId: run.id, issue: verdict.intake.issueNumber, outcome: 'accepted', reason: 'authenticated intake receipt' });
    } catch (error) {
      defer('failed', error instanceof Error ? error.message : 'controller failure', verdict.intake.issueNumber);
    }
  }
  const next = Math.max(since, hold);
  // Runs before the next window start are never listed again, so only receipts still inside it need remembering.
  const retained = [...processed].filter(id => (created.get(id) ?? -Infinity) >= next)
    .sort((first, second) => first - second).slice(-maxProcessedRuns);
  const updated: Cursor = { schemaVersion: 1, targetId: target.id, since: new Date(next).toISOString(), processed: retained };
  // A decided receipt is always recorded, even when the window moves past it, so it is not inspected again.
  // An idle target only slides its window, so it is written at most once per margin rather than every reconciliation.
  if (!stored || decided || retained.join() !== stored.cursor.processed.join()
    || next - Date.parse(stored.cursor.since) >= listingMarginMs) {
    await saveCursor(github, target, updated, stored?.version);
  }
  return outcomes;
}
