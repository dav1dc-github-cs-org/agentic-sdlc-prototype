import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Octokit } from '@octokit/rest';
import { GitHub } from '../src/github.ts';
import { lifecycleSchema, migrateLifecycle, policySchema } from '../src/contracts.ts';
import { createLifecycle, startJob, type Lifecycle } from '../src/lifecycle.ts';
import { approvePlan, makePlan } from '../src/domain.ts';
import {
  intakeWorkflow, loadRegistry, parseRegistry, parseRunTitle, receiptWorkflow, registryPath, runTitle, targetBindingChanged,
} from '../src/targets.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const baseSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const controlSha = 'c'.repeat(40);
const control = { id: 1, repository: 'owner/control' };
const target = { id: 42, repository: 'octo/app' };

function entry(id: number, repository: string, enabled = true) {
  return { id, repository, enabled, activatedAt: '2026-09-01T00:00:00Z',
    intake: { workflow: intakeWorkflow, receiptRef: 'd'.repeat(40) } };
}

function registry(...targets: ReturnType<typeof entry>[]) {
  return { schemaVersion: 1, targets };
}

type Handler = (method: string, path: string, body: Record<string, unknown>, query: URLSearchParams) => unknown;

function api(handler: Handler) {
  return new Octokit({ request: { fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const result = handler(init?.method ?? 'GET', decodeURIComponent(url.pathname),
      init?.body ? JSON.parse(String(init.body)) : {}, url.searchParams);
    const response = result instanceof Response ? result :
      new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  } } });
}

const unexpected = (scope: string): Handler => (method, path) => { throw new Error(`Unexpected ${scope} request: ${method} ${path}`); };
const missing = () => new Response('{"message":"Not Found"}', { status: 404 });
const file = (content: unknown, sha = newSha) => ({ type: 'file', sha, size: 100,
  content: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)).toString('base64') });

function foreign(controlHandler: Handler, targetHandler: Handler = unexpected('target')) {
  return new GitHub(control.repository, policy, 'sdlc[bot]', api(controlHandler), 'auto',
    { ...target, api: api(targetHandler) });
}

function activeState(binding: typeof target | null = target) {
  const state = createLifecycle(123, 'requester', 'Feature', baseSha, 'main', controlSha, binding ?? undefined);
  state.plan = makePlan('Approved plan', 0);
  state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
    authorized: true, actor: 'requester', commentId: 1, at: '2026-09-08T12:00:00Z' });
  state.phase = 'coding';
  state.feedback = 'Implement the approved plan';
  const job = startJob(state, 'code', '2026-09-08T12:00:00Z');
  return { state, job };
}

test('the registry accepts unique foreign targets and rejects duplicates, self registration, and loose pins', () => {
  assert.equal(parseRegistry(registry(entry(42, 'octo/app'), entry(43, 'octo/web')), control).targets.length, 2);
  assert.throws(() => parseRegistry(registry(entry(42, 'octo/app'), entry(42, 'octo/web'))), /Duplicate target/);
  assert.throws(() => parseRegistry(registry(entry(42, 'octo/app'), entry(43, 'Octo/App'))), /Duplicate target/);
  assert.throws(() => parseRegistry(registry(entry(1, 'octo/app')), control), /control repository/);
  assert.throws(() => parseRegistry(registry(entry(7, 'Owner/Control')), control), /control repository/);
  const loose = entry(42, 'octo/app');
  for (const invalid of [
    { ...loose, intake: { ...loose.intake, receiptRef: 'main' } },
    { ...loose, intake: { ...loose.intake, workflow: '.github/workflows/other.yml' } },
    { ...loose, repository: 'octo' },
    { ...loose, activatedAt: 'yesterday' },
    { ...loose, extra: true },
  ]) {
    assert.throws(() => parseRegistry({ schemaVersion: 1, targets: [invalid] }));
  }
  assert.throws(() => parseRegistry({ schemaVersion: 2, targets: [] }));
});

test('the committed registry parses and a missing registry means no foreign targets', () => {
  const configured = parseRegistry(JSON.parse(readFileSync(registryPath, 'utf8')));
  assert.deepEqual(loadRegistry(), configured);
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-registry-'));
  try {
    assert.deepEqual(loadRegistry(control, join(directory, 'absent.json')), registry());
    const path = join(directory, 'targets.json');
    for (const configuration of [registry(), registry(entry(42, 'octo/app', false), entry(43, 'octo/web'))]) {
      writeFileSync(path, JSON.stringify(configuration));
      assert.deepEqual(loadRegistry(control, path), configuration);
    }
    assert.throws(() => loadRegistry(control, directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('only this target\'s binding change invalidates its trusted revision', () => {
  const before = registry(entry(42, 'octo/app'));
  assert.equal(targetBindingChanged(before, registry(entry(42, 'octo/app'), entry(43, 'octo/web')), target), false);
  assert.equal(targetBindingChanged(before, { ...before, targets: [{ ...entry(42, 'octo/app'), activatedAt: '2026-09-02T00:00:00Z' }] }, target), false);
  assert.equal(targetBindingChanged(before, registry(entry(42, 'octo/app', false)), target), true);
  assert.equal(targetBindingChanged(before, registry(entry(42, 'octo/renamed')), target), true);
  assert.equal(targetBindingChanged(before, registry(), target), true);
  assert.equal(targetBindingChanged(before, undefined, target), true);
  assert.equal(targetBindingChanged({ schemaVersion: 1 }, before, target), true);
});

test('run titles qualify foreign jobs and reject ambiguous or unsafe identities', () => {
  assert.equal(runTitle('123-4'), 'SDLC 123-4');
  assert.equal(runTitle('123-4', target), 'SDLC 42/123-4');
  assert.deepEqual(parseRunTitle('SDLC 123-4'), { issue: 123 });
  assert.deepEqual(parseRunTitle('SDLC 42/123-4'), { targetId: 42, issue: 123 });
  for (const title of ['SDLC 0-1', 'SDLC 42/0-1', 'SDLC 042/1-1', 'SDLC /1-1', 'SDLC 42/1', 'Other 1-1', 'SDLC 1-1 extra',
    'SDLC 9999999999999999-1', 'SDLC 9999999999999999/1-1']) {
    assert.equal(parseRunTitle(title), undefined, title);
  }
});

test('lifecycles record their target and the legacy schema cannot carry one', () => {
  const { state } = activeState();
  assert.deepEqual(lifecycleSchema.parse(state).target, target);
  assert.equal(state.baseSha, baseSha);
  assert.equal(state.controlSha, controlSha);
  assert.throws(() => createLifecycle(1, 'requester', 'Feature', baseSha, 'main', 'not-a-sha'));
  const legacy = { ...structuredClone(state), schemaVersion: 1 } as Record<string, unknown>;
  assert.throws(() => migrateLifecycle(legacy));
});

test('a target binding must differ from the control repository', () => {
  assert.throws(() => new GitHub(control.repository, policy, 'sdlc[bot]', api(unexpected('control')), 'auto',
    { id: 42, repository: 'OWNER/control', api: api(unexpected('target')) }), /foreign target/);
  assert.throws(() => new GitHub(control.repository, policy, 'sdlc[bot]', api(unexpected('control')), 'auto',
    { id: 0, repository: 'octo/app', api: api(unexpected('target')) }), /foreign target/);
});

test('foreign state lives under the target in the control repository and cannot be swapped across targets', async () => {
  let stored: Lifecycle = activeState().state;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const github = foreign((method, path, body) => {
    if (path === '/repos/owner/control/contents/targets/42/issues/123.json' && method === 'GET') return file(stored);
    if (path === '/repos/owner/control/contents/targets/42/issues' && method === 'GET') return [{ name: '123.json' }, { name: 'README.md' }];
    if (path === '/repos/owner/control/git/ref/heads/sdlc-state') return { object: { sha: baseSha } };
    if (path === '/repos/owner/control/contents/targets/42/issues/123.json' && method === 'PUT') {
      writes.push({ path, body });
      return { content: { sha: controlSha } };
    }
    throw new Error(`Unexpected control request: ${method} ${path}`);
  });
  const record = (await github.load(123))!;
  assert.deepEqual(record.state.target, target);
  await github.save(record);
  assert.equal(writes[0]!.body.message, 'SDLC 42/#123: coding');
  assert.equal(writes[0]!.body.branch, 'sdlc-state');
  assert.deepEqual(await github.activeIssues(), [123]);

  stored = activeState(null).state;
  await assert.rejects(github.load(123), /identity/);
  stored = activeState({ id: 43, repository: 'octo/web' }).state;
  await assert.rejects(github.load(123), /identity/);
  await assert.rejects(github.save({ state: activeState(null).state }), /identity/);
  assert.equal(writes.length, 1);

  const self = new GitHub(control.repository, policy, 'sdlc[bot]', api(() => file(activeState().state)));
  await assert.rejects(self.load(123), /identity/);
  await assert.rejects(self.save({ state: activeState().state }), /identity/);
});

test('foreign jobs dispatch to the control default branch and only match their own target-qualified runs', async () => {
  const { state, job } = activeState();
  const dispatched: { path: string; body: Record<string, unknown> }[] = [];
  const valid = { id: 3, display_title: `SDLC 42/${job.id}`, head_sha: controlSha, actor: { login: 'sdlc[bot]' },
    run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/control/actions/runs/3' };
  let runs = [valid];
  const github = foreign((method, path, body) => {
    if (path === '/repos/owner/control') return { default_branch: 'trunk' };
    if (path === '/repos/owner/control/git/ref/heads/trunk') return { object: { sha: controlSha } };
    if (path.startsWith('/repos/owner/control/actions/workflows/') && path.endsWith('/dispatches')) {
      dispatched.push({ path, body });
      return new Response(null, { status: 204 });
    }
    if (path.startsWith('/repos/owner/control/actions/workflows/') && path.endsWith('/runs')) {
      return { total_count: runs.length, workflow_runs: runs };
    }
    throw new Error(`Unexpected control request: ${method} ${path}`);
  });
  await github.dispatch(job, state);
  assert.equal(dispatched[0]!.body.ref, 'trunk');
  assert.deepEqual(dispatched[0]!.body.inputs, { issue: '123', job: job.id, source_sha: job.inputSha,
    control_sha: controlSha, stage: 'code', target_id: '42', target_owner: 'octo', target_name: 'app' });
  await assert.rejects(github.dispatch(job, activeState(null).state), /identity/);
  assert.equal(dispatched.length, 1);

  assert.equal((await github.findRun(job))?.id, 3);
  runs = [{ ...valid, display_title: `SDLC ${job.id}` }, { ...valid, id: 4, display_title: `SDLC 43/${job.id}` }];
  assert.equal(await github.findRun(job), undefined);

  const self = new GitHub(control.repository, policy, 'sdlc[bot]', api(() => ({ total_count: 1, workflow_runs: [valid] })));
  assert.equal(await self.findRun(job), undefined);
});

test('foreign targets do not start work from a label alone', async () => {
  const github = foreign(() => missing(), unexpected('target'));
  assert.deepEqual(await github.activeIssues(), []);
});

test('the foreign baseline pins the target branch and the control revision and detects identity drift', async () => {
  let identity: Record<string, unknown> = { id: 42, full_name: 'octo/app', default_branch: 'main', visibility: 'private' };
  let controlRepo: Record<string, unknown> = { default_branch: 'main', visibility: 'private' };
  const github = foreign((method, path) => {
    if (path === '/repos/owner/control') return controlRepo;
    if (path === '/repos/owner/control/git/ref/heads/main') return { object: { sha: controlSha } };
    throw new Error(`Unexpected control request: ${method} ${path}`);
  }, (method, path) => {
    if (path === '/repos/octo/app') return identity;
    if (path === '/repos/octo/app/git/ref/heads/main') return { object: { sha: baseSha } };
    throw new Error(`Unexpected target request: ${method} ${path}`);
  });
  assert.deepEqual(await github.baseline(), { branch: 'main', sha: baseSha, controlSha });
  identity = { ...identity, id: 43 };
  await assert.rejects(github.baseline(), /identity changed/);
  identity = { ...identity, id: 42, full_name: 'octo/renamed' };
  await assert.rejects(github.baseline(), /identity changed/);
  identity = { ...identity, full_name: 'octo/app' };
  // Target content is mirrored into the control plane, so a wider audience there is refused before any read.
  for (const [controlVisibility, targetVisibility, allowed] of [['public', 'public', true], ['private', 'public', true],
    ['internal', 'internal', true], ['public', 'private', false], ['public', 'internal', false], ['internal', 'private', false],
    [undefined, 'private', false], ['private', undefined, false]] as const) {
    controlRepo = { default_branch: 'main', visibility: controlVisibility };
    identity = { ...identity, visibility: targetVisibility };
    if (allowed) assert.equal((await github.baseline()).sha, baseSha);
    else await assert.rejects(github.baseline(), /control repository cannot process|visibility is unavailable/);
  }
  await assert.rejects(new GitHub(control.repository, policy, 'sdlc[bot]', api(() => ({}))).verifyTarget(), /No foreign target/);
});

test('intake-only control changes do not invalidate running lifecycles unless this binding changes', async () => {
  const compare = async (files: Record<string, unknown>[], registries: Record<string, unknown> = {}, binding = true) => {
    const handler: Handler = (method, path, _body, query) => {
      if (path === `/repos/owner/control/compare/${baseSha}...${newSha}`) return { status: 'ahead', files };
      if (path === `/repos/owner/control/contents/${registryPath}`) {
        const content = registries[query.get('ref') ?? ''];
        return content === undefined ? missing() : file(content);
      }
      throw new Error(`Unexpected control request: ${method} ${path}`);
    };
    const github = binding ? foreign(handler) : new GitHub(control.repository, policy, 'sdlc[bot]', api(handler));
    return github.trustedPathsChanged(baseSha, newSha);
  };
  const before = registry(entry(42, 'octo/app'));
  for (const binding of [false, true]) {
    assert.equal(await compare([{ filename: receiptWorkflow }], {}, binding), false);
    assert.equal(await compare([{ filename: '.github/sdlc/templates/sdlc-intake.yml' }], {}, binding), false);
    assert.equal(await compare([{ filename: receiptWorkflow }, { filename: 'src/worker.ts' }], {}, binding), true);
  }
  assert.equal(await compare([{ filename: registryPath }], {}, false), false);
  assert.equal(await compare([{ filename: registryPath }],
    { [baseSha]: before, [newSha]: registry(entry(42, 'octo/app'), entry(43, 'octo/web')) }), false);
  assert.equal(await compare([{ filename: registryPath }],
    { [baseSha]: before, [newSha]: registry(entry(42, 'octo/app', false)) }), true);
  assert.equal(await compare([{ filename: registryPath }], { [baseSha]: before, [newSha]: '{not json' }), true);
  assert.equal(await compare([{ filename: registryPath }], { [newSha]: before }), true);
});

test('foreign publication links evidence to control runs and the issue in the target', async () => {
  const { state } = activeState();
  state.phase = 'publishing';
  state.job = undefined;
  state.headSha = newSha;
  state.tasks = [{ id: 'feature', title: 'Feature', description: 'Feature', acceptance: ['Works'], dependsOn: [], completed: true }];
  state.evidence = ['scan', 'security', 'test', 'validate', 'document', 'review'].map(stage => ({
    stage: stage as 'scan' | 'security' | 'test' | 'validate' | 'review', sha: newSha,
    jobId: `123-${stage}`, runId: 7, summary: 'Verified',
  }));
  let pullBody = '';
  const github = foreign(unexpected('control'), (method, path, body) => {
    if (path.includes('/git/ref/')) return { object: { sha: newSha } };
    if (path === '/repos/octo/app/issues/123') return { title: 'Feature', body: 'Request', user: { login: 'requester' }, state: 'open', labels: [] };
    if (path === '/repos/octo/app/pulls') {
      if (method === 'GET') return [];
      pullBody = String(body.body);
      return { number: 9 };
    }
    if (path.endsWith('/reviews')) return method === 'GET' ? [] : { id: 1 };
    if (path.endsWith('/check-runs')) return method === 'GET' ? { total_count: 0, check_runs: [] } : { id: 1 };
    throw new Error(`Unexpected target request: ${method} ${path}`);
  });
  assert.equal(await github.publish(state), 9);
  assert.ok(pullBody.includes('(https://github.com/owner/control/actions/runs/7)'));
  assert.ok(!pullBody.includes('octo/app/actions/runs'));
});
