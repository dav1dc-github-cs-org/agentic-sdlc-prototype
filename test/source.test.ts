import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { policySchema } from '../src/contracts.ts';
import { approvePlan, makePlan } from '../src/domain.ts';
import { createLifecycle, startJob, type Lifecycle } from '../src/lifecycle.ts';
import { beginAmendment, decideAmendment } from '../src/recovery.ts';
import { bundleFile, createBundle, manifestFile, materialize, readManifest, sourceCommits, sourceDirectory, verifyManifest,
  workerTarget, type Manifest } from '../src/source.ts';
import { intakeWorkflow } from '../src/targets.ts';
import { prepare, source } from '../src/worker.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const target = { id: 42, repository: 'octo/app' };
const isolated = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...process.env, ...isolated } }).trim();
}

function commit(directory: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  git(directory, 'add', '-A');
  git(directory, 'commit', '--quiet', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}

function origin(root: string) {
  const directory = join(root, 'origin');
  mkdirSync(directory);
  git(directory, 'init', '--quiet', '-b', 'main');
  const base = commit(directory, { 'README.md': 'base\n', 'test/existing.test.ts': 'test\n' }, 'base');
  const sourceSha = commit(directory, { 'src/feature.ts': 'export const feature = 1;\n' }, 'feature');
  git(directory, 'checkout', '--quiet', '-b', 'probe');
  const scan = commit(directory, { 'probe.txt': 'probe\n' }, 'probe');
  return { directory, commits: { source: sourceSha, base, scan } };
}

function manifest(commits: Manifest['commits'], bundle: Manifest['bundle'], overrides: Partial<Manifest> = {}): Manifest {
  return { schemaVersion: 1, target, issue: 123, job: '123-1', controlSha: 'c'.repeat(40), commits, bundle,
    baselineTests: ['test/existing.test.ts'], ...overrides };
}

test('a target bundle round-trips into an offline checkout at exactly the registered commits', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-source-')));
  try {
    const { directory, commits } = origin(root);
    const artifact = join(root, 'artifact');
    mkdirSync(artifact);
    const bundle = createBundle({ remote: directory, commits, output: join(artifact, bundleFile), protocol: 'file' });
    assert.match(bundle.sha256, /^[a-f0-9]{64}$/);
    writeFileSync(join(artifact, manifestFile), JSON.stringify(manifest(commits, bundle)));
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, 'source'), { recursive: true });
    writeFileSync(join(workspace, 'source/stale.txt'), 'replaced');
    materialize({ directory: artifact, destination: 'source', sha: commits.source, workspace });
    assert.equal(git(join(workspace, 'source'), 'rev-parse', 'HEAD'), commits.source);
    assert.equal(readFileSync(join(workspace, 'source/src/feature.ts'), 'utf8'), 'export const feature = 1;\n');
    assert.equal(existsSync(join(workspace, 'source/stale.txt')), false);
    assert.equal(existsSync(join(workspace, 'source/probe.txt')), false);
    // gh-aw rewrites origin after checkout, so one must exist; the bundle keeps it offline.
    assert.equal(git(join(workspace, 'source'), 'remote', 'get-url', 'origin'), join(artifact, bundleFile));
    // Full history is retained so agents can diff against the base.
    assert.equal(git(join(workspace, 'source'), 'merge-base', commits.base, commits.source), commits.base);
    materialize({ directory: artifact, destination: 'baseline', sha: commits.base, workspace });
    assert.equal(existsSync(join(workspace, 'baseline/src/feature.ts')), false);
    materialize({ directory: artifact, destination: 'scan', sha: commits.scan, workspace });
    assert.equal(readFileSync(join(workspace, 'scan/probe.txt'), 'utf8'), 'probe\n');

    const result = spawnSync(process.execPath, [resolve('src/worker.ts'), 'materialize', 'cli', commits.source], {
      cwd: workspace, encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: workspace, SDLC_SOURCE_DIR: artifact },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(join(workspace, 'cli'), 'rev-parse', 'HEAD'), commits.source);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('materialization refuses unregistered commits, tampered bundles, and unsafe destinations', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-source-reject-')));
  try {
    const { directory, commits } = origin(root);
    const artifact = join(root, 'artifact');
    mkdirSync(artifact);
    const output = join(artifact, bundleFile);
    const bundle = createBundle({ remote: directory, commits, output, protocol: 'file' });
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const write = (value: Manifest) => writeFileSync(join(artifact, manifestFile), JSON.stringify(value));
    const attempt = (sha: string, destination = 'source') => materialize({ directory: artifact, destination, sha, workspace });
    write(manifest(commits, bundle));
    assert.throws(() => attempt('f'.repeat(40)), /not part of the registered source bundle/);
    assert.throws(() => attempt('main'));
    for (const destination of ['../escape', 'Source', '.git', '', 'a/b', 'x'.repeat(32)]) {
      assert.throws(() => attempt(commits.source, destination), /Unsafe materialization destination/);
    }
    assert.equal(existsSync(join(root, 'escape')), false);
    write(manifest(commits, { ...bundle, bytes: bundle.bytes + 1 }));
    assert.throws(() => attempt(commits.source), /size does not match/);
    write(manifest(commits, { ...bundle, sha256: 'f'.repeat(64) }));
    assert.throws(() => attempt(commits.source), /digest does not match/);
    write(manifest(commits, null));
    assert.throws(() => attempt(commits.source), /carries no source bundle/);
    write({ ...manifest(commits, bundle), extra: true } as Manifest);
    assert.throws(() => attempt(commits.source));
    rmSync(join(artifact, manifestFile));
    writeFileSync(join(root, 'elsewhere.json'), JSON.stringify(manifest(commits, bundle)));
    symlinkSync(join(root, 'elsewhere.json'), join(artifact, manifestFile));
    assert.throws(() => readManifest(artifact), /ELOOP|symbolic link/);
    assert.equal(existsSync(join(workspace, 'source')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bundles pass the Reader token only as a scoped header and reject oversized or foreign sources', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-source-token-')));
  const path = process.env.PATH;
  try {
    const { directory, commits } = origin(root);
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'git.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nenv | grep '^GIT_CONFIG_VALUE' >> '${log}.env'\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${path}`;
    const output = join(root, bundleFile);
    createBundle({ remote: directory, token: 'reader-secret', commits, output, protocol: 'file' });
    const encoded = Buffer.from('x-access-token:reader-secret').toString('base64');
    const argv = readFileSync(log, 'utf8');
    assert.doesNotMatch(argv, /reader-secret/);
    assert.equal(argv.includes(encoded), false);
    assert.match(readFileSync(`${log}.env`, 'utf8'), new RegExp(`AUTHORIZATION: basic ${encoded}`));
    assert.match(readFileSync(`${log}.env`, 'utf8'), /GIT_CONFIG_VALUE_\d+=never/);
    process.env.PATH = path;

    assert.throws(() => createBundle({ remote: directory, commits, output, protocol: 'file', maxBytes: 1 }), /exceeds the source bundle limit/);
    assert.equal(existsSync(output), false);
    assert.throws(() => createBundle({ remote: directory, commits: { ...commits, scan: 'f'.repeat(40) }, output, protocol: 'file' }));
    for (const remote of [directory, 'https://example.com/octo/app.git', 'https://github.com/octo/app', 'ssh://github.com/octo/app.git']) {
      assert.throws(() => createBundle({ remote, commits, output }), /GitHub repository URL/);
    }
  } finally {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifests bind to one target job and carry only sorted baseline test paths', () => {
  const commits = { source: 'a'.repeat(40), base: 'b'.repeat(40), scan: 'a'.repeat(40) };
  const expected = { target, issue: 123, job: '123-1', controlSha: 'c'.repeat(40), commits };
  const valid = manifest(commits, null, { baselineTests: ['test/a.test.ts', 'test/b.test.ts'] });
  assert.deepEqual(verifyManifest(valid, expected, policy), ['test/a.test.ts', 'test/b.test.ts']);
  assert.deepEqual(verifyManifest({ ...valid, target: { id: 42, repository: 'Octo/App' } }, expected, policy).length, 2);
  for (const change of [{ target: { id: 43, repository: 'octo/app' } }, { target: { id: 42, repository: 'octo/web' } },
    { issue: 124 }, { job: '123-2' }, { controlSha: 'd'.repeat(40) }, { commits: { ...commits, source: 'e'.repeat(40) } },
    { commits: { ...commits, base: 'e'.repeat(40) } }, { commits: { ...commits, scan: 'e'.repeat(40) } }]) {
    assert.throws(() => verifyManifest({ ...valid, ...change }, expected, policy), /not bound to this registered job/);
  }
  for (const baselineTests of [['test/b.test.ts', 'test/a.test.ts'], ['test/a.test.ts', 'test/a.test.ts'], ['src/a.ts']]) {
    assert.throws(() => verifyManifest({ ...valid, baselineTests }, expected, policy), /baseline tests are invalid/);
  }
});

test('the source commit set follows the registered job and its preflight probe', () => {
  const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
  assert.throws(() => sourceCommits(state), /No registered job/);
  const job = startJob(state, 'research', '2026-09-08T12:00:00Z');
  assert.deepEqual(sourceCommits(state), { source: job.inputSha, base: state.baseSha, scan: job.inputSha });
  job.probeSha = 'f'.repeat(40);
  assert.equal(sourceCommits(state).scan, 'f'.repeat(40));
});

function writeRegistry(root: string, targets: unknown[]): string {
  const path = join(root, 'targets.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, targets }));
  return path;
}

const registered = (overrides: Record<string, unknown> = {}) => ({ id: 42, repository: 'octo/app', enabled: true,
  activatedAt: '2026-09-01T00:00:00Z', intake: { workflow: intakeWorkflow, receiptRef: 'd'.repeat(40) }, ...overrides });

test('workers serve only the enabled registered target named by the dispatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-worker-target-'));
  try {
    const path = writeRegistry(root, [registered(), registered({ id: 43, repository: 'octo/web', enabled: false })]);
    const env = { GITHUB_REPOSITORY: 'owner/control', GITHUB_REPOSITORY_ID: '1',
      SDLC_TARGET_ID: '42', SDLC_TARGET_OWNER: 'Octo', SDLC_TARGET_NAME: 'App' };
    assert.equal(workerTarget({ GITHUB_REPOSITORY: 'owner/control' }, path), undefined);
    assert.deepEqual(workerTarget(env, path), target);
    for (const change of [{ SDLC_TARGET_ID: '43', SDLC_TARGET_NAME: 'web' }, { SDLC_TARGET_ID: '44' }, { SDLC_TARGET_NAME: 'web' }]) {
      assert.throws(() => workerTarget({ ...env, ...change }, path), /not an enabled registered target/);
    }
    for (const change of [{ SDLC_TARGET_ID: '' }, { SDLC_TARGET_ID: '0' }, { SDLC_TARGET_ID: '4x' }]) {
      assert.throws(() => workerTarget({ ...env, ...change }, path), /Invalid target ID/);
    }
    assert.throws(() => workerTarget({ ...env, SDLC_TARGET_OWNER: '' }, path));
    assert.throws(() => workerTarget({ ...env, GITHUB_REPOSITORY_ID: '' }, path));
    assert.throws(() => workerTarget(env, writeRegistry(root, [registered({ id: 1, repository: 'owner/control' })])), /control repository/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const controlSha = 'c'.repeat(40);

function integratingState(): Lifecycle {
  const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40), 'main', controlSha, target);
  state.plan = makePlan('Original plan', 0);
  state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
    authorized: true, actor: 'requester', commentId: 1, at: '2026-09-17T12:00:00Z' });
  const baseline = { branch: 'main', sha: 'e'.repeat(40), controlSha };
  beginAmendment(state, baseline, state.request, 'Retain source with repaired baseline', true, true);
  state.amendment!.plan = makePlan('Amended plan', 1);
  state.amendment!.status = 'awaiting_approval';
  state.phase = 'awaiting_amendment';
  decideAmendment(state, 2, 'maintainer', 2, '2026-09-17T12:01:00Z', true, baseline, state.request, true);
  startJob(state, 'integrate', '2026-09-17T12:02:00Z');
  return state;
}

interface Fixture {
  state: Lifecycle; controlVisibility?: string; targetId?: number; baseline?: string; requests: string[];
}

function mockFetch(fixture: Fixture): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const auth = request.headers.get('authorization');
    fixture.requests.push(`${auth} ${request.method} ${path}`);
    if (request.method !== 'GET') throw new Error('Workers never write');
    if (path.startsWith('/repos/octo/app')) {
      // The target is reachable only with the Reader token, never the control-scoped workflow token.
      if (auth !== 'token reader') return new Response('{"message":"Not Found"}', { status: 404 });
      if (path === '/repos/octo/app') return Response.json({ id: fixture.targetId ?? 42, full_name: 'octo/app', default_branch: 'main', visibility: 'private' });
      if (path === '/repos/octo/app/git/ref/heads/main') return Response.json({ object: { sha: fixture.baseline ?? 'e'.repeat(40) } });
      if (path.startsWith('/repos/octo/app/git/commits/')) return Response.json({ tree: { sha: 'd'.repeat(40) } });
      if (path.startsWith('/repos/octo/app/git/trees/')) return Response.json({ truncated: false, tree: [
        { path: 'test/existing.test.ts', mode: '100644', type: 'blob', sha: 'f'.repeat(40) },
        { path: 'src/app.ts', mode: '100644', type: 'blob', sha: 'f'.repeat(40) }] });
    }
    if (path.startsWith('/repos/owner/control')) {
      if (auth !== 'token control') throw new Error('Control requests use the workflow token');
      if (path === '/repos/owner/control') return Response.json({ id: 1, full_name: 'owner/control', default_branch: 'main',
        visibility: fixture.controlVisibility ?? 'private' });
      if (path === '/repos/owner/control/git/ref/heads/main') return Response.json({ object: { sha: controlSha } });
      if (path === '/repos/owner/control/contents/targets/42/issues/123.json' && url.searchParams.get('ref') === policy.stateBranch) {
        const raw = JSON.stringify(fixture.state);
        return Response.json({ type: 'file', sha: 'f'.repeat(40), size: Buffer.byteLength(raw), content: Buffer.from(raw).toString('base64') });
      }
    }
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  };
}

async function withWorker<T>(env: Record<string, string>, fixture: Fixture, run: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, env);
  globalThis.fetch = mockFetch(fixture);
  try { return await run(); } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    globalThis.fetch = savedFetch;
  }
}

test('the Reader-zone source job integrates a foreign target and binds its manifest for later jobs', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-source-job-')));
  try {
    const registry = writeRegistry(root, [registered()]);
    const state = integratingState();
    const job = state.job!;
    const env = (workspace: string, overrides: Record<string, string> = {}) => ({
      GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: join(workspace, 'output.txt'), GITHUB_REPOSITORY: 'owner/control',
      GITHUB_REPOSITORY_ID: '1', GITHUB_SHA: job.controlSha, GITHUB_ACTOR: 'sdlc[bot]', SDLC_BOT_LOGIN: 'sdlc[bot]',
      GH_TOKEN: 'control', SDLC_READER_TOKEN: 'reader', SDLC_ISSUE: '123', SDLC_JOB: job.id, SDLC_SOURCE_SHA: job.inputSha,
      SDLC_CONTROL_SHA: job.controlSha, SDLC_STAGE: 'integrate', SDLC_TARGET_ID: '42', SDLC_TARGET_OWNER: 'octo',
      SDLC_TARGET_NAME: 'app', ...overrides,
    });
    const workspace = join(root, 'clean');
    mkdirSync(workspace);
    const clean: Fixture = { state, requests: [] };
    await withWorker(env(workspace), clean, () => source(registry));
    assert.match(readFileSync(join(workspace, 'output.txt'), 'utf8'), /^integration_hash=[a-f0-9]{64}\n$/);
    const written = readManifest(join(workspace, sourceDirectory));
    assert.deepEqual(written, manifest(sourceCommits(state), null, { job: job.id, controlSha: job.controlSha }));
    // Identity and exposure are proven before any control-plane state is read.
    assert.deepEqual(clean.requests.slice(0, 3), ['token reader GET /repos/octo/app', 'token control GET /repos/owner/control',
      'token control GET /repos/owner/control/contents/targets/42/issues/123.json']);

    // Target preparation reads only control-plane state and takes target facts from the verified manifest.
    const prepared: Fixture = { state, requests: [] };
    await withWorker(env(workspace, { SDLC_READER_TOKEN: '' }), prepared, () => prepare(registry));
    assert.ok(prepared.requests.every(request => request.startsWith('token control GET /repos/owner/control/contents/')));
    const context = JSON.parse(readFileSync(join(workspace, '.sdlc-context.json'), 'utf8'));
    assert.deepEqual(context.capabilities.immutableTests, ['test/existing.test.ts']);
    const tampered = { ...written, baselineTests: [] as string[], job: '123-9' };
    writeFileSync(join(workspace, sourceDirectory, manifestFile), JSON.stringify(tampered));
    await assert.rejects(withWorker(env(workspace), { state, requests: [] }, () => prepare(registry)), /not bound to this registered job/);
    rmSync(join(workspace, sourceDirectory), { recursive: true });
    await assert.rejects(withWorker(env(workspace), { state, requests: [] }, () => prepare(registry)), /ENOENT/);

    // A conflict is reported as a blocker so the trusted result job still runs.
    const moved = join(root, 'moved');
    mkdirSync(moved);
    await withWorker(env(moved), { state, baseline: 'b'.repeat(40), requests: [] }, () => source(registry));
    const output = readFileSync(join(moved, 'output.txt'), 'utf8');
    assert.doesNotMatch(output, /integration_hash/);
    const blocker = JSON.parse(output.trim().slice('blocker='.length));
    assert.equal(blocker.category, 'approval_conflict');
    assert.match(blocker.diagnostics[0].message, /baseline moved/);
    assert.ok(existsSync(join(moved, sourceDirectory, manifestFile)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the source job refuses unbound, drifted, over-exposed, or unauthenticated targets before reading state', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-source-guard-')));
  try {
    const registry = writeRegistry(root, [registered()]);
    const state = integratingState();
    const job = state.job!;
    const base = { GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: 'owner/control', GITHUB_REPOSITORY_ID: '1',
      GITHUB_SHA: job.controlSha, GITHUB_ACTOR: 'sdlc[bot]', SDLC_BOT_LOGIN: 'sdlc[bot]', GH_TOKEN: 'control',
      SDLC_READER_TOKEN: 'reader', SDLC_ISSUE: '123', SDLC_JOB: job.id, SDLC_SOURCE_SHA: job.inputSha,
      SDLC_CONTROL_SHA: job.controlSha, SDLC_STAGE: 'integrate', SDLC_TARGET_ID: '42', SDLC_TARGET_OWNER: 'octo', SDLC_TARGET_NAME: 'app' };
    for (const [env, fixture, reason] of [
      [{ SDLC_TARGET_ID: '', SDLC_TARGET_OWNER: '', SDLC_TARGET_NAME: '' }, {}, /serves only registered foreign targets/],
      [{ SDLC_READER_TOKEN: '' }, {}, /Reader token is unavailable/],
      [{ GITHUB_ACTOR: 'intruder' }, {}, /controller App identity/],
      [{ SDLC_TARGET_NAME: 'web' }, {}, /not an enabled registered target/],
      [{}, { controlVisibility: 'public' }, /public control repository cannot process a private target/],
      [{}, { targetId: 99 }, /identity changed/],
    ] as const) {
      const requests: string[] = [];
      await assert.rejects(withWorker({ ...base, ...env }, { state, requests, ...fixture }, () => source(registry)), reason);
      assert.equal(requests.some(request => request.includes('/contents/')), false);
    }
    assert.equal(existsSync(join(root, sourceDirectory)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('target check results require the Reader-zone source job and take integration evidence only from it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-target-checks-'));
  try {
    const execute = (stage: string, results: Record<string, unknown>) => {
      execFileSync(process.execPath, [resolve('src/worker.ts'), 'checks'], { cwd: directory, env: {
        ...process.env, SDLC_JOB: '123-1', SDLC_SOURCE_SHA: 'a'.repeat(40), SDLC_STAGE: stage, SDLC_TARGET_ID: '42',
        SDLC_CHECK_RESULTS: JSON.stringify(results), GITHUB_REPOSITORY: 'owner/control', GITHUB_RUN_ID: '1',
      } });
      return JSON.parse(readFileSync(join(directory, '.sdlc-output/result.json'), 'utf8'));
    };
    const ok = { result: 'success' };
    assert.equal(execute('scan', { source: ok, prepare: ok, codeql: ok, security: ok }).outcome, 'pass');
    assert.match(execute('scan', { source: { result: 'skipped' }, prepare: ok, codeql: ok, security: ok }).summary, /source/);
    assert.equal(execute('validate', { source: ok, prepare: ok, tests: ok }).outcome, 'pass');
    assert.equal(execute('validate', { prepare: ok, tests: ok }).outcome, 'changes_requested');
    const hash = 'a'.repeat(64);
    const passed = execute('integrate', { source: { result: 'success', outputs: { integration_hash: hash } }, prepare: ok });
    assert.equal(passed.outcome, 'pass');
    assert.equal(passed.integrationHash, hash);
    // A self-hosted integration job cannot vouch for a foreign target.
    assert.equal(execute('integrate', { source: ok, prepare: ok,
      integration: { result: 'success', outputs: { integration_hash: hash } } }).outcome, 'changes_requested');
    const blocker = { category: 'approval_conflict', scope: 'repository', paths: [], constraint: 'Conflict',
      diagnostics: [{ tool: 'policy', message: 'Approved integration baseline moved' }], remedies: ['Amend'] };
    const blocked = execute('integrate', { source: { result: 'success', outputs: { blocker: JSON.stringify(blocker) } }, prepare: ok });
    assert.equal(blocked.outcome, 'changes_requested');
    assert.deepEqual(blocked.blocker, blocker);
    assert.match(blocked.summary, /integration/);
    assert.match(execute('integrate', { source: ok, prepare: ok }).summary, /integration_receipt/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
