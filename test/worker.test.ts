import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { policySchema } from '../src/contracts.ts';
import { createLifecycle, startJob } from '../src/lifecycle.ts';
import { approvePlan, digest, makePlan } from '../src/domain.ts';
import { describeCapabilities } from '../src/changes.ts';
import { beginAmendment, decideAmendment, routeRecovery } from '../src/recovery.ts';
import { collectChanges, prepareContext, restoreCheckpoint, writeDraft } from '../src/worker.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));

test('workers accept only registered jobs at the exact trusted and source revisions', () => {
  const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
  const job = startJob(state, 'research', '2026-09-08T12:00:00Z');
  const input = { issue: 123, job: job.id, sourceSha: job.inputSha, controlSha: job.controlSha, stage: job.stage };
  assert.doesNotThrow(() => prepareContext(state, input));
  assert.throws(() => prepareContext(state, { ...input, controlSha: 'b'.repeat(40) }), /registered/);
  assert.throws(() => prepareContext(state, { ...input, issue: 124 }), /registered/);
  state.phase = 'paused';
  assert.throws(() => prepareContext(state, input), /registered/);
});

test('prepare entry point rejects untrusted workflow identity before creating context', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-prepare-'));
  const script = resolve('src/worker.ts');
  const preload = join(directory, 'deny-fetch.mjs');
  writeFileSync(preload, 'globalThis.fetch = async () => { throw new Error("Unexpected network request"); };\n');
  const trustedSha = 'a'.repeat(40);
  const environment = {
    ...process.env, GITHUB_WORKSPACE: directory, GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'unused',
    SDLC_BOT_LOGIN: 'sdlc[bot]', SDLC_ISSUE: '123', SDLC_JOB: '123-1', SDLC_SOURCE_SHA: trustedSha,
    SDLC_CONTROL_SHA: trustedSha, SDLC_STAGE: 'research', GITHUB_SHA: trustedSha, GITHUB_ACTOR: 'sdlc[bot]',
  };
  try {
    for (const override of [{ GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_ACTOR: 'intruder' }]) {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, 'prepare'], {
        cwd: directory, env: { ...environment, ...override }, encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /trusted workflow revision under the controller App identity/);
      // Matched on the scheme, not the API host: a hostname literal here reads as an incomplete
      // URL check to CodeQL, and ESM stack frames legitimately carry file:// paths.
      assert.doesNotMatch(result.stderr, /https:\/\//);
      assert.equal(result.error, undefined);
    }
    assert.throws(() => readFileSync(join(directory, '.sdlc-context.json')), /ENOENT/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('prepare entry point loads and validates the registered job before writing context', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-prepare-valid-'));
  const script = resolve('src/worker.ts');
  const preload = join(directory, 'mock-fetch.mjs');
  const sourceSha = 'a'.repeat(40);
  const state = createLifecycle(123, 'requester', 'Feature', sourceSha);
  state.plan = makePlan('Approved plan', 0);
  state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
    authorized: true, actor: 'requester', commentId: 1, at: '2026-09-08T12:00:00Z' });
  state.phase = 'coding';
  state.feedback = 'Repair';
  const job = startJob(state, 'code', '2026-09-08T12:00:00Z');
  writeFileSync(preload, `
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = input instanceof Request ? input.method : init?.method || 'GET';
  if (method !== 'GET') throw new Error('Unexpected method: ' + method);
  const path = decodeURIComponent(url.pathname);
  if (path.includes('/git/commits/')) return Response.json({ tree: { sha: '${'c'.repeat(40)}' } });
  if (path.includes('/git/trees/')) return Response.json({ truncated: false, tree: [
    { path: 'test/existing.test.ts', mode: '100644', type: 'blob', sha: '${'d'.repeat(40)}' }
  ] });
  if (!decodeURIComponent(url.pathname).endsWith('/repos/owner/repo/contents/issues/123.json')) throw new Error('Unexpected request: ' + url);
  if (url.searchParams.get('ref') !== 'sdlc-state') throw new Error('Missing trusted state ref: ' + url);
  const state = JSON.parse(process.env.MOCK_STATE);
  const raw = JSON.stringify(state);
  return new Response(JSON.stringify({ type: 'file', sha: '${'c'.repeat(40)}', size: Buffer.byteLength(raw),
    content: Buffer.from(raw).toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } });
};
`);
  const execute = (name: string, stored: unknown, overrides: Record<string, string> = {}) => {
    const workspace = join(directory, name);
    mkdirSync(workspace);
    const output = join(workspace, 'github-output.txt');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, 'prepare'], {
      cwd: workspace, encoding: 'utf8', env: {
        ...process.env, MOCK_STATE: JSON.stringify(stored), GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'unused',
        SDLC_BOT_LOGIN: 'sdlc[bot]', SDLC_ISSUE: '123', SDLC_JOB: job.id,
        SDLC_SOURCE_SHA: job.inputSha, SDLC_CONTROL_SHA: job.controlSha, SDLC_STAGE: job.stage,
        GITHUB_SHA: job.controlSha, GITHUB_ACTOR: 'sdlc[bot]', SDLC_AIC_CREDIT_LIMIT: '', ...overrides,
      },
    });
    return { result, workspace, output };
  };
  try {
    const valid = execute('valid', state);
    assert.equal(valid.result.status, 0, valid.result.stderr);
    const capabilities = describeCapabilities('code', policy, ['test/existing.test.ts']);
    assert.deepEqual(JSON.parse(readFileSync(join(valid.workspace, '.sdlc-context.json'), 'utf8')), { state, policy, capabilities });
    assert.equal(readFileSync(valid.output, 'utf8'), `base_sha=${state.baseSha}\nscan_sha=${state.headSha}\n`);
    assert.equal(JSON.parse(readFileSync(join(valid.workspace, '.sdlc-output/result.json'), 'utf8')).outcome, 'blocked');
    for (const [path, allowed] of [['test/feature/new.test.ts', true], ['test/existing.test.ts', false], ['src/controller.ts', false]] as const) {
      const checked = spawnSync(process.execPath, [script, 'check', path], {
        cwd: valid.workspace, env: { GITHUB_WORKSPACE: valid.workspace }, encoding: 'utf8',
      });
      assert.equal(checked.status, allowed ? 0 : 1, checked.stderr);
      assert.equal(JSON.parse(checked.stdout).allowed, allowed);
    }

    const securityState = structuredClone(state);
    securityState.phase = 'security';
    securityState.job!.stage = 'security';
    const security = execute('security', securityState, { SDLC_STAGE: 'security' });
    assert.equal(security.result.status, 0, security.result.stderr);
    const checkpoint = JSON.parse(readFileSync(join(security.workspace, '.sdlc-output/report.json'), 'utf8'));
    assert.equal(checkpoint.outcome, 'blocked');
    assert.match(checkpoint.summary, /Security review incomplete\. Review has not started/);
    assert.match(checkpoint.summary, /Outstanding work: all applicable security review areas/);
    assert.deepEqual(JSON.parse(readFileSync(join(security.workspace, '.sdlc-output/result.json'), 'utf8')),
      { ...checkpoint, jobId: job.id, inputSha: job.inputSha, changes: [] });

    const configured = execute('configured', state, { SDLC_AIC_CREDIT_LIMIT: '500' });
    assert.equal(configured.result.status, 0, configured.result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(configured.workspace, '.sdlc-context.json'), 'utf8')),
      { state, policy: { ...policy, maxJobCredits: 500 }, capabilities });
    const invalidLimit = execute('invalid-limit', state, { SDLC_AIC_CREDIT_LIMIT: '0' });
    assert.notEqual(invalidLimit.result.status, 0);
    assert.match(invalidLimit.result.stderr, /SDLC_AIC_CREDIT_LIMIT/);
    assert.throws(() => readFileSync(join(invalidLimit.workspace, '.sdlc-context.json')), /ENOENT/);

    const legacy = execute('legacy', { ...state, schemaVersion: 1, spend: undefined });
    assert.equal(legacy.result.status, 0, legacy.result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(legacy.workspace, '.sdlc-context.json'), 'utf8')), {
      state: { ...state, spend: { ...state.spend, historyComplete: false } }, policy, capabilities,
    });

    const mismatches: [string, unknown, Record<string, string>][] = [
      ['source', state, { SDLC_SOURCE_SHA: 'b'.repeat(40) }],
      ['stage', state, { SDLC_STAGE: 'security' }],
      ['approval', { ...state, approval: { ...state.approval!, planHash: 'd'.repeat(64) } }, {}],
      ['legacy-approval', { ...state, schemaVersion: 1, spend: undefined,
        approval: { ...state.approval!, planHash: 'd'.repeat(64) } }, {}],
      ['security-approval', { ...securityState,
        approval: { ...securityState.approval!, planHash: 'd'.repeat(64) } }, { SDLC_STAGE: 'security' }],
    ];
    for (const [name, stored, overrides] of mismatches) {
      const rejected = execute(name, stored, overrides);
      assert.notEqual(rejected.result.status, 0);
      assert.match(rejected.result.stderr, /registered job|approved plan/);
      assert.throws(() => readFileSync(join(rejected.workspace, '.sdlc-context.json')), /ENOENT/);
      assert.throws(() => readFileSync(join(rejected.workspace, '.sdlc-output/result.json')), /ENOENT/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('collect entry point derives authority and changes from registered state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-collect-'));
  const source = join(directory, 'source');
  const output = join(directory, '.sdlc-output');
  const script = resolve('src/worker.ts');
  try {
    mkdirSync(source);
    mkdirSync(output);
    const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(source, 'existing.txt'), 'before');
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
    const sha = git('rev-parse', 'HEAD');
    const state = createLifecycle(123, 'requester', 'Feature', sha);
    state.plan = makePlan('Approved plan', 0);
    state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
      authorized: true, actor: 'requester', commentId: 1, at: '2026-09-08T12:00:00Z' });
    state.phase = 'coding';
    state.feedback = 'Repair';
    const job = startJob(state, 'code', '2026-09-08T12:00:00Z');
    writeFileSync(join(directory, '.sdlc-context.json'), JSON.stringify({ state, policy }));
    writeFileSync(join(source, 'feature.txt'), 'actual change');

    writeFileSync(join(output, 'report.json'), JSON.stringify({
      outcome: 'pass', summary: 'Done', jobId: '999-999', inputSha: 'b'.repeat(40),
      changes: [{ path: 'forged.txt', content: 'forged' }],
    }));
    const rejected = spawnSync(process.execPath, [script, 'collect'], {
      cwd: directory, env: { ...process.env, GITHUB_WORKSPACE: directory }, encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.throws(() => readFileSync(join(output, 'result.json')), /ENOENT/);

    writeFileSync(join(output, 'report.json'), JSON.stringify({ outcome: 'pass', summary: 'Done' }));
    const accepted = spawnSync(process.execPath, [script, 'collect'], {
      cwd: directory, env: { ...process.env, GITHUB_WORKSPACE: directory }, encoding: 'utf8',
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'result.json'), 'utf8')), {
      jobId: job.id, inputSha: job.inputSha, outcome: 'pass', summary: 'Done',
      changes: [{ path: 'feature.txt', content: 'actual change' }],
    });
    rmSync(join(source, 'feature.txt'));
    state.phase = 'security';
    job.stage = 'security';
    writeFileSync(join(directory, '.sdlc-context.json'), JSON.stringify({ state, policy }));
    for (const summary of ['Security review incomplete. All checks pending.',
      'Security review incomplete. Injection reviewed; authorization pending.']) {
      writeFileSync(join(output, 'report.json'), JSON.stringify({ outcome: 'blocked', summary }));
      const checkpoint = spawnSync(process.execPath, [script, 'collect'], {
        cwd: directory, env: { ...process.env, GITHUB_WORKSPACE: directory }, encoding: 'utf8',
      });
      assert.equal(checkpoint.status, 0, checkpoint.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(output, 'result.json'), 'utf8')),
        { jobId: job.id, inputSha: job.inputSha, outcome: 'blocked', summary, changes: [] });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('collector includes edits, additions, and deletions without following symlinks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-collector-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(directory, 'existing.txt'), 'before');
    writeFileSync(join(directory, 'removed.txt'), 'delete');
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
    const sha = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'existing.txt'), 'after');
    writeFileSync(join(directory, 'added.txt'), 'added');
    rmSync(join(directory, 'removed.txt'));
    assert.deepEqual(collectChanges(directory, sha, 'code', policy), [
      { path: 'added.txt', content: 'added' }, { path: 'existing.txt', content: 'after' },
      { path: 'removed.txt', content: null },
    ]);
    assert.throws(() => collectChanges(directory, sha, 'code', { ...policy, maxChangeBytes: 1 }),
      /regular text files/);
    symlinkSync('/etc/hosts', join(directory, 'linked.txt'));
    assert.throws(() => collectChanges(directory, sha, 'code', policy), /regular text files/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('checkpoint drafts resume only for the same source, plan, workflow, stage, and task', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-checkpoint-'));
  try {
    const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
    state.plan = makePlan('Approved plan', 0);
    state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
      authorized: true, actor: 'requester', commentId: 1, at: '2026-09-08T12:00:00Z' });
    state.phase = 'coding';
    state.feedback = 'Repair';
    const job = startJob(state, 'code', '2026-09-08T12:00:00Z');
    routeRecovery(state, job, { jobId: job.id, inputSha: job.inputSha, outcome: 'blocked', summary: 'Partial implementation',
      changes: [{ path: 'feature/draft.txt', content: 'draft' }], blocker: { category: 'incomplete_work', scope: 'task', paths: [],
        constraint: 'More checks needed', diagnostics: [], remedies: ['Continue'] } }, policy, [], '2026-09-08T12:01:00Z');
    const successor = startJob(state, 'code', '2026-09-08T12:02:00Z');
    for (const change of [{ inputSha: 'b'.repeat(40) }, { controlSha: 'b'.repeat(40) },
      { planHash: 'b'.repeat(64) }, { taskId: 'other' }, { stage: 'test' as const }]) {
      state.job = { ...successor, ...change };
      assert.equal(restoreCheckpoint(state, directory, policy, []), false);
    }
    state.job = successor;
    assert.equal(restoreCheckpoint(state, directory, policy, []), true);
    assert.equal(readFileSync(join(directory, 'feature/draft.txt'), 'utf8'), 'draft');
    assert.equal(state.headSha, 'a'.repeat(40));
    assert.deepEqual(state.evidence, []);
    writeDraft(directory, [{ path: 'feature/draft.txt', content: null }]);
    assert.throws(() => readFileSync(join(directory, 'feature/draft.txt')), /ENOENT/);
    assert.throws(() => writeDraft(directory, [{ path: '../escape', content: 'unsafe' }]), /Unsafe draft/);
    symlinkSync(tmpdir(), join(directory, 'escape'));
    assert.throws(() => writeDraft(directory, [{ path: 'escape/outside.txt', content: 'unsafe' }]), /symlink/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('integration worker emits a deterministic receipt or a bounded blocker without live writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-integration-cli-'));
  try {
    const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
    state.plan = makePlan('Original plan', 0);
    state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
      authorized: true, actor: 'requester', commentId: 1, at: '2026-09-17T12:00:00Z' });
    beginAmendment(state, { branch: 'main', sha: 'c'.repeat(40) }, state.request, 'Retain source with repaired baseline', true, true);
    state.amendment!.plan = makePlan('Amended plan', 1);
    state.amendment!.status = 'awaiting_approval';
    state.phase = 'awaiting_amendment';
    decideAmendment(state, 2, 'maintainer', 2, '2026-09-17T12:01:00Z', true,
      { branch: 'main', sha: 'c'.repeat(40) }, state.request, true);
    startJob(state, 'integrate', '2026-09-17T12:02:00Z');
    writeFileSync(join(directory, '.sdlc-context.json'), JSON.stringify({ state, policy }));
    const preload = join(directory, 'mock-read-only.mjs');
    writeFileSync(preload, `
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = input instanceof Request ? input.method : init?.method || 'GET';
  if (method !== 'GET') throw new Error('Integration attempted a live write');
  const path = decodeURIComponent(url.pathname);
  if (path === '/repos/owner/repo') return Response.json({ default_branch: 'main' });
  if (path.includes('/git/ref/')) return Response.json({ object: { sha: process.env.MOCK_BASELINE } });
  if (path.includes('/git/commits/')) return Response.json({ tree: { sha: 'd'.repeat(40) } });
  if (path.includes('/git/trees/')) return Response.json({ truncated: false, tree: [] });
  throw new Error('Unexpected request');
};
`);
    const output = join(directory, 'output.txt');
    for (const moved of [false, true]) {
      writeFileSync(output, '');
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, resolve('src/worker.ts'), 'integrate'], {
        cwd: directory, encoding: 'utf8', env: { GH_TOKEN: 'fixture', GITHUB_WORKSPACE: directory, GITHUB_REPOSITORY: 'owner/repo',
          SDLC_BOT_LOGIN: 'sdlc[bot]', GITHUB_OUTPUT: output, MOCK_BASELINE: (moved ? 'b' : 'c').repeat(40),
          ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
        },
      });
      if (!moved) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, 'utf8'), `integration_hash=${digest([])}\n`);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /baseline moved/);
        const blocker = JSON.parse(readFileSync(output, 'utf8').slice('blocker='.length));
        assert.equal(blocker.category, 'approval_conflict');
        assert.equal(blocker.scope, 'repository');
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('check-result entry point treats skipped, missing, and failed checks as failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-check-result-'));
  const script = resolve('src/worker.ts');
  try {
    const execute = (stage: string, results: Record<string, { result: string; outputs?: {
      diagnostics?: string; integration_hash?: string; blocker?: string;
    } }>) => {
      execFileSync(process.execPath, [script, 'checks'], { cwd: directory, env: {
        ...process.env, SDLC_JOB: '123-1', SDLC_SOURCE_SHA: 'a'.repeat(40), SDLC_STAGE: stage,
        SDLC_CHECK_RESULTS: JSON.stringify(results), GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '1',
      } });
      return JSON.parse(readFileSync(join(directory, '.sdlc-output/result.json'), 'utf8'));
    };
    const good = { prepare: { result: 'success' }, codeql: { result: 'success' }, security: { result: 'success' } };
    assert.equal(execute('scan', good).outcome, 'pass');
    for (const result of ['skipped', 'failure', 'cancelled']) {
      assert.equal(execute('scan', { ...good, security: { result } }).outcome, 'changes_requested');
    }
    const diagnostics = 'CodeQL found 1 blocking or unclassified findings\n' +
      'js/regex/missing-regexp-anchor at test/turtle-graphics/ui.test.ts:93 (security severity 7.8)';
    const rejected = execute('scan', { ...good, codeql: {
      result: 'failure', outputs: { diagnostics: JSON.stringify(diagnostics) },
    } });
    assert.equal(rejected.outcome, 'changes_requested');
    assert.ok(rejected.summary.includes(diagnostics));
    assert.match(rejected.summary, /actions\/runs\/1/);
    const withoutDiagnostics = execute('scan', { ...good, codeql: { result: 'failure' } });
    for (const encoded of ['{', JSON.stringify({}), JSON.stringify('x'.repeat(6001)), 'x'.repeat(32_001)]) {
      assert.deepEqual(execute('scan', { ...good, codeql: {
        result: 'failure', outputs: { diagnostics: encoded },
      } }), withoutDiagnostics);
    }
    assert.deepEqual(execute('scan', { ...good, codeql: {
      result: 'success', outputs: { diagnostics: JSON.stringify(diagnostics) },
    } }), execute('scan', good));
    assert.equal(execute('validate', { prepare: { result: 'success' }, tests: { result: 'success' } }).outcome, 'pass');
    assert.equal(execute('validate', {}).outcome, 'changes_requested');
    const integrated = { prepare: { result: 'success' }, integration: { result: 'success', outputs: { integration_hash: 'a'.repeat(64) } } };
    assert.equal(execute('integrate', integrated).outcome, 'pass');
    assert.equal(execute('integrate', { ...integrated, integration: { result: 'success' } }).outcome, 'changes_requested');
    const blocked = { category: 'approval_conflict', scope: 'repository', paths: [], constraint: 'Conflict',
      diagnostics: [{ tool: 'policy', message: 'Overlapping file changes' }], remedies: ['Propose a resolution'] };
    assert.deepEqual(execute('integrate', { ...integrated, integration: {
      result: 'failure', outputs: { blocker: JSON.stringify(blocked) },
    } }).blocker, blocked);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});