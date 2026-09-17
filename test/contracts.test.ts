import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { costSchema, lifecycleSchema, migrateLifecycle, parseIntakeEvent, policySchema, reportSchema, resolvePolicy } from '../src/contracts.ts';
import { assessChanges, describeCapabilities, mergeSnapshots, validateChanges } from '../src/changes.ts';
import { approvePlan, digest, makePlan } from '../src/domain.ts';
import { createLifecycle } from '../src/lifecycle.ts';
import { advanceDependency, dependencyChanges, fetchPackageFiles, fileDigest, selectedDependencies, validateDependencyChanges,
  validatePlanPolicy, verifyDependencyFiles } from '../src/dependencies.ts';

export const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));

test('runtime credit limit defaults to 250 and overrides only the policy credit budget', () => {
  assert.equal(policy.maxJobCredits, 250);
  for (const value of [undefined, '']) assert.deepEqual(resolvePolicy(policy, value), policy);
  for (const value of ['1', '250', '500', '10000']) {
    assert.deepEqual(resolvePolicy(policy, value), { ...policy, maxJobCredits: Number(value) });
  }
  for (const value of ['0', '-1', '1.5', '10001', 'NaN', 'auto', '1e3', '001', ' 250 ', '250\n', '1\n2', '1;exit 0']) {
    assert.throws(() => resolvePolicy(policy, value), /SDLC_AIC_CREDIT_LIMIT/);
  }
  assert.throws(() => resolvePolicy({ ...policy, coverage: { ...policy.coverage, lines: 0 } }, '500'));
});

test('cost receipts preserve an optional validated run-time credit limit', () => {
  const legacy = { credits: 50, preempted: false };
  assert.deepEqual(costSchema.parse(legacy), legacy);
  assert.deepEqual(costSchema.parse({ credits: null, preempted: null }), { credits: null, preempted: null });
  assert.deepEqual(costSchema.parse({ ...legacy, creditLimit: 500 }), { ...legacy, creditLimit: 500 });
  for (const creditLimit of [0, -1, 1.5, 10001, null, '500']) {
    assert.throws(() => costSchema.parse({ ...legacy, creditLimit }));
  }
});

test('state and worker contracts reject unexpected authority fields', () => {
  const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
  assert.deepEqual(lifecycleSchema.parse(state), state);
  assert.throws(() => lifecycleSchema.parse({ ...state, bypass: true }));
  assert.throws(() => reportSchema.parse({ jobId: '123-1', inputSha: 'main', outcome: 'pass', summary: 'Done' }));
  assert.throws(() => reportSchema.parse({ jobId: '123-1', inputSha: 'a'.repeat(40),
    outcome: 'pass', summary: 'Done', approved: true }));
});

test('structured recovery blockers preserve diagnostics without granting authority', () => {
  const report = { jobId: '123-1', inputSha: 'a'.repeat(40), outcome: 'blocked', summary: 'A baseline test requires repair',
    changes: [], blocker: { category: 'baseline_defect', scope: 'repository', paths: ['test/existing.test.ts'],
      constraint: 'Existing baseline tests are immutable', diagnostics: [{ tool: 'codeql',
        ruleId: 'js/regex/missing-regexp-anchor', path: 'test/existing.test.ts', line: 12, message: 'Unanchored URL assertion' }],
      remedies: ['Propose a maintainer-reviewed baseline repair'] } };
  assert.deepEqual(reportSchema.parse(report), report);
  for (const blocker of [
    { ...report.blocker, approved: true },
    { ...report.blocker, category: 'waive_scanner' },
    { ...report.blocker, remedies: [] },
    { ...report.blocker, diagnostics: [{ tool: 'codeql', message: 'Finding', line: -1 }] },
  ]) assert.throws(() => reportSchema.parse({ ...report, blocker }));
  assert.throws(() => reportSchema.parse({ ...report, outcome: 'pass' }), /unresolved blockers/);
  assert.doesNotThrow(() => reportSchema.parse({ ...report, blocker: undefined }));
});

test('validation never rewrites the text that plan hashes are computed over', () => {
  const state = createLifecycle(123, 'requester', 'Title\n\nBody\n', 'a'.repeat(40));
  state.plan = makePlan('## Plan\n\nDo the work.\n', 0);
  state.phase = 'awaiting_approval';
  const restored = lifecycleSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored, state);
  assert.equal(restored.plan!.hash, digest({ version: restored.plan!.version, body: restored.plan!.body }));
  assert.doesNotThrow(() => approvePlan({ phase: restored.phase, plan: restored.plan, version: 1,
    authorized: true, actor: 'requester', commentId: 1, at: '2026-09-08T12:00:00Z' }));
  assert.throws(() => lifecycleSchema.parse({ ...state, request: '   ' }));
});

test('legacy state without cost history migrates without changing lifecycle authority', () => {
  const state = createLifecycle(123, 'requester', 'Title\n\nBody\n', 'a'.repeat(40));
  state.plan = makePlan('## Plan\n\nKeep the exact approved text.\n', 0);
  state.approval = { actor: 'requester', commentId: 12, planHash: state.plan.hash, at: '2026-09-08T12:00:00Z' };
  state.phase = 'pr_open';
  state.prNumber = 456;
  state.sequence = 4;
  state.tasks = [{ id: 'feature', title: 'Feature', description: 'Implement the feature',
    acceptance: ['Tests pass'], dependsOn: [], issueNumber: 124, completed: true }];
  state.evidence = [{ stage: 'review', sha: state.headSha, jobId: '123-4', runId: 99, summary: 'Reviewed\n' }];
  state.processedEvents = ['comment:12'];
  const legacy = JSON.parse(JSON.stringify({ ...state, schemaVersion: 1, spend: undefined }));
  const before = JSON.stringify(legacy);
  const migrated = migrateLifecycle(legacy);
  assert.deepEqual(migrated, { ...state, spend: { ...state.spend, historyComplete: false } });
  assert.equal(JSON.stringify(legacy), before);
  assert.deepEqual(lifecycleSchema.parse(migrated), migrated);
  assert.deepEqual(migrateLifecycle(JSON.parse(JSON.stringify(migrated))), migrated);
});

test('legacy measured costs and current state survive migration unchanged', () => {
  const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
  const totals = { runs: 4, runnerMs: 234_000, credits: 312.5, nearLimit: 1, preempted: 1 };
  const migrated = migrateLifecycle({ ...state, schemaVersion: 1, spend: totals });
  assert.deepEqual(migrated, { ...state, spend: { ...totals, historyComplete: true } });
  assert.deepEqual(migrateLifecycle(state), state);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.spend.historyComplete, true);
});

test('migration rejects malformed costs, unknown versions, and unexpected authority', () => {
  const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
  const legacy = { ...state, schemaVersion: 1, spend: undefined };
  for (const input of [
    { ...legacy, spend: null },
    { ...legacy, spend: {} },
    { ...legacy, spend: [] },
    { ...legacy, spend: { runs: -1, runnerMs: 0, credits: 0, nearLimit: 0, preempted: 0 } },
    { ...legacy, spend: { runs: 1, runnerMs: 0, credits: 0, nearLimit: 0 } },
    { ...legacy, spend: { runs: 1, runnerMs: 0, credits: 0, nearLimit: 0, preempted: 0, bypass: true } },
    { ...legacy, bypass: true },
    { ...legacy, request: '   ' },
    { ...legacy, schemaVersion: '1' },
    { ...state, schemaVersion: 3 },
    { ...state, schemaVersion: undefined },
    { ...state, spend: undefined },
    { ...state, spend: { ...state.spend, historyComplete: undefined } },
    { ...state, spend: { ...state.spend, historyComplete: 'false' } },
    { ...state, spend: { ...state.spend, runs: 0.5 } },
    { ...state, spend: { ...state.spend, credits: '0' } },
    { ...state, spend: { ...state.spend, credits: Infinity } },
    { ...state, spend: { ...state.spend, credits: NaN } },
    { ...state, spend: { ...state.spend, runnerMs: -1 } },
  ]) assert.throws(() => migrateLifecycle(input));
  assert.throws(() => lifecycleSchema.parse(legacy));
});

test('intake is bound to an immutable human label-event snapshot', () => {
  const event = {
    action: 'labeled', label: { name: policy.label }, sender: { login: 'maintainer', type: 'User' },
    issue: { number: 123, title: 'Feature', body: 'Original scope', user: { login: 'requester' } },
  };
  assert.deepEqual(parseIntakeEvent(event, policy.label), {
    issueNumber: 123, actor: 'maintainer', requester: 'requester', title: 'Feature', body: 'Original scope',
  });
  assert.equal(parseIntakeEvent({ ...event, action: 'edited' }, policy.label), undefined);
  assert.equal(parseIntakeEvent({ ...event, label: { name: 'other' } }, policy.label), undefined);
  assert.equal(parseIntakeEvent({ ...event, sender: { login: 'app[bot]', type: 'Bot' } }, policy.label), undefined);
});

test('publisher rejects traversal, protected configuration, and case collisions', () => {
  for (const path of ['../escape', '/tmp/escape', 'foo/../bar', '.git/config', 'foo/.GIT/config',
    '.github/workflows/ci.yml', '.GitHub/workflows/ci.yml', 'src/controller.ts',
    '.npmrc', 'nested/.npmrc', 'package.json', 'nested/package.json', 'package-lock.json',
    'AGENTS.md', 'src/AGENTS.md', 'file\\name', 'file\nname']) {
    assert.throws(() => validateChanges([{ path, content: 'unsafe' }], 'code', policy), Error, path);
  }
  assert.throws(() => validateChanges([{ path: 'README.md', content: '' },
    { path: 'readme.md', content: '' }], 'code', policy), /colliding/);
  assert.throws(() => validateChanges([{ path: 'Dir/first.txt', content: '' },
    { path: 'dir/second.txt', content: '' }], 'code', policy), /colliding/);
  for (const changes of [
    [{ path: 'Foo', content: '' }, { path: 'foo/bar.ts', content: '' }],
    [{ path: 'foo/bar.ts', content: '' }, { path: 'Foo', content: '' }],
  ]) assert.throws(() => validateChanges(changes, 'code', policy), /Conflicting/);
});

test('stage permissions and output budgets are enforced by code', () => {
  assert.doesNotThrow(() => validateChanges([{ path: 'test/new.test.ts', content: 'test' }], 'test', policy));
  assert.throws(() => validateChanges([{ path: 'README.md', content: 'text' }], 'test', policy), /only change tests/);
  assert.doesNotThrow(() => validateChanges([{ path: 'README.md', content: 'text' },
    { path: 'docs/architecture.md', content: 'text' }, { path: 'docs/adr/0001-choice.md', content: 'text' }],
    'document', policy));
  for (const path of ['src/feature/clock.ts', 'test/new.test.ts', 'notes.md'])
    assert.throws(() => validateChanges([{ path, content: 'text' }], 'document', policy), /only change documentation/);
  assert.throws(() => validateChanges([{ path: 'README.md', content: 'text' }], 'security', policy), /Read-only/);
  assert.throws(() => validateChanges([{ path: 'README.md', content: '\0' }], 'code', policy), /Binary/);
  assert.throws(() => validateChanges([{ path: 'README.md', content: 'too much' }], 'code',
    { ...policy, maxChangeBytes: 1 }), /size/);
  assert.throws(() => validateChanges([{ path: 'README.md', content: '' }], 'code',
    { ...policy, maxFiles: 0 }), /file budget/);
});

test('shared capabilities distinguish baseline tests from editable feature tests', () => {
  const baseline = ['test/existing.test.ts'];
  const capabilities = describeCapabilities('code', policy, [...baseline, ...baseline]);
  assert.deepEqual(capabilities.immutableTests, baseline);
  assert.equal(capabilities.canProposeChanges, true);
  assert.equal(describeCapabilities('security', policy, baseline).canProposeChanges, false);
  const added = [{ path: 'test/feature/new.test.ts', content: 'new coverage' }];
  assert.deepEqual(assessChanges(added, 'code', policy, baseline), { allowed: true, reason: 'permitted' });
  assert.deepEqual(assessChanges([{ path: baseline[0]!, content: 'changed' }], 'code', policy, baseline),
    { allowed: false, reason: 'Existing baseline tests are immutable' });
  assert.equal(assessChanges([{ path: baseline[0]!, content: 'changed' }], 'test', policy, baseline).allowed, false);
  assert.equal(assessChanges([{ path: 'src/controller.ts', content: 'changed' }], 'code', policy, baseline).allowed, false);
  assert.equal(assessChanges([{ path: '../escape', content: 'changed' }], 'code', policy, baseline).allowed, false);
  assert.equal(assessChanges(added, 'security', policy, baseline).allowed, false);
});

test('integration snapshots preserve disjoint work and refuse overlapping changes', () => {
  const entry = (sha: string) => ({ sha: sha.repeat(40), mode: '100644', type: 'blob' });
  const base = new Map([['test/existing.test.ts', entry('a')], ['src/feature.ts', entry('b')]]);
  const source = new Map([...base, ['apps/new.js', entry('c')]]);
  const target = new Map([...base, ['test/existing.test.ts', entry('d')]]);
  assert.deepEqual(mergeSnapshots(base, source, target), [
    { path: 'apps/new.js', ...entry('c') }, { path: 'src/feature.ts', ...entry('b') }, { path: 'test/existing.test.ts', ...entry('d') },
  ]);
  source.set('test/existing.test.ts', entry('e'));
  assert.throws(() => mergeSnapshots(base, source, target), /Integration conflict/);
  source.set('test/existing.test.ts', entry('d'));
  assert.equal(mergeSnapshots(base, source, target).length, 3);
});

test('integration resolutions bind exact conflicting blob identities and cannot introduce unrelated edits', () => {
  const entry = (sha: string) => ({ sha: sha.repeat(40), mode: '100644', type: 'blob' });
  const path = 'src/feature/module.ts';
  const base = new Map([[path, entry('a')]]), source = new Map([[path, entry('b')]]), target = new Map([[path, entry('c')]]);
  const resolution = { path, baseSha: 'a'.repeat(40), sourceSha: 'b'.repeat(40), targetSha: 'c'.repeat(40), content: 'reviewed merge' };
  const files = mergeSnapshots(base, source, target, [resolution]);
  assert.equal(files.length, 1);
  assert.notEqual(files[0]!.sha, 'b'.repeat(40));
  assert.deepEqual(mergeSnapshots(base, source, target, [{ ...resolution, content: null }]), []);
  assert.throws(() => mergeSnapshots(base, source, target, [{ ...resolution, targetSha: 'd'.repeat(40) }]), /Stale/);
  assert.throws(() => mergeSnapshots(base, source, target, [resolution, resolution]), /distinct current conflicts/);
  assert.throws(() => mergeSnapshots(base, source, target, [resolution, { ...resolution, path: 'unrelated.ts' }]), /current conflicts/);
  assert.throws(() => validatePlanPolicy({ allowTaskSplits: false, vendorSecurityPatches: [], dependencies: [],
    integrationResolutions: [{ ...resolution, path: 'src/controller.ts' }] }, policy), /Protected file/);
});

test('dependency preflight verifies pinned bytes and limits alternatives and security patch authority', () => {
  const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
  const files = [
    { path: 'apps/vendor/library.js', archivePath: 'package/library.js', sha256: fileDigest('upstream'), role: 'runtime' as const },
    { path: 'apps/vendor/LICENSE', archivePath: 'package/LICENSE', sha256: fileDigest('license'), role: 'license' as const },
  ];
  const policyForPlan = { allowTaskSplits: true, vendorSecurityPatches: [files[0]!.path], dependencies: [
    { id: 'library', package: 'library', license: 'MIT', variants: [{ version: '1.0.0', files }, { version: '1.0.1', files }] },
  ] };
  state.plan = makePlan('Use the pinned library', 0, policyForPlan);
  const fetcher = () => new Map([['package/library.js', Buffer.from('upstream')], ['package/LICENSE', Buffer.from('license')]]);
  assert.deepEqual(dependencyChanges(state, policy, fetcher), files.map(file => ({ path: file.path,
    content: file.role === 'license' ? 'license' : 'upstream' })));
  assert.throws(() => dependencyChanges(state, policy, () => new Map()), /integrity mismatch/);
  assert.equal(advanceDependency(state, ['unrelated.ts']), false);
  assert.equal(advanceDependency(state, [files[0]!.path]), true);
  assert.equal(advanceDependency(state, [files[0]!.path]), false);
  assert.throws(() => validatePlanPolicy({ ...policyForPlan, vendorSecurityPatches: [files[1]!.path] }, policy), /non-license/);
  const job = { id: '123-2', stage: 'code' as const, inputSha: state.headSha, controlSha: state.controlSha,
    planHash: state.plan.hash, taskId: null, feedback: 'Repair', attempt: 1, createdAt: '2026-09-17T12:00:00Z' };
  assert.throws(() => validateDependencyChanges(state, job, [{ path: files[0]!.path, content: 'patched' }]), /authority/);
  state.recoveries = [{ id: '123-1', fingerprint: 'a'.repeat(64), job: { ...job, id: '123-1', stage: 'scan' },
    blocker: { category: 'candidate_defect', scope: 'repository', paths: [files[0]!.path], constraint: 'Scanner finding',
      diagnostics: [{ tool: 'codeql', path: files[0]!.path, ruleId: 'js/incomplete-sanitization', message: 'Finding' }], remedies: ['Repair'] },
    action: 'repair', status: 'active', resumePhase: 'scanning', attempts: 1, attemptedKeys: [] }];
  const patch = validateDependencyChanges(state, job, [{ path: files[0]!.path, content: 'patched' }])[0]!;
  assert.equal(patch.upstreamSha256, files[0]!.sha256);
  assert.equal(patch.patchedSha256, fileDigest('patched'));
  assert.throws(() => validateDependencyChanges(state, job, [{ path: files[1]!.path, content: 'changed license' }]), /authority/);
  assert.throws(() => validateDependencyChanges(state, job, [{ path: files[0]!.path, content: null }]), /cannot be deleted/);
  assert.throws(() => validateDependencyChanges(state, { ...job, purpose: 'dependency_repair' },
    [{ path: 'apps/unrelated.js', content: 'unapproved work' }]), /only change approved dependency/);
  assert.deepEqual(validateDependencyChanges(state, job, [{ path: files[0]!.path, content: 'upstream' }]), []);
  assert.throws(() => validatePlanPolicy({ ...policyForPlan, dependencies: [policyForPlan.dependencies[0]!, policyForPlan.dependencies[0]!] }, policy), /Duplicate/);
  const variant = policyForPlan.dependencies[0]!.variants[0]!;
  assert.throws(() => validatePlanPolicy({ ...policyForPlan, dependencies: [{ ...policyForPlan.dependencies[0]!,
    variants: [{ ...variant, files: [files[0]!] }] }] }, policy), /license file/);
  assert.throws(() => validatePlanPolicy({ ...policyForPlan, dependencies: [{ ...policyForPlan.dependencies[0]!,
    variants: [variant, { ...variant, files: [files[0]!] }] }] }, policy), /preserve installed paths/);
  assert.throws(() => validatePlanPolicy({ ...policyForPlan, dependencies: [{ ...policyForPlan.dependencies[0]!,
    variants: [{ ...variant, files: [{ ...files[0]!, archivePath: 'package/../escape' }, files[1]!] }] }] }, policy), /Unsafe archive/);
  state.dependencyChoices = { unknown: 0 };
  assert.throws(() => selectedDependencies(state), /Unapproved dependency selection/);
  state.dependencyChoices = { library: 2 };
  assert.throws(() => selectedDependencies(state), /Unapproved dependency alternative/);
  state.job = { ...job, stage: 'scan', purpose: 'baseline_preflight' };
  assert.deepEqual(selectedDependencies(state), []);
});

test('package preflight reads bounded archive members without executing package scripts or forwarding credentials', () => {
  let scratch = '';
  const calls: string[] = [];
  const files = fetchPackageFiles('library', '1.0.0', ['package/lib.js'], (command, args, options) => {
    scratch = options.cwd;
    calls.push(command);
    assert.equal(options.env.GH_TOKEN, undefined);
    assert.equal(options.env.NODE_TEST_CONTEXT, undefined);
    assert.equal(options.env.SDLC_APP_PRIVATE_KEY, undefined);
    if (command === 'npm') {
      assert.ok(args.includes('--ignore-scripts'));
      assert.ok(args.includes('--registry=https://registry.npmjs.org'));
      assert.ok(args.includes(`--userconfig=${join(options.cwd, 'user.npmrc')}`));
      assert.ok(args.includes(`--globalconfig=${join(options.cwd, 'global.npmrc')}`));
      writeFileSync(join(options.cwd, 'fixture.tgz'), 'archive');
      return Buffer.from(JSON.stringify([{ filename: 'fixture.tgz' }]));
    }
    assert.deepEqual(args, ['-xOf', '-', '--', 'package/lib.js']);
    assert.equal(Buffer.from(options.input!).toString(), 'archive');
    assert.equal(options.maxBuffer, 512_000);
    return Buffer.from('library bytes');
  });
  assert.deepEqual(calls, ['npm', 'tar']);
  assert.equal(Buffer.from(files.get('package/lib.js')!).toString(), 'library bytes');
  assert.equal(existsSync(scratch), false);
  for (const filename of ['../escape.tgz', '/tmp/escape.tgz', 'not-an-archive', null]) {
    assert.throws(() => fetchPackageFiles('library', '1.0.0', [], () => Buffer.from(JSON.stringify([{ filename }]))), /archive name/);
  }
});

test('installed dependency checks accept only original bytes or a current-plan recorded security patch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-installed-dependency-'));
  try {
    mkdirSync(join(directory, 'vendor'));
    const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
    const files = [
      { path: 'vendor/lib.js', archivePath: 'package/lib.js', sha256: fileDigest('upstream'), role: 'runtime' as const },
      { path: 'vendor/LICENSE', archivePath: 'package/LICENSE', sha256: fileDigest('license'), role: 'license' as const },
    ];
    state.plan = makePlan('Pinned dependency', 0, { allowTaskSplits: false, vendorSecurityPatches: [files[0]!.path], dependencies: [
      { id: 'library', package: 'library', license: 'MIT', variants: [{ version: '1.0.0', files }] },
    ] });
    writeFileSync(join(directory, 'vendor/lib.js'), 'upstream');
    writeFileSync(join(directory, 'vendor/LICENSE'), 'license');
    assert.doesNotThrow(() => verifyDependencyFiles(state, directory));
    writeFileSync(join(directory, 'vendor/lib.js'), 'patched');
    assert.throws(() => verifyDependencyFiles(state, directory), /integrity mismatch/);
    state.dependencyPatches = [{ dependencyId: 'library', path: files[0]!.path, upstreamSha256: fileDigest('upstream'),
      patchedSha256: fileDigest('patched'), planHash: state.plan.hash, jobId: '123-2', inputSha: state.headSha, outputSha: 'b'.repeat(40) }];
    assert.doesNotThrow(() => verifyDependencyFiles(state, directory));
    state.dependencyPatches[0]!.planHash = 'f'.repeat(64);
    assert.throws(() => verifyDependencyFiles(state, directory), /integrity mismatch/);
    rmSync(join(directory, 'vendor/lib.js'));
    symlinkSync(join(directory, 'vendor/LICENSE'), join(directory, 'vendor/lib.js'));
    assert.throws(() => verifyDependencyFiles(state, directory));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});