import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Octokit } from '@octokit/rest';
import { strToU8, zipSync } from 'fflate';
import { policySchema } from '../src/contracts.ts';
import { reconcile, type ReconcileOptions } from '../src/reconcile.ts';
import { receiptArtifact, renderIntakeWorkflow } from '../src/receipts.ts';
import { intakeTemplate, intakeWorkflow, receiptWorkflow, runTitle, type Target } from '../src/targets.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const controlSha = 'c'.repeat(40);
const receiptRef = 'd'.repeat(40);
const template = readFileSync(intakeTemplate, 'utf8');
const now = new Date('2026-09-10T12:00:00Z');

const entry = (id: number, repository: string, enabled = true): Target =>
  ({ id, repository, enabled, activatedAt: '2026-09-01T00:00:00Z', intake: { workflow: intakeWorkflow, receiptRef } });
const registry = { schemaVersion: 1 as const, targets: [entry(42, 'octo/app'), entry(43, 'octo/web', false), entry(44, 'octo/api')] };

type Handler = (method: string, path: string, query: URLSearchParams) => unknown;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function api(scope: string, requests: string[], handler: Handler) {
  return new Octokit({ log: quiet, request: { fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? 'GET';
    const path = decodeURIComponent(url.pathname);
    requests.push(`${scope} ${method} ${path}`);
    const result = handler(method, path, url.searchParams);
    if (result === undefined) throw new Error(`Unexpected ${scope} request: ${method} ${path}`);
    const response = result instanceof Response ? result :
      new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  } } });
}

const status = (code: number) => new Response(JSON.stringify({ message: `HTTP ${code}` }), { status: code });
const issue = (number: number, state = 'open') =>
  ({ number, title: 'Feature', body: '', state, user: { login: 'requester' }, labels: [{ name: policy.label }] });

interface Fixture {
  selfActive?: number[];
  targetActive?: Record<number, number[]>;
  runs?: Record<number, unknown[] | Response>;
  issueFailures?: string[];
  brokenTargets?: number[];
  controlVisibility?: string;
  targetIdentity?: Record<number, Record<string, unknown>>;
}

function fixture(options: Fixture = {}) {
  const requests: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const minted: number[] = [];
  const listing = (numbers: number[]) => numbers.length ? numbers.map(number => ({ name: `${number}.json`, type: 'file' })) : status(404);
  const control = api('control', requests, (method, path) => {
    if (path === '/repos/owner/control') {
      return { id: 1, full_name: 'owner/control', default_branch: 'main', visibility: options.controlVisibility ?? 'private' };
    }
    if (path === '/repos/owner/control/git/ref/heads/main') return { object: { sha: controlSha } };
    if (path === `/repos/owner/control/git/ref/heads/${policy.stateBranch}`) return { object: { sha: 'state' } };
    if (path === `/repos/owner/control/compare/${receiptRef}...${controlSha}`) return { status: 'ahead' };
    if (path === '/repos/owner/control/contents/issues') return listing(options.selfActive ?? []);
    if (path === '/repos/owner/control/issues') return [];
    const active = /^\/repos\/owner\/control\/contents\/targets\/(\d+)\/issues$/.exec(path);
    if (active) return listing(options.targetActive?.[Number(active[1])] ?? []);
    if (/^\/repos\/owner\/control\/contents\/(targets\/\d+\/)?issues\/\d+\.json$/.test(path)) return status(404);
    if (/^\/repos\/owner\/control\/contents\/targets\/\d+\/intake\.json$/.test(path)) {
      return method === 'PUT' ? { content: { sha: 'cursor' } } : status(404);
    }
    const self = /^\/repos\/owner\/control\/issues\/(\d+)$/.exec(path);
    if (self) return issue(Number(self[1]));
    return undefined;
  });
  const targetApi = async (target: Target) => {
    minted.push(target.id);
    if (options.brokenTargets?.includes(target.id)) throw new Error('The target installation did not grant contents: write');
    const repository = target.repository;
    return api(repository, requests, (_method, path) => {
      if (path === `/repos/${repository}`) {
        return { id: target.id, full_name: repository, default_branch: 'main', visibility: 'private', ...options.targetIdentity?.[target.id] };
      }
      const found = new RegExp(`^/repos/${repository}/issues/(\\d+)$`).exec(path);
      if (found) {
        if (options.issueFailures?.includes(`${repository}#${found[1]}`)) return status(502);
        return issue(Number(found[1]), 'closed');
      }
      if (path === `/repos/${repository}/actions/workflows/sdlc-intake.yml/runs`) {
        const runs = options.runs?.[target.id] ?? [];
        return runs instanceof Response ? runs : { total_count: runs.length, workflow_runs: runs };
      }
      if (path === `/repos/${repository}/contents/${intakeWorkflow}`) {
        const content = renderIntakeWorkflow(template, 'owner/control', receiptRef, policy.label);
        return { type: 'file', sha: 'blob', size: content.length, content: Buffer.from(content).toString('base64') };
      }
      const artifacts = new RegExp(`^/repos/${repository}/actions/runs/(\\d+)/artifacts$`).exec(path);
      if (artifacts) return { total_count: 1, artifacts: [{ id: Number(artifacts[1]), name: receiptArtifact, expired: false, size_in_bytes: 400 }] };
      const download = new RegExp(`^/repos/${repository}/actions/artifacts/(\\d+)/zip$`).exec(path);
      if (download) {
        const number = Number(download[1]) % 100;
        const receipt = { schemaVersion: 1, action: 'labeled', label: policy.label, repository: { id: target.id, fullName: repository },
          issue: { number, title: 'Feature', body: '', author: 'requester' }, sender: { login: 'maintainer', type: 'User' } };
        return new Response(Buffer.from(zipSync({ 'receipt.json': strToU8(JSON.stringify(receipt)) })),
          { status: 200, headers: { 'content-type': 'application/zip' } });
      }
      return undefined;
    });
  };
  const run = (options: Partial<ReconcileOptions>) => reconcile({
    repository: 'owner/control', sha: controlSha, policy, botLogin: 'sdlc[bot]', controlApi: control, registry,
    event: {}, targetApi, template: () => template, clock: () => now,
    log: line => logs.push(line), error: line => errors.push(line), ...options,
  });
  return { run, requests, logs, errors, minted };
}

const receiptRun = (id: number, overrides: Record<string, unknown> = {}) => ({
  id, event: 'issues', path: intakeWorkflow, status: 'completed', conclusion: 'success', run_attempt: 1,
  created_at: '2026-09-10T11:30:00Z', updated_at: '2026-09-10T11:31:00Z', head_sha: 'e'.repeat(40),
  repository: { id: 42 }, actor: { login: 'maintainer' }, triggering_actor: { login: 'maintainer' },
  referenced_workflows: [{ path: `owner/control/${receiptWorkflow}@${receiptRef}`, sha: receiptRef }], ...overrides,
});

test('a completed target worker reconciles only its own issue in its own repository', async () => {
  const context = fixture({ targetActive: { 42: [5, 6] } });
  const event = { workflow_run: { display_title: runTitle('5-3', { id: 42, repository: 'octo/app' }) } };
  assert.equal(await context.run({ event }), true);
  assert.deepEqual(context.logs, ['Reconciled octo/app#5']);
  assert.deepEqual(context.minted, [42]);
  assert.equal(context.requests.some(request => /actions\/workflows|control GET \/repos\/owner\/control\/issues/.test(request)), false);
  assert.ok(context.requests.includes('control GET /repos/owner/control/contents/targets/42/issues/5.json'));
});

test('unregistered or disabled targets are never minted a token', async () => {
  for (const id of [43, 99]) {
    const worker = fixture();
    const event = { workflow_run: { display_title: runTitle('5-3', { id, repository: 'octo/other' }) } };
    // A worker that finishes after its target is disabled is not a controller failure.
    assert.equal(await worker.run({ event }), true);
    assert.deepEqual(worker.errors, [`Target ${id} is not an enabled registered target`]);
    assert.deepEqual(worker.minted, []);
    // An operator who asks for one has made a mistake worth surfacing.
    const manual = fixture();
    assert.equal(await manual.run({ target: String(id), issue: '5' }), false);
    assert.deepEqual(manual.minted, []);
  }
});

test('a scheduled reconciliation covers the control repository and each enabled target in isolation', async () => {
  const context = fixture({ selfActive: [3], targetActive: { 42: [5] }, brokenTargets: [44] });
  assert.equal(await context.run({}), false);
  assert.deepEqual(context.minted, [42, 44]);
  assert.deepEqual(context.logs, ['Reconciled issue #3', 'Reconciled octo/app#5']);
  assert.deepEqual(context.errors, ['octo/api: The target installation did not grant contents: write']);
  assert.ok(context.requests.includes('octo/app GET /repos/octo/app/actions/workflows/sdlc-intake.yml/runs'));
  // Target state is namespaced, so target issue 5 never reads or writes control issue 5.
  assert.equal(context.requests.some(request => request.includes('/repos/owner/control/issues/5')), false);
});

test('a scheduled reconciliation succeeds when every target is healthy', async () => {
  const context = fixture({ selfActive: [3], targetActive: { 42: [5] } });
  assert.equal(await context.run({ registry: { schemaVersion: 1, targets: [entry(42, 'octo/app')] } }), true);
  assert.deepEqual(context.errors, []);
});

test('manual dispatch selects a target and optionally one of its issues', async () => {
  const single = fixture({ targetActive: { 42: [6] } });
  assert.equal(await single.run({ target: '42', issue: '5' }), true);
  assert.deepEqual(single.logs, ['Reconciled octo/app#5']);
  assert.equal(single.requests.some(request => request.includes('actions/workflows')), false);

  const all = fixture({ targetActive: { 42: [6] } });
  assert.equal(await all.run({ target: '42' }), true);
  assert.deepEqual(all.logs, ['Reconciled octo/app#6']);
  assert.ok(all.requests.includes('octo/app GET /repos/octo/app/actions/workflows/sdlc-intake.yml/runs'));
  // A target selection never falls back to the control repository's issues.
  assert.equal(all.requests.some(request => request.includes('control GET /repos/owner/control/contents/issues')), false);
});

test('accepted receipts are not ticked twice and failed receipts fail the reconciliation', async () => {
  const context = fixture({
    targetActive: { 42: [7, 8] }, issueFailures: ['octo/app#8'],
    runs: { 42: [receiptRun(907), receiptRun(908), receiptRun(909, { status: 'queued', conclusion: null })] },
  });
  assert.equal(await context.run({ target: '42' }), false);
  assert.equal(context.requests.filter(request => request === 'octo/app GET /repos/octo/app/issues/7').length, 1);
  assert.deepEqual(context.logs, ['octo/app receipt 907: accepted (authenticated intake receipt)',
    'octo/app receipt 909: deferred (the receipt run has not completed)']);
  assert.equal(context.errors.length, 2);
  assert.match(context.errors[0]!, /^octo\/app receipt 908: /);
  assert.match(context.errors[1]!, /^octo\/app#8: /);
});

test('a receipt scan failure still reconciles in-flight target lifecycles', async () => {
  const context = fixture({ targetActive: { 42: [5] }, runs: { 42: status(500) } });
  assert.equal(await context.run({ target: '42' }), false);
  assert.deepEqual(context.logs, ['Reconciled octo/app#5']);
  assert.equal(context.errors.length, 1);
  assert.match(context.errors[0]!, /^octo\/app intake: /);
});

test('selections are validated and a stale controller refuses to act', async () => {
  for (const target of ['abc', '0', '-1', '1.5', '99999999999999999']) {
    await assert.rejects(fixture().run({ target }), /Invalid target ID/);
  }
  await assert.rejects(fixture().run({ issue: 'x' }), /Invalid issue number/);
  await assert.rejects(fixture().run({ target: '42', issue: '0' }), /Invalid issue number/);
  const stale = fixture();
  await assert.rejects(stale.run({ sha: 'a'.repeat(40) }), /Controller revision is stale/);
  assert.deepEqual(stale.minted, []);
  const comment = fixture();
  assert.equal(await comment.run({ event: { issue: { number: 4, pull_request: {} } } }), true);
  assert.deepEqual(comment.logs, []);
});

test('a control-repository event reconciles only the selected control issue', async () => {
  const context = fixture({ selfActive: [3], targetActive: { 42: [5] } });
  assert.equal(await context.run({ event: { issue: { number: 3 } } }), true);
  assert.deepEqual(context.logs, ['Reconciled issue #3']);
  assert.deepEqual(context.minted, []);
});

test('a target whose identity drifted or whose content would widen its audience is never read', async () => {
  for (const [options, reason] of [
    [{ controlVisibility: 'public' }, /public control repository cannot process a private target/],
    [{ targetIdentity: { 42: { id: 99 } } }, /identity changed/],
    [{ targetIdentity: { 42: { full_name: 'octo/renamed' } } }, /identity changed/],
  ] as const) {
    const context = fixture({ targetActive: { 42: [5] }, ...options });
    assert.equal(await context.run({ target: '42' }), false);
    assert.equal(context.errors.length, 1);
    assert.match(context.errors[0]!, reason);
    assert.deepEqual(context.logs, []);
    // Neither receipts nor issue bodies are read, so nothing from the target reaches control-plane state.
    assert.equal(context.requests.some(request => /actions\/workflows|\/issues\/5$|contents\/targets\/42\/issues/.test(request)), false);
  }
});
