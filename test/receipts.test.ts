import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Octokit } from '@octokit/rest';
import { strToU8, zipSync } from 'fflate';
import { parse } from 'yaml';
import { policySchema, type Intake } from '../src/contracts.ts';
import { GitHub } from '../src/github.ts';
import {
  decodeReceiptArchive, maxInspectedRuns, pollReceipts, receiptArtifact, receiptSchema, renderIntakeWorkflow,
} from '../src/receipts.ts';
import { intakeTemplate, intakeWorkflow, receiptWorkflow, type Target } from '../src/targets.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const receiptRef = 'd'.repeat(40);
const controlSha = 'c'.repeat(40);
const callerSha = 'e'.repeat(40);
const forgedSha = 'f'.repeat(40);
const now = new Date('2026-09-10T12:00:00Z');
const template = readFileSync(intakeTemplate, 'utf8');
const rendered = renderIntakeWorkflow(template, 'owner/control', receiptRef, policy.label);

type Handler = (method: string, path: string, body: Record<string, unknown>, query: URLSearchParams) => unknown;

function api(handler: Handler) {
  return new Octokit({ log: { debug() {}, info() {}, warn() {}, error() {} }, request: { fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const result = handler(init?.method ?? 'GET', decodeURIComponent(url.pathname),
      init?.body ? JSON.parse(String(init.body)) : {}, url.searchParams);
    const response = result instanceof Response ? result :
      new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  } } });
}

const notFound = () => new Response('{"message":"Not Found"}', { status: 404 });
const zip = (bytes: Uint8Array) => new Response(Buffer.from(bytes), { status: 200, headers: { 'content-type': 'application/zip' } });

function target(overrides: Partial<Target> = {}): Target {
  return { id: 42, repository: 'octo/app', enabled: true, activatedAt: '2026-09-01T00:00:00Z',
    intake: { workflow: intakeWorkflow, receiptRef }, ...overrides };
}

function run(id: number, overrides: Record<string, unknown> = {}) {
  return { id, event: 'issues', path: intakeWorkflow, status: 'completed', conclusion: 'success', run_attempt: 1,
    created_at: '2026-09-10T11:30:00Z', updated_at: '2026-09-10T11:31:00Z', head_sha: callerSha,
    repository: { id: 42 }, actor: { login: 'maintainer' }, triggering_actor: { login: 'maintainer' },
    referenced_workflows: [{ path: `owner/control/${receiptWorkflow}@${receiptRef}`, sha: receiptRef, ref: receiptRef }],
    ...overrides };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, action: 'labeled', label: policy.label, repository: { id: 42, fullName: 'octo/app' },
    issue: { number: 7, title: 'Feature', body: 'Requested behavior', author: 'requester' },
    sender: { login: 'maintainer', type: 'User' }, ...overrides };
}

const archive = (content: unknown) => zipSync({ 'receipt.json': strToU8(JSON.stringify(content)) });
const artifact = (id: number, overrides: Record<string, unknown> = {}) =>
  ({ id, name: receiptArtifact, expired: false, size_in_bytes: 500, ...overrides });

interface Fixture {
  runs: ReturnType<typeof run>[];
  artifacts?: Record<number, ReturnType<typeof artifact>[]>;
  archives?: Record<number, Uint8Array>;
  cursor?: unknown;
  compare?: string | 404;
  boundTo?: number;
}

function fixture(options: Fixture) {
  const requests: string[] = [];
  const saved: { content: Record<string, unknown>; sha?: string }[] = [];
  let cursor = options.cursor === undefined ? undefined : { content: options.cursor, sha: 'v1' };
  const control = api((method, path, body, query) => {
    requests.push(`control ${method} ${path}`);
    if (method === 'GET' && path === '/repos/owner/control') return { id: 1, full_name: 'owner/control', default_branch: 'main' };
    if (method === 'GET' && path === '/repos/owner/control/git/ref/heads/main') return { object: { sha: controlSha } };
    if (method === 'GET' && path === `/repos/owner/control/git/ref/heads/${policy.stateBranch}`) return { object: { sha: 'state' } };
    if (method === 'GET' && path === `/repos/owner/control/compare/${receiptRef}...${controlSha}`) {
      return options.compare === 404 ? notFound() : { status: options.compare ?? 'ahead' };
    }
    if (path === '/repos/owner/control/contents/targets/42/intake.json') {
      if (method === 'GET') {
        assert.equal(query.get('ref'), policy.stateBranch);
        if (!cursor) return notFound();
        const content = Buffer.from(JSON.stringify(cursor.content)).toString('base64');
        return { type: 'file', sha: cursor.sha, size: content.length, content };
      }
      if (method === 'PUT') {
        const content = JSON.parse(Buffer.from(String(body.content), 'base64').toString('utf8'));
        saved.push({ content, ...(body.sha ? { sha: String(body.sha) } : {}) });
        cursor = { content, sha: `v${saved.length + 1}` };
        return { content: { sha: cursor.sha } };
      }
    }
    throw new Error(`Unexpected control request: ${method} ${path}`);
  });
  const targetApi = api((method, path, _body, query) => {
    requests.push(`target ${method} ${path}`);
    if (method === 'GET' && path === '/repos/octo/app/actions/workflows/sdlc-intake.yml/runs') {
      assert.equal(query.get('event'), 'issues');
      requests.push(`created ${query.get('created')}`);
      return { total_count: options.runs.length, workflow_runs: options.runs };
    }
    if (method === 'GET' && path === `/repos/octo/app/contents/${intakeWorkflow}`) {
      const content = query.get('ref') === forgedSha ? rendered.replace('permissions: {}', 'permissions: write-all') : rendered;
      return { type: 'file', sha: 'blob', size: content.length, content: Buffer.from(content).toString('base64') };
    }
    const listing = /^\/repos\/octo\/app\/actions\/runs\/(\d+)\/artifacts$/.exec(path);
    if (method === 'GET' && listing) {
      const id = Number(listing[1]);
      const artifacts = options.artifacts?.[id] ?? [artifact(id)];
      return { total_count: artifacts.length, artifacts };
    }
    const download = /^\/repos\/octo\/app\/actions\/artifacts\/(\d+)\/zip$/.exec(path);
    if (method === 'GET' && download) return zip(options.archives?.[Number(download[1])] ?? archive(receipt()));
    throw new Error(`Unexpected target request: ${method} ${path}`);
  });
  const github = new GitHub('owner/control', policy, 'sdlc[bot]', control, 'auto',
    { id: options.boundTo ?? 42, repository: 'octo/app', api: targetApi });
  const ticks: { number: number; intake?: Intake }[] = [];
  const failing = new Set<number>();
  const controller = { tick: async (number: number, intake?: Intake) => {
    ticks.push({ number, ...(intake ? { intake } : {}) });
    if (failing.has(number)) throw new Error('transient platform failure');
  } };
  return { github, controller, requests, saved, ticks, failing };
}

test('the intake template renders a pinned, label-filtered, secret-free caller', () => {
  const workflow = parse(rendered);
  assert.deepEqual(workflow.on, { issues: { types: ['labeled'] } });
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ['receipt']);
  assert.deepEqual(workflow.jobs.receipt, {
    if: `github.event.label.name == '${policy.label}'`,
    uses: `owner/control/${receiptWorkflow}@${receiptRef}`,
  });
  assert.equal(rendered.includes('__'), false);
  assert.equal(/secrets|inherit|concurrency/.test(rendered), false);
  for (const label of ["x' || true || '", 'line\nbreak', '', ' padded', 'a'.repeat(51), 'dollar${{']) {
    assert.throws(() => renderIntakeWorkflow(template, 'owner/control', receiptRef, label), /rendered safely/);
  }
  assert.throws(() => renderIntakeWorkflow(template, 'owner/control', 'main', policy.label));
  assert.throws(() => renderIntakeWorkflow(template, 'owner', receiptRef, policy.label));
  assert.throws(() => renderIntakeWorkflow('name: x', 'owner/control', receiptRef, policy.label), /placeholder/);
});

test('the receipt callee holds no credentials and snapshots only allowlisted event fields', { skip: spawnSync('jq', ['--version']).status !== 0 }, () => {
  const source = readFileSync(`${receiptWorkflow}`, 'utf8');
  const workflow = parse(source);
  assert.deepEqual(workflow.on, { workflow_call: {} });
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.receipt.permissions, {});
  assert.equal(/\$\{\{\s*secrets|github\.token|GITHUB_TOKEN|actions\/checkout/.test(source), false);
  const steps = workflow.jobs.receipt.steps as { run?: string; uses?: string; with?: Record<string, unknown> }[];
  assert.match(steps[1]!.uses!, /^actions\/upload-artifact@[a-f0-9]{40}$/);
  assert.equal(steps[1]!.with!.name, receiptArtifact);
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-receipt-'));
  try {
    const event = join(directory, 'event.json');
    writeFileSync(event, JSON.stringify({
      action: 'labeled', label: { name: policy.label, color: 'fff' },
      repository: { id: 42, full_name: 'octo/app', private: true },
      issue: { number: 7, title: 'Feature', body: null, user: { login: 'requester', site_admin: false }, labels: [{ name: 'x' }] },
      sender: { login: 'maintainer', type: 'User', site_admin: true }, installation: { id: 9 },
    }));
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', steps[0]!.run!], {
      encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_EVENT_PATH: event },
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(readFileSync(join(directory, 'sdlc-intake/receipt.json'), 'utf8'));
    assert.deepEqual(receiptSchema.parse(snapshot), receipt({ issue: { number: 7, title: 'Feature', body: '', author: 'requester' } }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('receipt archives are bounded and schema-checked', () => {
  assert.deepEqual(decodeReceiptArchive(archive(receipt())), receipt());
  assert.throws(() => decodeReceiptArchive(zipSync({ 'other.json': strToU8('{}') })), /Missing/);
  assert.throws(() => decodeReceiptArchive(archive({ ...receipt(), extra: true })));
  assert.throws(() => decodeReceiptArchive(new Uint8Array(1_000_001)), /size limit/);
});

test('an authenticated receipt starts intake once and its replay is skipped', async () => {
  const first = fixture({ runs: [run(101)] });
  const outcomes = await pollReceipts(first.github, first.controller, target(), template, now);
  assert.deepEqual(outcomes, [{ runId: 101, issue: 7, outcome: 'accepted', reason: 'authenticated intake receipt' }]);
  assert.deepEqual(first.ticks, [{ number: 7, intake: { issueNumber: 7, actor: 'maintainer', requester: 'requester',
    title: 'Feature', body: 'Requested behavior' } }]);
  // The lookback bounds the scan even though the target was activated days earlier.
  assert.ok(first.requests.includes('created >=2026-09-09T12:00:00.000Z'));
  assert.deepEqual(first.saved, [{ content: { schemaVersion: 1, targetId: 42, since: '2026-09-10T11:00:00.000Z', processed: [101] } }]);

  const replay = fixture({ runs: [run(101)], cursor: first.saved[0]!.content });
  assert.deepEqual(await pollReceipts(replay.github, replay.controller, target(), template, now), []);
  assert.deepEqual(replay.ticks, []);
  assert.equal(replay.requests.some(request => /artifacts|contents\/\.github|compare/.test(request)), false);
  assert.deepEqual(replay.saved, []);
});

test('forged, re-run, misattributed, or malformed receipts never start work', async () => {
  const otherCallee = [{ path: `owner/control/${receiptWorkflow}@${'9'.repeat(40)}`, sha: '9'.repeat(40) }];
  const runs = [
    run(201, { event: 'workflow_dispatch' }),
    run(202, { path: '.github/workflows/other.yml' }),
    run(203, { repository: { id: 43 } }),
    run(204, { run_attempt: 2 }),
    run(205, { created_at: '2026-09-10T10:00:00Z' }),
    run(206, { conclusion: 'failure' }),
    run(207, { triggering_actor: { login: 'someone-else' } }),
    run(208, { actor: null }),
    run(209, { referenced_workflows: otherCallee }),
    run(210, { referenced_workflows: [...run(0).referenced_workflows, ...otherCallee] }),
    run(211, { referenced_workflows: [{ path: `evil/control/${receiptWorkflow}@${receiptRef}`, sha: receiptRef }] }),
    run(212, { head_sha: forgedSha }),
    run(213), run(214), run(215), run(216), run(217), run(218), run(219), run(220),
    run(221, { updated_at: '2026-09-10T11:00:00Z' }),
    run(222, { conclusion: 'skipped' }),
  ];
  const context = fixture({ runs, artifacts: {
    213: [artifact(213), artifact(1213)],
    214: [artifact(214, { size_in_bytes: 1_000_001 })],
    215: [artifact(215, { expired: true })],
    221: [],
  }, archives: {
    216: archive(receipt({ repository: { id: 43, fullName: 'octo/web' } })),
    217: archive(receipt({ label: 'other' })),
    218: archive(receipt({ sender: { login: 'maintainer', type: 'Bot' } })),
    219: archive(receipt({ sender: { login: 'someone-else', type: 'User' } })),
    220: zipSync({ 'receipt.json': strToU8('not json') }),
  } });
  const outcomes = await pollReceipts(context.github, context.controller, target({ activatedAt: '2026-09-10T10:30:00Z' }), template, now);
  assert.deepEqual(context.ticks, []);
  assert.deepEqual(outcomes.map(outcome => outcome.outcome), [...Array(runs.length - 1).fill('rejected'), 'ignored']);
  assert.deepEqual(outcomes.map(outcome => outcome.reason), [
    'not an issues-event intake run of this target',
    'not an issues-event intake run of this target',
    'not an issues-event intake run of this target',
    're-run attempts are not receipts',
    'the run predates target activation',
    'the run concluded failure',
    'the triggering actor differs from the event actor',
    'the triggering actor differs from the event actor',
    'the run did not call the pinned receipt workflow',
    'the run did not call the pinned receipt workflow',
    'the run did not call the pinned receipt workflow',
    'the caller workflow differs from the rendered template',
    'duplicate, expired, or oversized receipt artifact',
    'duplicate, expired, or oversized receipt artifact',
    'duplicate, expired, or oversized receipt artifact',
    'the receipt is not an intake-label event for this target',
    'the receipt is not an intake-label event for this target',
    'the receipt sender is not the human who triggered the run',
    'the receipt sender is not the human who triggered the run',
    'the receipt artifact is malformed',
    'the run produced no receipt artifact',
    'the event did not carry the intake label',
  ]);
  // Rejections are final, so a later permission grant cannot revive a receipt that was refused.
  assert.deepEqual(context.saved[0]!.content.processed, runs.filter(item => item.id !== 205).map(item => item.id));
  // The caller template is fetched once per commit rather than once per receipt.
  assert.equal(context.requests.filter(request => request.includes(`contents/${intakeWorkflow}`)).length, 2);
});

test('incomplete receipts and failed ticks hold the scan window for a retry', async () => {
  const context = fixture({ runs: [
    run(301, { status: 'in_progress', conclusion: null, created_at: '2026-09-10T11:40:00Z' }),
    run(302, { created_at: '2026-09-10T11:50:00Z', updated_at: '2026-09-10T11:55:00Z' }),
    run(303, { created_at: '2026-09-10T10:20:00Z' }),
    run(304, { created_at: '2026-09-10T11:45:00Z' }),
  ], artifacts: { 302: [] }, archives: { 303: archive(receipt({ issue: { number: 9, title: 'Feature', body: '', author: 'requester' } })) } });
  context.failing.add(9);
  const outcomes = await pollReceipts(context.github, context.controller, target(), template, now);
  assert.deepEqual(outcomes, [
    { runId: 301, outcome: 'deferred', reason: 'the receipt run has not completed' },
    { runId: 302, outcome: 'deferred', reason: 'the receipt artifact is not available yet' },
    { runId: 303, issue: 9, outcome: 'failed', reason: 'transient platform failure' },
    { runId: 304, issue: 7, outcome: 'accepted', reason: 'authenticated intake receipt' },
  ]);
  assert.deepEqual(context.saved, [{ content: { schemaVersion: 1, targetId: 42, since: '2026-09-10T10:20:00.000Z', processed: [304] } }]);

  const retry = fixture({ runs: [run(303, { created_at: '2026-09-10T10:20:00Z' }), run(304, { created_at: '2026-09-10T11:45:00Z' })],
    cursor: context.saved[0]!.content });
  await pollReceipts(retry.github, retry.controller, target(), template, now);
  assert.deepEqual(retry.ticks.map(item => item.number), [7]);
  assert.ok(retry.requests.includes('created >=2026-09-10T10:20:00.000Z'));
  // Run 303 now precedes the window start, so it is never listed again and need not be remembered.
  assert.deepEqual(retry.saved, [{ content: { schemaVersion: 1, targetId: 42, since: '2026-09-10T11:00:00.000Z',
    processed: [304] }, sha: 'v1' }]);
});

test('each reconciliation inspects a bounded number of receipts', async () => {
  const runs = Array.from({ length: maxInspectedRuns + 2 }, (_, index) => run(400 + index, { head_sha: forgedSha }));
  const context = fixture({ runs });
  const outcomes = await pollReceipts(context.github, context.controller, target(), template, now);
  assert.equal(outcomes.filter(outcome => outcome.outcome === 'rejected').length, maxInspectedRuns);
  assert.deepEqual(outcomes.slice(-2).map(outcome => outcome.reason), Array(2).fill('the receipt budget for this reconciliation is spent'));
  assert.equal(context.saved[0]!.content.since, '2026-09-10T11:00:00.000Z');
  assert.equal((context.saved[0]!.content.processed as number[]).length, maxInspectedRuns);
});

test('a receipt pin outside the control default branch fails closed', async () => {
  for (const compare of ['diverged', 'behind', 404] as const) {
    const context = fixture({ runs: [run(501)], compare });
    await assert.rejects(pollReceipts(context.github, context.controller, target(), template, now), /not on the control default branch main/);
    assert.deepEqual(context.ticks, []);
    assert.deepEqual(context.saved, []);
  }
  const identical = fixture({ runs: [run(502)], compare: 'identical' });
  await pollReceipts(identical.github, identical.controller, target(), template, now);
  assert.deepEqual(identical.ticks.map(item => item.number), [7]);
});

test('the intake cursor is bound to its target, written by compare-and-swap, and quiet when idle', async () => {
  const foreign = fixture({ runs: [], cursor: { schemaVersion: 1, targetId: 43, since: '2026-09-10T11:00:00Z', processed: [] } });
  await assert.rejects(pollReceipts(foreign.github, foreign.controller, target(), template, now), /another target/);
  const mismatched = fixture({ runs: [], boundTo: 43 });
  await assert.rejects(pollReceipts(mismatched.github, mismatched.controller, target(), template, now), /bound to this target/);
  const disabled = fixture({ runs: [run(601)] });
  assert.deepEqual(await pollReceipts(disabled.github, disabled.controller, target({ enabled: false }), template, now), []);
  assert.deepEqual(disabled.requests, []);

  const idle = fixture({ runs: [], cursor: { schemaVersion: 1, targetId: 42, since: '2026-09-10T10:30:00.000Z', processed: [] } });
  await pollReceipts(idle.github, idle.controller, target(), template, now);
  assert.deepEqual(idle.saved, []);
  const stale = fixture({ runs: [], cursor: { schemaVersion: 1, targetId: 42, since: '2026-09-10T09:00:00.000Z', processed: [] } });
  await pollReceipts(stale.github, stale.controller, target(), template, now);
  assert.deepEqual(stale.saved, [{ content: { schemaVersion: 1, targetId: 42, since: '2026-09-10T11:00:00.000Z', processed: [] }, sha: 'v1' }]);
});
