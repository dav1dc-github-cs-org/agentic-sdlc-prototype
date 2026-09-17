import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Controller, RetryablePlatformError, type Comment, type Platform, type RecordState, type Run } from '../src/controller.ts';
import { costSchema, lifecycleSchema, migrateLifecycle, policySchema, type Change, type Cost, type Intake, type Report } from '../src/contracts.ts';
import { createLifecycle, type Job, type Lifecycle, type Task } from '../src/lifecycle.ts';
import { fileDigest } from '../src/dependencies.ts';

const policy = { ...policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8'))), preflight: false };
const baseSha = 'a'.repeat(40);

class FakePlatform implements Platform {
  raw?: string;
  version?: string;
  saveFailure?: unknown;
  input = { number: 123, title: 'Feature', body: 'Implement a feature', author: 'requester', open: true, labeled: true };
  messages: Comment[] = [];
  outputs = new Map<string, string>();
  dispatched: Job[] = [];
  dispatchFailure?: unknown;
  runs = new Map<string, Run>();
  reports = new Map<number, Report>();
  reportFailure?: unknown;
  cancelled: number[] = [];
  cancelFailure?: unknown;
  changed = 0;
  published = 0;
  closedTasks = 0;
  retired: number[] = [];
  baselineSha = baseSha;
  immutableTests: string[] = [];
  trustedChange = false;
  disposition: 'open' | 'closed' | 'merged' = 'open';
  async issue() { return this.input; }
  async comments() { return this.messages; }
  async canWrite(actor: string) { return actor === 'maintainer'; }
  async baseline() { return { branch: 'main', sha: this.baselineSha }; }
  async baselineTests() { return this.immutableTests; }
  async integration() { return 'e'.repeat(64); }
  integrations = 0;
  maintenancePublished = 0;
  async publishMaintenance() { this.maintenancePublished += 1; return 127; }
  async applyIntegration(_state: Lifecycle, _job: Job, expectedHash: string) {
    assert.equal(expectedHash, 'e'.repeat(64));
    this.integrations += 1;
    return 'f'.repeat(40);
  }
  async trustedPathsChanged(from: string, to: string) { return from !== to && this.trustedChange; }
  // Mirrors GitHub.save/GitHub.load exactly: raw JSON on write, schema-validated on read.
  async load() {
    if (this.raw === undefined) return undefined;
    const stored = JSON.parse(this.raw);
    const state = migrateLifecycle(stored);
    return { state, version: this.version, needsMigration: stored.schemaVersion !== state.schemaVersion };
  }
  async save(record: RecordState) {
    lifecycleSchema.parse(record.state);
    if (this.saveFailure) throw this.saveFailure;
    assert.equal(record.version, this.version, 'State write conflict');
    this.raw = JSON.stringify(record.state);
    this.version = `${Number(this.version ?? 0) + 1}`;
    record.version = this.version;
    delete record.needsMigration;
  }
  get stored(): { state: Lifecycle } | undefined {
    return this.raw === undefined ? undefined : { state: lifecycleSchema.parse(JSON.parse(this.raw)) };
  }
  patch(change: (state: Lifecycle) => void): void {
    const state = lifecycleSchema.parse(JSON.parse(this.raw!));
    change(state);
    this.raw = JSON.stringify(state);
  }
  async comment(_number: number, key: string, body: string) { this.outputs.set(key, body); }
  async task(_state: Lifecycle, task: Task) { return task.id === 'first' ? 124 : 125; }
  linked = 0;
  async linkTasks() { this.linked += 1; }
  async dispatch(job: Job) {
    this.dispatched.push(structuredClone(job));
    if (this.dispatchFailure) throw this.dispatchFailure;
  }
  async findRun(job: Job) { return this.runs.get(job.id); }
  async cancelRun(runId: number) {
    this.cancelled.push(runId);
    if (this.cancelFailure) throw this.cancelFailure;
  }
  async report(run: Run) {
    if (this.reportFailure) throw this.reportFailure;
    return this.reports.get(run.id)!;
  }
  costs: (Cost & { runnerMs: number })[] = [];
  charged: number[] = [];
  costFailure?: unknown;
  async cost(run: Run) {
    this.charged.push(run.id);
    if (this.costFailure) throw this.costFailure;
    return this.costs.shift() ?? { runnerMs: 60_000, credits: 10, preempted: false };
  }
  async applyChanges(_state: Lifecycle, _job: Job, _changes: Change[]) {
    this.changed += 1;
    return this.changed.toString(16).padStart(40, '0');
  }
  async publish() { this.published += 1; return 126; }
  async pullRequest() { return this.disposition; }
  async closeTasks() { this.closedTasks += 1; }
  async retireTasks(numbers: number[]) { this.retired.push(...numbers); }
  reply(body: string, actor = 'requester') {
    this.messages.push({ id: this.messages.length + 1, body, actor, human: true, createdAt: '2026-09-08T12:00:00Z' });
  }
  finish(extra: Partial<Report> = {}, conclusion = 'success') {
    const job = this.stored!.state.job!;
    const id = this.reports.size + 1;
    this.runs.set(job.id, { id, status: 'completed', conclusion, url: `https://github.com/owner/repo/actions/runs/${id}` });
    this.reports.set(id, { jobId: job.id, inputSha: job.inputSha, outcome: 'pass', summary: 'Checked successfully', changes: [], ...extra });
  }
}

function controllerProcessFixture(states: Record<string, unknown>, interruptWrite = false) {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-controller-migration-'));
  const store = join(directory, 'store.json');
  const preload = join(directory, 'mock-github.mjs');
  writeFileSync(store, JSON.stringify({ states, comments: {}, requests: [], writes: [], interruptWrite }));
  writeFileSync(preload, String.raw`
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const filename = process.env.MOCK_STORE;
const sha = state => createHash('sha1').update(JSON.stringify(state)).digest('hex');
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = input instanceof Request ? input.method : init?.method || 'GET';
  const path = decodeURIComponent(url.pathname);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const store = JSON.parse(readFileSync(filename, 'utf8'));
  store.requests.push(method + ' ' + path);
  const respond = (data, status = 200) => {
    writeFileSync(filename, JSON.stringify(store));
    const response = new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  if (url.origin !== 'https://api.github.com') return respond({ message: 'Unexpected origin' }, 500);
  if (method === 'GET' && path === '/repos/owner/repo') return respond({ default_branch: 'main' });
  if (method === 'GET' && /^\/repos\/owner\/repo\/git\/ref\/heads\/(main|sdlc-state)$/.test(path)) {
    return respond({ object: { sha: 'a'.repeat(40) } });
  }
  if (method === 'GET' && path === '/repos/owner/repo/contents/issues') {
    return respond(Object.keys(store.states).map(number => ({ name: number + '.json', type: 'file' })));
  }
  if (method === 'GET' && path === '/repos/owner/repo/issues') return respond([]);
  const record = /^\/repos\/owner\/repo\/contents\/issues\/(\d+)\.json$/.exec(path);
  if (record) {
    const number = record[1];
    const state = store.states[number];
    if (method === 'GET') {
      const content = JSON.stringify(state);
      return respond({ type: 'file', sha: sha(state), size: Buffer.byteLength(content),
        content: Buffer.from(content).toString('base64') });
    }
    if (method === 'PUT' && body.branch === 'sdlc-state') {
      if (body.sha !== sha(state)) return respond({ message: 'State write conflict' }, 409);
      store.states[number] = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      store.writes.push(method + ' ' + path);
      if (store.interruptWrite) {
        store.interruptWrite = false;
        writeFileSync(filename, JSON.stringify(store));
        throw new Error('Lost migration acknowledgement');
      }
      return respond({ content: { sha: sha(store.states[number]) } });
    }
  }
  const issue = /^\/repos\/owner\/repo\/issues\/(\d+)$/.exec(path);
  if (method === 'GET' && issue) {
    return respond({ number: Number(issue[1]), title: 'Feature', body: '',
      user: { login: 'requester' }, state: 'closed', labels: [] });
  }
  const comments = /^\/repos\/owner\/repo\/issues\/(\d+)\/comments$/.exec(path);
  if (comments) {
    const number = comments[1];
    if (method === 'GET') return respond(store.comments[number] || []);
    if (method === 'POST') {
      const comment = { id: Number(number), body: body.body, user: { login: 'sdlc[bot]', type: 'Bot' },
        created_at: '2026-09-11T12:00:00Z', updated_at: '2026-09-11T12:00:00Z' };
      (store.comments[number] ||= []).push(comment);
      store.writes.push(method + ' ' + path);
      return respond(comment);
    }
  }
  return respond({ message: 'Unexpected request: ' + method + ' ' + path }, 500);
};
`);
  const eventPath = join(directory, 'event.json');
  return {
    execute: (overrides: Record<string, string> = {}, event?: unknown) => {
      if (event !== undefined) writeFileSync(eventPath, JSON.stringify(event));
      return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, resolve('src/main.ts')], {
          cwd: process.cwd(), encoding: 'utf8', env: {
            GH_TOKEN: 'unused-fixture-token', GITHUB_REPOSITORY: 'owner/repo', SDLC_BOT_LOGIN: 'sdlc[bot]',
            GITHUB_SHA: baseSha, MOCK_STORE: store,
            ...(event === undefined ? {} : { GITHUB_EVENT_PATH: eventPath }),
            ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
            ...overrides,
          },
        });
    },
    read: () => JSON.parse(readFileSync(store, 'utf8')),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function intake(platform: FakePlatform, actor = 'maintainer'): Intake {
  return { issueNumber: platform.input.number, actor, requester: platform.input.author,
    title: platform.input.title, body: platform.input.body };
}

async function planned() {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  await controller.tick(123, intake(platform));
  platform.finish({ plan: 'Implement the feature with regression coverage.' });
  await controller.tick(123);
  return { platform, controller };
}

async function coding() {
  const context = await planned();
  context.platform.reply('/sdlc approve v1');
  await context.controller.tick(123);
  context.platform.finish({ tasks: [
    { id: 'second', title: 'Second task', description: 'Depends on first', acceptance: ['Works'], dependsOn: ['first'] },
    { id: 'first', title: 'First task', description: 'Independent', acceptance: ['Works'], dependsOn: [] },
  ] });
  await context.controller.tick(123);
  return context;
}

test('controller routes verified recovery and rejects unchanged retries without granting new authority', async () => {
  const { platform, controller } = await coding();
  const blocker = { category: 'baseline_defect' as const, scope: 'task' as const, paths: ['test/feature/new.test.ts'],
    constraint: 'A new feature test was mistaken for an immutable baseline', diagnostics: [], remedies: ['Repair the new test'] };
  platform.finish({ outcome: 'blocked', blocker });
  await controller.tick(123);
  assert.equal(platform.stored!.state.recoveries![0]!.action, 'repair');
  assert.equal(platform.stored!.state.phase, 'coding');
  assert.equal(platform.changed, 0);
  platform.finish({ outcome: 'blocked', blocker });
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
  const dispatched = platform.dispatched.length;
  platform.reply('/sdlc retry', 'maintainer');
  await controller.tick(123);
  assert.equal(platform.dispatched.length, dispatched);
  assert.match(platform.outputs.get('comment:2')!, /retry cannot change its authority/);
  assert.equal(platform.stored!.state.recoveries![0]!.attempts, 1);
});

test('structured transient recovery waits with bounded backoff before dispatching again', async () => {
  const { platform } = await coding();
  let now = new Date('2026-09-17T12:00:00Z');
  const controller = new Controller(platform, policy, () => now);
  platform.finish({ outcome: 'blocked', blocker: { category: 'transient', scope: 'task', paths: [],
    constraint: 'Temporary service interruption', diagnostics: [{ tool: 'platform', message: 'Connection reset' }],
    remedies: ['Retry after backoff'] } });
  const dispatched = platform.dispatched.length;
  await controller.tick(123);
  assert.equal(platform.dispatched.length, dispatched);
  now = new Date('2026-09-17T12:00:30Z');
  await controller.tick(123);
  assert.equal(platform.dispatched.length, dispatched + 1);
  assert.equal(platform.stored!.state.retryAt, undefined);
});

test('approved amendments preserve source, require fresh authority, and integrate before revalidation', async () => {
  const { platform, controller } = await coding();
  platform.finish({ changes: [{ path: 'src/feature/new.ts', content: 'implemented' }] });
  await controller.tick(123);
  const preserved = platform.stored!.state.headSha;
  const originalBranch = platform.stored!.state.branch;
  platform.baselineSha = 'b'.repeat(40);
  platform.trustedChange = true;
  platform.reply('/sdlc amend Repair the baseline and retain the implemented feature.', 'maintainer');
  await controller.tick(123);
  assert.equal(platform.stored!.state.headSha, preserved);
  assert.equal(platform.stored!.state.branch, originalBranch);
  assert.equal(platform.stored!.state.job!.purpose, 'amendment');
  platform.finish({ plan: 'Same feature with an approved baseline repair.' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'awaiting_amendment');
  platform.reply('/sdlc approve-amendment v2');
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'awaiting_amendment');
  platform.reply('/sdlc approve-amendment v2', 'maintainer');
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.stage, 'integrate');
  assert.equal(platform.stored!.state.headSha, preserved);
  platform.finish({ integrationHash: 'e'.repeat(64) });
  await controller.tick(123);
  assert.equal(platform.integrations, 1);
  assert.equal(platform.stored!.state.baseSha, platform.baselineSha);
  assert.equal(platform.stored!.state.headSha, 'f'.repeat(40));
  assert.equal(platform.stored!.state.branch, 'agentic/epic-123-v2');
  assert.equal(platform.stored!.state.job!.stage, 'decompose');
  assert.deepEqual(platform.stored!.state.evidence, []);
  await controller.tick(123);
  assert.equal(platform.integrations, 1);
});

test('amendment approvals reject a moved baseline and explicit rejection preserves the implementation', async () => {
  const { platform, controller } = await coding();
  platform.reply('/sdlc amend Retain the feature with a narrower dependency policy.');
  await controller.tick(123);
  platform.finish({ plan: 'A bounded replacement policy.' });
  await controller.tick(123);
  const source = platform.stored!.state.headSha;
  platform.baselineSha = 'b'.repeat(40);
  platform.reply('/sdlc approve-amendment v2', 'maintainer');
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'awaiting_amendment');
  assert.equal(platform.integrations, 0);
  platform.baselineSha = baseSha;
  platform.reply('/sdlc reject-amendment v2');
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.stored!.state.headSha, source);
  assert.equal(platform.stored!.state.amendmentHistory![0]!.decision, 'rejected');
});

test('preflight scans the baseline before inference and never supplies candidate gate evidence', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, { ...policy, preflight: true });
  await controller.tick(123, intake(platform));
  assert.equal(platform.stored!.state.job!.purpose, 'baseline_preflight');
  assert.equal(platform.stored!.state.job!.probeSha, baseSha);
  assert.equal(platform.stored!.state.approval, undefined);
  platform.finish();
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.stage, 'research');
  assert.deepEqual(platform.stored!.state.evidence, []);
});

test('preflight continuation resolves its blocker and full revision rechecks the new baseline', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, { ...policy, preflight: true });
  await controller.tick(123, intake(platform));
  platform.finish({ outcome: 'changes_requested', blocker: { category: 'incomplete_work', scope: 'repository', paths: [],
    constraint: 'Scanner service unavailable', diagnostics: [{ tool: 'platform', message: 'Scanner could not run' }], remedies: ['Retry'] } }, 'failure');
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.purpose, 'baseline_preflight');
  platform.finish();
  await controller.tick(123);
  assert.equal(platform.stored!.state.recoveries![0]!.status, 'resolved');
  assert.equal(platform.stored!.state.job!.stage, 'research');
  platform.finish({ plan: 'An initial plan' });
  await controller.tick(123);
  platform.reply('/sdlc revise Changed approach.');
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.purpose, 'baseline_preflight');
});

test('failed coding workflows retain bound drafts without accepted results or source publication', async () => {
  const { platform, controller } = await coding();
  const failedJob = platform.stored!.state.job!;
  platform.finish({ outcome: 'blocked', summary: 'Partial draft before timeout', changes: [{ path: 'apps/draft.js', content: 'draft' }],
    blocker: { category: 'incomplete_work', scope: 'task', paths: [], constraint: 'Time limit', diagnostics: [], remedies: ['Continue'] } }, 'failure');
  await controller.tick(123);
  assert.equal(platform.changed, 0);
  assert.notEqual(platform.stored!.state.job!.id, failedJob.id);
  assert.equal(platform.stored!.state.headSha, failedJob.inputSha);
  assert.deepEqual(platform.stored!.state.recoveries![0]!.checkpoint!.changes, [{ path: 'apps/draft.js', content: 'draft' }]);
  assert.equal(platform.stored!.state.usageHistory!.find(item => item.job.id === failedJob.id)!.acceptedResult, undefined);
});

test('baseline maintenance proposals require an exact patch hash and explicit maintainer publication', async () => {
  const { platform, controller } = await coding();
  platform.immutableTests = ['test/existing.test.ts'];
  platform.finish({ outcome: 'blocked', blocker: { category: 'candidate_defect', scope: 'repository', paths: platform.immutableTests,
    constraint: 'Scanner finding in baseline', diagnostics: [{ tool: 'codeql', path: platform.immutableTests[0]!, message: 'Finding' }],
    remedies: ['Prepare a baseline repair'] } });
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.stage, 'maintain');
  platform.finish({ maintenanceChanges: [{ path: platform.immutableTests[0]!, content: 'fixed assertion' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.changed, 0);
  assert.equal(platform.maintenancePublished, 0);
  const recovery = platform.stored!.state.recoveries![0]!;
  platform.reply(`/sdlc propose-maintenance ${recovery.id} ${recovery.maintenance!.hash}`);
  await controller.tick(123);
  assert.equal(platform.maintenancePublished, 0);
  platform.reply(`/sdlc propose-maintenance ${recovery.id} ${'f'.repeat(64)}`, 'maintainer');
  await controller.tick(123);
  assert.equal(platform.maintenancePublished, 0);
  platform.reply(`/sdlc propose-maintenance ${recovery.id} ${recovery.maintenance!.hash}`, 'maintainer');
  await controller.tick(123);
  assert.equal(platform.maintenancePublished, 1);
  await controller.tick(123);
  assert.equal(platform.maintenancePublished, 1);
  assert.equal(platform.stored!.state.recoveries![0]!.maintenancePr, 127);
});

test('dependency preflight can request approved repair but cannot start application code before rescanning', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, { ...policy, preflight: true });
  await controller.tick(123, intake(platform));
  platform.finish();
  await controller.tick(123);
  const vendorPath = 'apps/vendor/lib.js';
  platform.finish({ plan: 'Use the pinned dependency and allow security repairs', planPolicy: {
    allowTaskSplits: false, vendorSecurityPatches: [vendorPath], dependencies: [{ id: 'library', package: 'library', license: 'MIT', variants: [{
      version: '1.0.0', files: [
        { path: vendorPath, archivePath: 'package/lib.js', role: 'runtime', sha256: fileDigest('upstream') },
        { path: 'apps/vendor/LICENSE', archivePath: 'package/LICENSE', role: 'license', sha256: fileDigest('license') },
      ],
    }] }],
  } });
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.purpose, 'dependency_preflight');
  platform.finish({ outcome: 'changes_requested', blocker: { category: 'candidate_defect', scope: 'repository', paths: [vendorPath],
    constraint: 'CodeQL finding', diagnostics: [{ tool: 'codeql', path: vendorPath, ruleId: 'js/incomplete-sanitization', message: 'Finding' }],
    remedies: ['Repair after approval'] } }, 'failure');
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
  assert.equal(platform.stored!.state.job, undefined);
  platform.reply('/sdlc approve v1');
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.purpose, 'dependency_repair');
  platform.finish({ changes: [{ path: vendorPath, content: 'patched' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.preflight!.kind, 'installed');
  assert.equal(platform.stored!.state.job!.stage, 'scan');
  assert.equal(platform.stored!.state.dependencyPatches![0]!.patchedSha256, fileDigest('patched'));
  platform.finish();
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.stage, 'decompose');
  assert.equal(platform.stored!.state.vendorRepair, undefined);
  assert.deepEqual(platform.stored!.state.evidence, []);
});

test('stale amendment proposals can be replaced without reusing a version or losing source', async () => {
  const { platform, controller } = await coding();
  platform.reply('/sdlc amend First proposed repair.');
  await controller.tick(123);
  platform.finish({ plan: 'First proposed amendment.' });
  await controller.tick(123);
  const source = platform.stored!.state.headSha;
  platform.baselineSha = 'b'.repeat(40);
  platform.trustedChange = true;
  platform.reply('/sdlc amend Updated baseline with the same retained feature.', 'maintainer');
  await controller.tick(123);
  platform.finish({ plan: 'Replacement amendment.' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.amendment!.version, 3);
  assert.equal(platform.stored!.state.amendment!.plan!.version, 3);
  assert.equal(platform.stored!.state.headSha, source);
  platform.reply('/sdlc approve-amendment v2', 'maintainer');
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'awaiting_amendment');
});

test('approval conflicts automatically prepare an amendment but never approve their own remedy', async () => {
  const { platform, controller } = await coding();
  const head = platform.stored!.state.headSha;
  const oldApproval = platform.stored!.state.approval;
  platform.finish({ outcome: 'blocked', blocker: { category: 'approval_conflict', scope: 'repository',
    paths: ['apps/vendor/library.js'], constraint: 'The approved dependency pin prevents the scanner fix', diagnostics: [],
    remedies: ['Ask for an exact vendor security-patch permission'] } });
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.purpose, 'amendment');
  assert.equal(platform.stored!.state.headSha, head);
  assert.deepEqual(platform.stored!.state.approval, oldApproval);
  platform.finish({ plan: 'Proposed explicit security patch authority.' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'awaiting_amendment');
  assert.equal(platform.integrations, 0);
  assert.deepEqual(platform.stored!.state.approval, oldApproval);
});

test('malformed recovery splits consume bounded failures instead of repeating collection forever', async () => {
  const { platform, controller } = await coding();
  for (let attempt = 0; attempt < policy.maxJobAttempts; attempt += 1) {
    platform.finish({ outcome: 'blocked', blocker: { category: 'incomplete_work', scope: 'task', paths: [],
      constraint: 'More work', diagnostics: [], remedies: ['Split'] }, split: [
      { id: 'one', description: 'First', acceptanceIndexes: [0] }, { id: 'two', description: 'Second', acceptanceIndexes: [0] },
    ] });
    await controller.tick(123);
  }
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.stored!.state.failures, policy.maxJobAttempts);
});

test('superseding a trusted-baseline amendment cannot remove its maintainer approval requirement', async () => {
  const { platform, controller } = await coding();
  platform.baselineSha = 'b'.repeat(40);
  platform.trustedChange = true;
  platform.reply('/sdlc amend Adopt the repaired trusted baseline.', 'maintainer');
  await controller.tick(123);
  platform.finish({ plan: 'Trusted-baseline amendment.' });
  await controller.tick(123);
  platform.reply('/sdlc amend Same baseline with different wording.');
  await controller.tick(123);
  assert.equal(platform.stored!.state.amendment!.version, 2);
  assert.equal(platform.stored!.state.amendment!.requiredMaintainer, true);
  platform.reply('/sdlc approve-amendment v2');
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'awaiting_amendment');
  platform.reply('/sdlc amend Replace the first proposal explicitly.', 'maintainer');
  await controller.tick(123);
  platform.finish({ plan: 'Replacement trusted-baseline amendment.' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.amendment!.requiredMaintainer, true);
  platform.reply('/sdlc revise Start a fresh plan.', 'maintainer');
  await controller.tick(123);
  platform.finish({ plan: 'Fresh full-revision plan.' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.plan!.version, 4);
  assert.equal(platform.stored!.state.branch, 'agentic/epic-123-v4');
});

test('authorized maintenance publication retries after a lost response without a second command', async () => {
  const { platform, controller } = await coding();
  platform.immutableTests = ['test/existing.test.ts'];
  platform.finish({ outcome: 'blocked', blocker: { category: 'baseline_defect', scope: 'repository', paths: platform.immutableTests,
    constraint: 'Immutable baseline', diagnostics: [], remedies: ['Propose repair'] } });
  await controller.tick(123);
  platform.finish({ maintenanceChanges: [{ path: platform.immutableTests[0]!, content: 'fixed' }] });
  await controller.tick(123);
  const recovery = platform.stored!.state.recoveries![0]!;
  platform.reply(`/sdlc propose-maintenance ${recovery.id} ${recovery.maintenance!.hash}`, 'maintainer');
  let calls = 0;
  platform.publishMaintenance = async () => {
    calls += 1;
    if (calls === 1) throw new Error('Lost publication response');
    return 127;
  };
  await assert.rejects(controller.tick(123), /Lost publication/);
  assert.equal(platform.stored!.state.recoveries![0]!.maintenanceAuthorization!.hash, recovery.maintenance!.hash);
  await controller.tick(123);
  assert.equal(platform.stored!.state.recoveries![0]!.maintenancePr, 127);
  await controller.tick(123);
  assert.equal(calls, 2);
});

test('approved execution splits run each step before marking the original task complete', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  await controller.tick(123, intake(platform));
  platform.finish({ plan: 'Implement both accepted outcomes', planPolicy: {
    allowTaskSplits: true, vendorSecurityPatches: [], dependencies: [],
  } });
  await controller.tick(123);
  platform.reply('/sdlc approve v1');
  await controller.tick(123);
  platform.finish({ tasks: [{ id: 'first', title: 'Feature', description: 'Implement feature',
    acceptance: ['Happy path works', 'Invalid input rejected'], dependsOn: [] }] });
  await controller.tick(123);
  platform.finish({ outcome: 'blocked', blocker: { category: 'incomplete_work', scope: 'task', paths: [],
    constraint: 'Task needs smaller execution steps', diagnostics: [], remedies: ['Split the same acceptance criteria'] }, split: [
    { id: 'happy-path', description: 'Implement happy path', acceptanceIndexes: [0] },
    { id: 'invalid-input', description: 'Implement invalid input rejection', acceptanceIndexes: [1] },
  ] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.stepId, 'happy-path');
  platform.finish({ changes: [{ path: 'apps/feature.js', content: 'happy path' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.tasks[0]!.completed, false);
  assert.equal(platform.stored!.state.job!.stepId, 'invalid-input');
  platform.finish({ changes: [{ path: 'apps/feature.js', content: 'both paths' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.tasks[0]!.completed, true);
  assert.equal(platform.stored!.state.tasks.length, 1);
  assert.equal(platform.stored!.state.job!.stage, 'scan');
});

test('legacy waiting and terminal lifecycles are migrated once without restarting work', async () => {
  for (const phase of ['awaiting_approval', 'paused', 'pr_open', 'merged', 'cancelled'] as const) {
    const { platform, controller } = await planned();
    const state = platform.stored!.state;
    delete state.usageHistory;
    delete state.planVersion;
    state.phase = phase;
    if (phase === 'pr_open') state.prNumber = 126;
    platform.raw = JSON.stringify({ ...state, schemaVersion: 1, spend: undefined });
    const version = Number(platform.version);
    const dispatched = platform.dispatched.length;
    await controller.tick(123);
    assert.deepEqual(platform.stored!.state, { ...state, spend: {
      runs: 0, runnerMs: 0, credits: 0, nearLimit: 0, preempted: 0, historyComplete: false,
    } });
    assert.match(platform.outputs.get('status')!, /Recorded cost \(earlier costs unavailable\)/);
    assert.equal(Number(platform.version), version + 1);
    await controller.tick(123);
    assert.equal(Number(platform.version), version + 1);
    assert.equal(platform.dispatched.length, dispatched);
    assert.equal(platform.published, 0);
  }
});

test('controller persists migration before PR effects and retries a failed state write', async () => {
  const { platform, controller } = await planned();
  const state = platform.stored!.state;
  delete state.usageHistory;
  delete state.planVersion;
  state.phase = 'pr_open';
  state.prNumber = 126;
  const legacy = JSON.stringify({ ...state, schemaVersion: 1, spend: undefined });
  platform.raw = legacy;
  platform.outputs.clear();
  let inspected = 0;
  platform.pullRequest = async () => { inspected += 1; return 'open'; };
  platform.saveFailure = new Error('Interrupted migration');
  await assert.rejects(controller.tick(123), /Interrupted migration/);
  assert.equal(platform.raw, legacy);
  assert.equal(inspected, 0);
  assert.equal(platform.outputs.size, 0);
  platform.saveFailure = undefined;
  await controller.tick(123);
  assert.equal(platform.stored!.state.schemaVersion, 2);
  assert.equal(inspected, 1);
  assert.equal(platform.published, 0);
});

test('migrating a legacy plan does not authorize an untrusted approval command', async () => {
  const { platform, controller } = await planned();
  const state = platform.stored!.state;
  delete state.usageHistory;
  delete state.planVersion;
  platform.raw = JSON.stringify({ ...state, schemaVersion: 1, spend: undefined });
  const dispatched = platform.dispatched.length;
  platform.reply('/sdlc approve v1', 'stranger');
  await controller.tick(123);
  assert.equal(platform.stored!.state.schemaVersion, 2);
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
  assert.equal(platform.stored!.state.approval, undefined);
  assert.deepEqual(platform.stored!.state.plan, state.plan);
  assert.equal(platform.dispatched.length, dispatched);
  assert.equal(platform.published, 0);
  assert.match(platform.outputs.get('comment:1')!, /only the requester or a repository maintainer/);
});

test('legacy migration cannot bypass the trusted-revision gate or accept an old job', async () => {
  const { platform, controller } = await coding();
  const state = platform.stored!.state;
  delete state.usageHistory;
  delete state.planVersion;
  const job = state.job!;
  platform.raw = JSON.stringify({ ...state, schemaVersion: 1, spend: undefined });
  platform.baselineSha = 'b'.repeat(40);
  platform.trustedChange = true;
  platform.runs.set(job.id, { id: 50, status: 'in_progress', conclusion: null, url: 'https://github.com/run/50' });
  const dispatched = platform.dispatched.length;
  await controller.tick(123);
  assert.equal(platform.stored!.state.schemaVersion, 2);
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.stored!.state.job, undefined);
  assert.equal(platform.stored!.state.controlSha, state.controlSha);
  assert.deepEqual(platform.stored!.state.approval, state.approval);
  assert.deepEqual(platform.cancelled, [50]);
  assert.match(platform.stored!.state.error!, /trusted revision changed/);
  platform.runs.set(job.id, { id: 50, status: 'completed', conclusion: 'success', url: 'https://github.com/run/50' });
  platform.reports.set(50, { jobId: job.id, inputSha: job.inputSha, outcome: 'pass', summary: 'Late result',
    changes: [{ path: 'feature.txt', content: 'Must not be applied' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.dispatched.length, dispatched);
  assert.equal(platform.changed, 0);
  assert.equal(platform.published, 0);
  assert.equal(platform.charged.filter(runId => runId === 50).length, 1);
  assert.equal(platform.stored!.state.spend.historyComplete, false);
  assert.equal(platform.stored!.state.pendingCosts, undefined);
});

test('controller entry point isolates corrupt state and migrates closed issues idempotently', () => {
  const legacy = { ...createLifecycle(1, 'requester', 'Feature', baseSha), phase: 'cancelled', schemaVersion: 1, spend: null };
  const valid = { ...createLifecycle(2, 'requester', 'Feature', baseSha), phase: 'cancelled', schemaVersion: 1, spend: undefined };
  const current = { ...createLifecycle(3, 'requester', 'Feature', baseSha), phase: 'merged' };
  const fixture = controllerProcessFixture({ 1: legacy, 2: valid, 3: current });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = fixture.execute();
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Issue #1:/);
      assert.match(result.stderr, /spend/);
      assert.doesNotMatch(result.stderr, /Unexpected|Issue #[23]:/);
      assert.match(result.stdout, /Reconciled issue #2/);
      assert.match(result.stdout, /Reconciled issue #3/);
      const saved = fixture.read();
      assert.deepEqual(saved.states['1'], legacy);
      assert.deepEqual(saved.states['2'], migrateLifecycle(JSON.parse(JSON.stringify(valid))));
      assert.deepEqual(saved.states['3'], current);
      assert.deepEqual(saved.writes, [
        'PUT /repos/owner/repo/contents/issues/2.json',
        'POST /repos/owner/repo/issues/2/comments', 'POST /repos/owner/repo/issues/3/comments',
      ]);
      assert.match(saved.comments['2'][0].body, /earlier costs unavailable/);
    }
    const selected = fixture.execute({ SDLC_ISSUE: '2' });
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.stdout.trim(), 'Reconciled issue #2');
    assert.equal(fixture.read().writes.length, 3);
  } finally { fixture.dispose(); }
});

test('controller entry point recovers a committed migration after losing its acknowledgement', () => {
  const legacy = { ...createLifecycle(1, 'requester', 'Feature', baseSha), phase: 'cancelled', schemaVersion: 1, spend: undefined };
  const fixture = controllerProcessFixture({ 1: legacy }, true);
  try {
    const interrupted = fixture.execute();
    assert.equal(interrupted.status, 1);
    assert.match(interrupted.stderr, /Lost migration acknowledgement/);
    const saved = fixture.read();
    assert.deepEqual(saved.states['1'], migrateLifecycle(JSON.parse(JSON.stringify(legacy))));
    assert.deepEqual(saved.writes, ['PUT /repos/owner/repo/contents/issues/1.json']);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recovered = fixture.execute();
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.deepEqual(fixture.read().states, saved.states);
      assert.deepEqual(fixture.read().writes, [
        'PUT /repos/owner/repo/contents/issues/1.json', 'POST /repos/owner/repo/issues/1/comments',
      ]);
    }
  } finally { fixture.dispose(); }
});

test('controller entry point rejects missing credentials and stale code before migration', () => {
  const legacy = { ...createLifecycle(1, 'requester', 'Feature', baseSha), phase: 'cancelled', schemaVersion: 1, spend: undefined };
  const fixture = controllerProcessFixture({ 1: legacy });
  try {
    const missing = fixture.execute({ GH_TOKEN: '' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /scoped GitHub App token is required/);
    assert.deepEqual(fixture.read().requests, []);
    const stale = fixture.execute({ GITHUB_SHA: 'b'.repeat(40) });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Controller revision is stale/);
    assert.deepEqual(fixture.read().requests, ['GET /repos/owner/repo', 'GET /repos/owner/repo/git/ref/heads/main']);
    assert.deepEqual(fixture.read().writes, []);
    assert.deepEqual(fixture.read().states, JSON.parse(JSON.stringify({ 1: legacy })));
  } finally { fixture.dispose(); }
});

test('controller entry point selects only the issue named by each supported event', () => {
  const states = Object.fromEntries([1, 2].map(number => [number, {
    ...createLifecycle(number, 'requester', 'Feature', baseSha), phase: 'cancelled', schemaVersion: 1, spend: undefined,
  }]));
  for (const event of [
    { workflow_run: { display_title: 'SDLC 2-7' } },
    { issue: { number: 2 } },
    { action: 'labeled', label: { name: policy.label }, sender: { login: 'maintainer', type: 'User' },
      issue: { number: 2, title: 'Feature', body: '', user: { login: 'requester' } } },
  ]) {
    const fixture = controllerProcessFixture(states);
    try {
      const result = fixture.execute({}, event);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'Reconciled issue #2');
      assert.deepEqual(fixture.read().states['1'], JSON.parse(JSON.stringify(states['1'])));
      assert.equal(fixture.read().states['2'].schemaVersion, 2);
      assert.deepEqual(fixture.read().writes, [
        'PUT /repos/owner/repo/contents/issues/2.json', 'POST /repos/owner/repo/issues/2/comments',
      ]);
    } finally { fixture.dispose(); }
  }
});

test('controller entry point ignores PR events before loading or migrating state', () => {
  const fixture = controllerProcessFixture({
    1: { ...createLifecycle(1, 'requester', 'Feature', baseSha), schemaVersion: 1, spend: undefined },
  });
  try {
    const result = fixture.execute({}, { issue: { number: 1, pull_request: {} } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(fixture.read().requests, ['GET /repos/owner/repo', 'GET /repos/owner/repo/git/ref/heads/main']);
    assert.deepEqual(fixture.read().writes, []);
    assert.equal(fixture.read().states['1'].schemaVersion, 1);
  } finally { fixture.dispose(); }
});

test('controller entry point rejects invalid issue selections without touching saved records', () => {
  const fixture = controllerProcessFixture({
    1: { ...createLifecycle(1, 'requester', 'Feature', baseSha), schemaVersion: 1, spend: undefined },
  });
  try {
    for (const issue of ['0', '-1', 'not-a-number', '9007199254740992']) {
      const result = fixture.execute({ SDLC_ISSUE: issue });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid issue number/);
      assert.deepEqual(fixture.read().writes, []);
      assert.equal(fixture.read().states['1'].schemaVersion, 1);
    }
  } finally { fixture.dispose(); }
});

test('label intake is authorized and duplicate events do not duplicate dispatch', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  await controller.tick(123);
  assert.equal(platform.stored, undefined);
  await controller.tick(123, intake(platform, 'stranger'));
  assert.equal(platform.stored, undefined);
  await controller.tick(123, intake(platform));
  await controller.tick(123);
  assert.equal(platform.dispatched.length, 1);
});

test('an issue edit after labeling cannot replace the authorized intake snapshot', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  const authorized = intake(platform);
  platform.input.body = 'Substituted scope';
  await controller.tick(123, authorized);
  assert.equal(platform.stored!.state.request, 'Feature\n\nImplement a feature');
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.dispatched.length, 0);
});

test('research stops for approval and only explicit authorized approval resumes', async () => {
  const { platform, controller } = await planned();
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
  platform.reply('/sdlc approve v1', 'stranger');
  await controller.tick(123);
  assert.equal(platform.dispatched.length, 1);
  platform.reply('/sdlc approve v1');
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.stage, 'decompose');
  await controller.tick(123);
  assert.equal(platform.dispatched.length, 2);
});

test('revision invalidates approval and rejects approval of the old version', async () => {
  const { platform, controller } = await planned();
  platform.reply('/sdlc revise Prefer a smaller implementation');
  await controller.tick(123);
  platform.finish({ plan: 'A smaller revised plan.' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.plan!.version, 2);
  platform.reply('/sdlc approve v1');
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
  assert.match(platform.outputs.get('comment:2')!, /stale/);
});

test('complete lifecycle rescans test changes and publishes exactly one final PR', async () => {
  const { platform, controller } = await coding();
  const firstJob = platform.stored!.state.job!;
  assert.equal(platform.stored!.state.job!.taskId, 'first');
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.taskId, 'second');
  const firstUsage = platform.stored!.state.usageHistory!.find(record => record.job.id === firstJob.id)!;
  assert.equal(firstUsage.job.inputSha, firstJob.inputSha);
  assert.equal(firstUsage.job.taskId, 'first');
  assert.deepEqual(firstUsage.acceptedResult, { outcome: 'pass', outputSha: platform.stored!.state.headSha });
  platform.finish({ changes: [{ path: 'feature.txt', content: 'Both tasks' }] });
  await controller.tick(123);
  for (const stage of ['scan', 'security']) {
    assert.equal(platform.stored!.state.job!.stage, stage);
    platform.finish();
    await controller.tick(123);
  }
  assert.equal(platform.stored!.state.job!.stage, 'test');
  platform.finish({ changes: [{ path: 'test/feature.test.ts', content: 'A real regression test' }] });
  await controller.tick(123);
  for (const stage of ['scan', 'security', 'validate', 'document', 'review']) {
    assert.equal(platform.published, 0);
    assert.equal(platform.stored!.state.job!.stage, stage);
    platform.finish();
    await controller.tick(123);
  }
  assert.equal(platform.published, 1);
  assert.equal(platform.stored!.state.phase, 'pr_open');
  const history = platform.stored!.state.usageHistory!;
  assert.deepEqual(history.map(record => record.job.stage),
    ['research', 'decompose', 'code', 'code', 'scan', 'security', 'test', 'scan', 'security', 'validate', 'document', 'review']);
  assert.ok(history.every(record => record.acceptedResult?.outcome === 'pass'));
  assert.equal(history.find(record => record.job.stage === 'scan')!.persona, null);
  assert.deepEqual(history.find(record => record.job.id === firstJob.id), firstUsage);
  await controller.tick(123);
  assert.equal(platform.published, 1);
  platform.disposition = 'merged';
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'merged');
  assert.equal(platform.closedTasks, 1);
  await controller.tick(123);
  assert.equal(platform.closedTasks, 1);
});

test('replanning retires old tasks and checkpoints the new scope before starting another worker', async () => {
  const { platform, controller } = await coding();
  platform.reply('/sdlc revise Use the smaller alternative');
  await controller.tick(123);
  assert.deepEqual(platform.retired.sort(), [124, 125]);
  assert.equal(platform.stored!.state.approval, undefined);
  assert.deepEqual(platform.stored!.state.tasks, []);
  assert.equal(platform.stored!.state.branch, 'agentic/epic-123-v2');
  assert.equal(platform.stored!.state.job!.stage, 'research');
});

test('security findings return to coding with a bounded repair loop', async () => {
  const { platform, controller } = await coding();
  platform.finish(); await controller.tick(123);
  platform.finish({ changes: [{ path: 'feature.txt', content: 'Feature' }] }); await controller.tick(123);
  for (let attempt = 0; attempt <= policy.maxRepairs; attempt += 1) {
    platform.finish({ outcome: 'changes_requested', summary: 'Fix the vulnerable dependency' }, 'failure');
    await controller.tick(123);
    if (attempt < policy.maxRepairs) {
      assert.equal(platform.stored!.state.job!.stage, 'code');
      platform.finish(); await controller.tick(123);
    }
  }
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.published, 0);
});

test('late review findings invalidate evidence and force every gate after a no-change repair', async () => {
  const { platform, controller } = await coding();
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  platform.finish({ changes: [{ path: 'feature.txt', content: 'Complete' }] });
  await controller.tick(123);
  for (const stage of ['scan', 'security', 'test', 'validate', 'document']) {
    assert.equal(platform.stored!.state.job!.stage, stage);
    platform.finish();
    await controller.tick(123);
  }
  assert.equal(platform.stored!.state.job!.stage, 'review');
  assert.deepEqual(platform.stored!.state.evidence.map(item => item.stage),
    ['scan', 'security', 'test', 'validate', 'document']);
  platform.finish({ outcome: 'changes_requested', summary: 'Repair the late review finding' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.stage, 'code');
  assert.deepEqual(platform.stored!.state.evidence, []);
  assert.equal(platform.published, 0);

  platform.finish();
  await controller.tick(123);
  const rerun: string[] = [];
  for (const stage of ['scan', 'security', 'test', 'validate', 'document', 'review']) {
    assert.equal(platform.stored!.state.job!.stage, stage);
    rerun.push(platform.stored!.state.job!.stage);
    platform.finish();
    await controller.tick(123);
    if (stage !== 'review') assert.equal(platform.published, 0);
  }
  assert.deepEqual(rerun, ['scan', 'security', 'test', 'validate', 'document', 'review']);
  assert.equal(platform.published, 1);
});

test('documentation changes invalidate gate evidence and re-verify before review', async () => {
  const { platform, controller } = await coding();
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  platform.finish({ changes: [{ path: 'feature.txt', content: 'Both tasks' }] });
  await controller.tick(123);
  for (const stage of ['scan', 'security', 'test', 'validate']) {
    assert.equal(platform.stored!.state.job!.stage, stage);
    platform.finish();
    await controller.tick(123);
  }
  assert.equal(platform.stored!.state.job!.stage, 'document');
  platform.finish({ changes: [{ path: 'docs/architecture.md', content: 'Documented behaviour' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'scanning');
  assert.deepEqual(platform.stored!.state.evidence.map(item => item.stage), ['document']);
  for (const stage of ['scan', 'security', 'test', 'validate', 'document']) {
    assert.equal(platform.stored!.state.job!.stage, stage);
    assert.equal(platform.published, 0);
    platform.finish();
    await controller.tick(123);
  }
  assert.equal(platform.stored!.state.job!.stage, 'review');
  platform.finish();
  await controller.tick(123);
  assert.equal(platform.published, 1);
});

test('every completed run is charged once, including one the credit limiter pre-empted', async () => {
  const { platform, controller } = await coding();
  const before = platform.stored!.state.spend;
  assert.ok(before.runs > 0, 'earlier stages must already be charged');

  const nearLimitCredits = policy.maxJobCredits * 0.95;
  const preemptedCredits = policy.maxJobCredits + 5;
  platform.costs = [{ runnerMs: 120_000, credits: nearLimitCredits, preempted: false }];
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.spend.nearLimit, 1);
  assert.equal(platform.stored!.state.spend.preempted, 0);

  platform.costs = [{ runnerMs: 30_000, credits: preemptedCredits, preempted: true }];
  platform.finish({ changes: [{ path: 'feature.txt', content: 'Both' }] });
  await controller.tick(123);
  const spend = platform.stored!.state.spend;
  assert.equal(spend.preempted, 1);
  assert.equal(spend.nearLimit, 1, 'a pre-empted run must not also count as near the limit');
  assert.equal(spend.credits, before.credits + nearLimitCredits + preemptedCredits);
  assert.equal(spend.runnerMs, before.runnerMs + 150_000);

  const charged = platform.charged.length;
  await controller.tick(123);
  assert.equal(platform.charged.length, charged, 'a run is charged once, not once per tick');
  assert.doesNotMatch(platform.outputs.get('status')!, /earlier costs unavailable/);
});

test('cancelled, paused, and superseded jobs settle costs after reload without accepting their results', async () => {
  for (const command of ['/sdlc cancel', '/sdlc pause', '/sdlc revise Use a smaller plan']) {
    const { platform } = await coding();
    const before = platform.stored!.state;
    const job = before.job!;
    const run = { id: 40, status: 'in_progress', conclusion: null, url: 'https://github.com/owner/repo/actions/runs/40' };
    platform.runs.set(job.id, run);
    platform.reply(command);
    await new Controller(platform, policy).tick(123);
    const interrupted = platform.stored!.state;
    assert.notEqual(interrupted.job?.id, job.id);
    assert.equal(interrupted.pendingCosts!.length, 1);
    assert.equal(interrupted.pendingCosts![0]!.job.inputSha, job.inputSha);
    assert.equal(interrupted.pendingCosts![0]!.job.controlSha, job.controlSha);
    assert.equal(interrupted.pendingCosts![0]!.job.planHash, job.planHash);
    assert.match(platform.outputs.get('status')!, /Pending cost collection: 1 job\(s\), excluded from these totals/);
    platform.runs.set(job.id, { ...run, status: 'completed', conclusion: 'success' });
    platform.reports.set(run.id, { jobId: job.id, inputSha: job.inputSha, outcome: 'pass', summary: 'Old work',
      changes: [{ path: 'feature.txt', content: 'Must never be accepted' }] });
    platform.costs = [{ runnerMs: 120_000, credits: 42, preempted: false, models: ['claude-sonnet-4.6'] }];
    platform.report = async () => { throw new Error('Accounting must never read old results'); };
    await new Controller(platform, policy).tick(123);
    const settled = platform.stored!.state;
    assert.deepEqual(settled.spend, { ...before.spend, runs: before.spend.runs + 1,
      runnerMs: before.spend.runnerMs + 120_000, credits: before.spend.credits + 42, models: ['claude-sonnet-4.6'] });
    assert.match(platform.outputs.get('status')!, /Observed agent models: `claude-sonnet-4\.6`/);
    assert.equal(settled.pendingCosts, undefined);
    assert.equal(settled.phase, interrupted.phase);
    assert.deepEqual(settled.job, interrupted.job);
    assert.deepEqual(settled.approval, interrupted.approval);
    assert.deepEqual(settled.evidence, interrupted.evidence);
    assert.equal(platform.changed, 0);
    assert.equal(platform.published, 0);
    const usage = settled.usageHistory!.find(record => record.job.id === job.id)!;
    assert.deepEqual(usage.job, { id: job.id, stage: job.stage, taskId: job.taskId, attempt: job.attempt,
      inputSha: job.inputSha, controlSha: job.controlSha, planHash: job.planHash, createdAt: job.createdAt, runId: run.id });
    assert.equal(usage.persona, 'sdlc-code');
    assert.deepEqual(usage.observed?.models, ['claude-sonnet-4.6']);
    assert.equal(usage.acceptedResult, undefined);
    await new Controller(platform, policy).tick(123);
    assert.deepEqual(platform.stored!.state.spend, settled.spend);
    assert.deepEqual(platform.stored!.state.usageHistory, settled.usageHistory);
    assert.equal(platform.charged.filter(runId => runId === run.id).length, 1);
  }
});

test('late receipts recover after a stage advances or its result retries, with exactly one tally update', async () => {
  for (const retryResult of [false, true]) {
    const { platform } = await coding();
    const before = platform.stored!.state;
    const job = before.job!;
    platform.finish();
    const run = platform.runs.get(job.id)!;
    platform.costs = [{ runnerMs: 60_000, credits: null, preempted: null, models: ['gpt-5.4'] }];
    if (retryResult) platform.reportFailure = new RetryablePlatformError('Result is not yet visible');
    const first = new Controller(platform, policy).tick(123);
    if (retryResult) await assert.rejects(first, /Result is not yet visible/);
    else await first;
    assert.deepEqual(platform.stored!.state.spend, before.spend);
    assert.equal(platform.stored!.state.pendingCosts!.length, 1);
    assert.equal(platform.stored!.state.job?.costedRun, undefined);
    platform.reportFailure = undefined;
    platform.costs = [{ runnerMs: 120_000, credits: 42, preempted: false, creditLimit: 50 }];
    await new Controller(platform, policy).tick(123);
    const settled = platform.stored!.state;
    assert.deepEqual(settled.spend, { ...before.spend, runs: before.spend.runs + 1,
      runnerMs: before.spend.runnerMs + 120_000, credits: before.spend.credits + 42, nearLimit: before.spend.nearLimit + 1,
      models: ['gpt-5.4'] });
    assert.match(platform.outputs.get('status')!, /Observed agent models: `gpt-5\.4`/);
    assert.equal(settled.pendingCosts, undefined);
    assert.notEqual(settled.job?.id, job.id);
    const usage = settled.usageHistory!.find(record => record.job.id === job.id)!;
    assert.equal(usage.persona, 'sdlc-code');
    assert.equal(usage.job.runId, run.id);
    assert.deepEqual(usage.observed?.models, ['gpt-5.4']);
    assert.deepEqual(usage.acceptedResult, { outcome: 'pass', outputSha: job.inputSha });
    await new Controller(platform, policy).tick(123);
    assert.deepEqual(platform.stored!.state.spend, settled.spend);
    assert.deepEqual(platform.stored!.state.usageHistory, settled.usageHistory);
    assert.equal(platform.charged.filter(runId => runId === run.id).length, 2);
  }
});

test('partial receipts preserve known measurements and original caps without repairing earlier history', async () => {
  for (const historyComplete of [true, false]) {
    const { platform } = await coding();
    platform.patch(state => { state.spend.historyComplete = historyComplete; });
    const before = platform.stored!.state.spend;
    platform.finish();
    platform.costs = [{ runnerMs: 60_000, credits: 200, preempted: null, creditLimit: 250 }];
    await new Controller(platform, policy).tick(123);
    assert.deepEqual(platform.stored!.state.spend, before);
    platform.costs = [{ runnerMs: 30_000, credits: null, preempted: false }];
    await new Controller(platform, { ...policy, maxJobCredits: 500 }).tick(123);
    assert.deepEqual(platform.stored!.state.spend, { ...before, runs: before.runs + 1,
      runnerMs: before.runnerMs + 60_000, credits: before.credits + 200, nearLimit: before.nearLimit + 1 });
    assert.equal(platform.stored!.state.pendingCosts, undefined);
  }
});

test('incomplete receipts expire at a fixed deadline and record only observed values once', async () => {
  for (const retryResult of [false, true]) for (const credits of [null, 37]) {
    const platform = new FakePlatform();
    let time = new Date('2026-09-14T12:00:00Z');
    const tick = () => new Controller(platform, policy, () => time).tick(123);
    await new Controller(platform, policy, () => time).tick(123, intake(platform));
    const job = platform.stored!.state.job!;
    const cost = { runnerMs: 60_000, credits, preempted: null, creditLimit: 250 };
    platform.costs = [cost, cost, cost];
    platform.finish({ plan: 'Implement the feature.' });
    if (retryResult) platform.reportFailure = new RetryablePlatformError('Result not ready');
    if (retryResult) await assert.rejects(tick(), /Result not ready/);
    else await tick();
    const expiresAt = platform.stored!.state.pendingCosts![0]!.expiresAt;
    time = new Date(expiresAt);
    if (retryResult) await assert.rejects(tick(), /Result not ready/);
    else await tick();
    assert.equal(platform.stored!.state.pendingCosts![0]!.expiresAt, expiresAt);
    assert.equal(platform.stored!.state.spend.runs, 0);
    time = new Date(time.getTime() + 1);
    platform.reportFailure = undefined;
    await tick();
    const state = platform.stored!.state;
    assert.equal(state.phase, 'awaiting_approval');
    assert.equal(state.pendingCosts, undefined);
    assert.deepEqual(state.spend, { runs: 1, runnerMs: 60_000, credits: credits ?? 0,
      nearLimit: 0, preempted: 0, historyComplete: false });
    assert.match(platform.outputs.get(`accounting:${job.id}`)!, /collection deadline/);
    assert.match(platform.outputs.get(`accounting:${job.id}`)!, /Missing telemetry is not measured zero/);
    await tick();
    assert.deepEqual(platform.stored!.state.spend, state.spend);
    assert.equal(platform.charged.length, 3);
  }
});

test('abandoned run discovery is bounded even on a closed issue', async () => {
  const platform = new FakePlatform();
  let time = new Date('2026-09-14T12:00:00Z');
  await new Controller(platform, policy, () => time).tick(123, intake(platform));
  const job = platform.stored!.state.job!;
  platform.reply('/sdlc cancel');
  await new Controller(platform, policy, () => time).tick(123);
  platform.input.open = false;
  const pending = platform.stored!.state.pendingCosts![0]!;
  assert.equal(pending.job.runId, undefined);
  time = new Date(Date.parse(pending.expiresAt) + 1);
  await new Controller(platform, policy, () => time).tick(123);
  const state = platform.stored!.state;
  assert.equal(state.phase, 'cancelled');
  assert.equal(state.job, undefined);
  assert.equal(state.pendingCosts, undefined);
  assert.equal(state.spend.historyComplete, false);
  assert.equal(state.spend.runs, 0);
  assert.equal(state.spend.credits, 0);
  assert.equal(platform.charged.length, 0);
  assert.match(platform.outputs.get(`accounting:${job.id}`)!, /Run: not discovered/);
  await new Controller(platform, policy, () => time).tick(123);
  assert.deepEqual(platform.stored!.state.spend, state.spend);
  assert.equal(platform.dispatched.length, 1);
});

test('pending costs settle before terminal and closed-issue returns without starting new work', async () => {
  for (const phase of ['cancelled', 'merged', 'pr_open'] as const) {
    const { platform } = await coding();
    const before = platform.stored!.state;
    const job = before.job!;
    platform.reply('/sdlc cancel');
    await new Controller(platform, policy).tick(123);
    platform.patch(state => { state.phase = phase; if (phase !== 'cancelled') state.prNumber = 126; });
    platform.input.open = false;
    platform.runs.set(job.id, { id: 40, status: 'completed', conclusion: 'cancelled',
      url: 'https://github.com/owner/repo/actions/runs/40' });
    const dispatches = platform.dispatched.length;
    platform.costs = [{ runnerMs: 30_000, credits: 17, preempted: true, creditLimit: 15 }];
    await new Controller(platform, policy).tick(123);
    assert.equal(platform.stored!.state.pendingCosts, undefined);
    assert.deepEqual(platform.stored!.state.spend, { ...before.spend, runs: before.spend.runs + 1,
      runnerMs: before.spend.runnerMs + 30_000, credits: before.spend.credits + 17, preempted: before.spend.preempted + 1 });
    assert.deepEqual(platform.stored!.state.evidence, before.evidence);
    assert.equal(platform.stored!.state.job, undefined);
    assert.equal(platform.dispatched.length, dispatches);
    assert.equal(platform.changed, 0);
    assert.equal(platform.published, 0);
  }
});

test('pending receipt failures retry independently of new work and permanently rejected receipts stop', async () => {
  for (const recover of [false, true]) {
    const platform = new FakePlatform();
    await new Controller(platform, policy).tick(123, intake(platform));
    const job = platform.stored!.state.job!;
    platform.costs = [{ runnerMs: 60_000, credits: null, preempted: null }];
    platform.finish({ plan: 'Implement the feature.' });
    await new Controller(platform, policy).tick(123);
    platform.costFailure = Object.assign(new Error('Telemetry service unavailable'), { status: 503 });
    platform.reply('/sdlc approve v1');
    await new Controller(platform, policy).tick(123);
    assert.equal(platform.stored!.state.phase, 'decomposing');
    assert.equal(platform.stored!.state.pendingCosts![0]!.job.id, job.id);
    assert.equal(platform.stored!.state.failures, 0);
    const active = platform.stored!.state.job!;
    platform.costFailure = recover ? undefined : Object.assign(new Error('Receipt download denied'), { status: 403 });
    platform.costs = [{ runnerMs: 120_000, credits: 42, preempted: false }];
    await new Controller(platform, policy).tick(123);
    const state = platform.stored!.state;
    assert.deepEqual(state.job, active);
    assert.equal(state.pendingCosts, undefined);
    assert.equal(state.spend.runs, 1);
    assert.equal(state.spend.credits, recover ? 42 : 0);
    assert.equal(state.spend.historyComplete, recover);
    assert.equal(state.failures, 0);
    if (!recover) assert.match(platform.outputs.get(`accounting:${job.id}`)!, /Receipt download denied/);
    await new Controller(platform, policy).tick(123);
    assert.deepEqual(platform.stored!.state.spend, state.spend);
    assert.equal(platform.charged.length, 3);
  }
});

test('pending settlement survives rejected state writes and lost committed acknowledgements without double charging', async () => {
  for (const committed of [false, true]) {
    const platform = new FakePlatform();
    await new Controller(platform, policy).tick(123, intake(platform));
    platform.costs = [{ runnerMs: 60_000, credits: null, preempted: null }];
    platform.finish({ plan: 'Implement the feature.' });
    await new Controller(platform, policy).tick(123);
    const cost = { runnerMs: 120_000, credits: 42, preempted: false, creditLimit: 50, models: ['gpt-5.4'] };
    platform.costs = [cost, cost];
    const save = platform.save.bind(platform);
    let interrupted = false;
    platform.save = async record => {
      if (!interrupted && record.state.spend.runs === 1) {
        interrupted = true;
        if (committed) await save(record);
        throw Object.assign(new Error('Settlement write interrupted'), { status: committed ? 503 : 409 });
      }
      await save(record);
    };
    await assert.rejects(new Controller(platform, policy).tick(123), /Settlement write interrupted/);
    assert.equal(platform.stored!.state.spend.runs, committed ? 1 : 0);
    assert.equal(platform.stored!.state.pendingCosts?.length ?? 0, committed ? 0 : 1);
    assert.equal(platform.stored!.state.usageHistory?.length ?? 0, committed ? 1 : 0);
    await new Controller(platform, policy).tick(123);
    const state = platform.stored!.state;
    assert.equal(state.pendingCosts, undefined);
    assert.deepEqual(state.spend, { runs: 1, runnerMs: 120_000, credits: 42,
      nearLimit: 1, preempted: 0, historyComplete: true, models: ['gpt-5.4'] });
    assert.equal(state.usageHistory!.length, 1);
    assert.equal(state.usageHistory![0]!.persona, 'sdlc-research');
    assert.deepEqual(state.usageHistory![0]!.observed, cost);
    await new Controller(platform, policy).tick(123);
    assert.deepEqual(platform.stored!.state.spend, state.spend);
    assert.deepEqual(platform.stored!.state.usageHistory, state.usageHistory);
    assert.equal(platform.charged.length, committed ? 2 : 3);
  }
});

test('failed interruption saves retain active authority and retry before cancellation or accounting effects', async () => {
  const { platform } = await coding();
  const before = platform.stored!.state;
  const job = before.job!;
  const run = { id: 40, status: 'in_progress', conclusion: null, url: 'https://github.com/owner/repo/actions/runs/40' };
  platform.runs.set(job.id, run);
  platform.reply('/sdlc pause');
  platform.saveFailure = Object.assign(new Error('Interruption save conflict'), { status: 409 });
  await assert.rejects(new Controller(platform, policy).tick(123), /Interruption save conflict/);
  assert.deepEqual(platform.stored!.state, before);
  assert.deepEqual(platform.cancelled, []);
  platform.saveFailure = undefined;
  await new Controller(platform, policy).tick(123);
  assert.equal(platform.stored!.state.job, undefined);
  assert.equal(platform.stored!.state.pendingCosts![0]!.job.id, job.id);
  assert.deepEqual(platform.cancelled, [40]);
  platform.runs.set(job.id, { ...run, status: 'completed', conclusion: 'cancelled' });
  await new Controller(platform, policy).tick(123);
  assert.equal(platform.stored!.state.spend.runs, before.spend.runs + 1);
  assert.equal(platform.stored!.state.phase, 'paused');
});

test('near-limit accounting uses the run receipt even after the configured budget changes', async () => {
  const { platform, controller } = await coding();
  platform.costs = [{ runnerMs: 60_000, credits: 300, preempted: false, creditLimit: 500 }];
  platform.finish();
  await controller.tick(123);
  assert.equal(platform.stored!.state.spend.nearLimit, 0);
  platform.costs = [{ runnerMs: 60_000, credits: 80, preempted: false, creditLimit: 100 }];
  platform.finish();
  platform.reportFailure = new RetryablePlatformError('Try later');
  await assert.rejects(controller.tick(123), /Try later/);
  await assert.rejects(controller.tick(123), /Try later/);
  assert.equal(platform.stored!.state.spend.nearLimit, 1);
  assert.match(platform.outputs.get('status')!, /Current per-job limit: 250 AI credits/);
});

test('controller entry point resolves the credit override and rejects invalid limits before API calls', () => {
  const state = { ...createLifecycle(1, 'requester', 'Feature', baseSha), phase: 'merged' };
  for (const value of ['', '500', '0', '-1', '10001', 'not-a-number']) {
    const fixture = controllerProcessFixture({ 1: state });
    try {
      const result = fixture.execute({ SDLC_AIC_CREDIT_LIMIT: value });
      if (value === '' || value === '500') {
        assert.equal(result.status, 0, result.stderr);
        assert.ok(fixture.read().comments['1'][0].body.includes(`Current per-job limit: ${value || '250'} AI credits`));
      } else {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /SDLC_AIC_CREDIT_LIMIT/);
        assert.deepEqual(fixture.read().requests, []);
      }
    } finally { fixture.dispose(); }
  }
});

test('failed Security attempts surface current checkpoints without accepting any review evidence', async () => {
  for (const outcome of ['blocked', 'pass'] as const) {
    const { platform, controller } = await coding();
    for (let completion = 0; completion < 3; completion += 1) { platform.finish(); await controller.tick(123); }
    const job = platform.stored!.state.job!;
    assert.equal(job.stage, 'security');
    platform.costs = [{ runnerMs: 60_000, credits: 252, preempted: true, creditLimit: 250 }];
    platform.finish({ outcome, summary: 'Injection checks reviewed. Authorization checks still pending.' }, 'failure');
    await controller.tick(123);
    const diagnostic = [...platform.outputs.values()].find(message => message.includes('### Worker attempt diagnostics'))!;
    assert.match(diagnostic, /Stage: \*\*security\*\*/);
    assert.ok(diagnostic.includes(job.inputSha));
    assert.ok(diagnostic.includes(job.controlSha));
    assert.ok(diagnostic.includes(job.planHash!));
    assert.match(diagnostic, /Measured usage: 252\.0 AI credits/);
    assert.match(diagnostic, /Pre-emption: reported by the workflow/);
    assert.match(diagnostic, /untrusted diagnostic only, not accepted evidence/);
    assert.match(diagnostic, /Authorization checks still pending/);
    assert.equal(platform.stored!.state.evidence.some(item => item.stage === 'security'), false);
    assert.equal(platform.stored!.state.phase, 'security');
    assert.equal(platform.published, 0);
  }
});

test('failed Security attempts discard stale checkpoints and identify unknown usage', async () => {
  for (const invalid of [
    { inputSha: 'f'.repeat(40) }, { jobId: '123-999' }, { changes: [{ path: 'feature.txt', content: 'Unauthorized' }] },
  ]) {
    const { platform, controller } = await coding();
    for (let completion = 0; completion < 3; completion += 1) { platform.finish(); await controller.tick(123); }
    const credits = platform.stored!.state.spend.credits;
    platform.costs = [{ runnerMs: 60_000, credits: null, preempted: null }];
    platform.finish({ ...invalid, summary: 'Invalid report must not be shown' }, 'failure');
    await controller.tick(123);
    const diagnostic = [...platform.outputs.values()].find(message => message.includes('### Worker attempt diagnostics'))!;
    assert.match(diagnostic, /Measured usage: unavailable/);
    assert.match(diagnostic, /Pre-emption: unknown/);
    assert.match(diagnostic, /No valid current-job Security checkpoint/);
    assert.doesNotMatch(diagnostic, /Invalid report must not be shown/);
    assert.equal(platform.stored!.state.spend.credits, credits);
    assert.equal(platform.stored!.state.pendingCosts!.length, 1);
    assert.equal(platform.stored!.state.spend.preempted, 0);
    assert.equal(platform.stored!.state.evidence.some(item => item.stage === 'security'), false);
    assert.equal(platform.changed, 0);
  }
});

test('retrying diagnostic publication never duplicates the attempt record or its cost', async () => {
  const { platform, controller } = await coding();
  for (let completion = 0; completion < 3; completion += 1) { platform.finish(); await controller.tick(123); }
  const before = platform.stored!.state.spend;
  const cost = { runnerMs: 60_000, credits: 252, preempted: true, creditLimit: 250 };
  platform.costs = [cost, cost];
  platform.finish({ outcome: 'blocked', summary: 'Authorization checks pending.' }, 'failure');
  const comment = platform.comment.bind(platform);
  let interrupted = true;
  platform.comment = async (number, key, body) => {
    await comment(number, key, body);
    if (key.startsWith('attempt:') && interrupted) { interrupted = false; throw new Error('Lost comment acknowledgement'); }
  };
  await assert.rejects(controller.tick(123), /Lost comment acknowledgement/);
  assert.deepEqual(platform.stored!.state.spend, before);
  await controller.tick(123);
  assert.equal(platform.stored!.state.spend.runs, before.runs + 1);
  assert.equal(platform.stored!.state.spend.credits, before.credits + 252);
  assert.equal(platform.stored!.state.spend.preempted, before.preempted + 1);
  assert.equal([...platform.outputs.keys()].filter(key => key.startsWith('attempt:')).length, 1);
  assert.equal(platform.stored!.state.evidence.some(item => item.stage === 'security'), false);
});

test('an unfinished Security checkpoint blocks even when its workflow concludes successfully', async () => {
  const { platform, controller } = await coding();
  for (let completion = 0; completion < 3; completion += 1) { platform.finish(); await controller.tick(123); }
  const evidence = platform.stored!.state.evidence;
  platform.finish({ outcome: 'blocked', summary: 'Security review incomplete. Authorization checks pending.' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.stored!.state.resumePhase, 'security');
  assert.deepEqual(platform.stored!.state.evidence, evidence);
  assert.match(platform.outputs.get('status')!, /Security review incomplete/);
  assert.equal(platform.published, 0);
});

test('missing pre-emption signals do not classify a run as confirmed near-limit', async () => {
  const { platform, controller } = await coding();
  platform.costs = [{ runnerMs: 60_000, credits: 249, preempted: null, creditLimit: 250 }];
  platform.finish();
  await controller.tick(123);
  assert.equal(platform.stored!.state.spend.nearLimit, 0);
  assert.equal(platform.stored!.state.spend.preempted, 0);
  assert.match([...platform.outputs.values()].find(message => message.includes('### Worker attempt diagnostics'))!,
    /Pre-emption: unknown/);
});

test('migrated in-flight jobs preserve cost history and charge each run only once across retries', async () => {
  for (const measured of [false, true]) {
    const { platform, controller } = await coding();
    const charged = platform.charged.length;
    platform.costs = [{ runnerMs: 45_000, credits: 33, preempted: false }];
    platform.finish();
    platform.reportFailure = new RetryablePlatformError('Artifact not yet available');
    if (measured) await assert.rejects(controller.tick(123), error => error === platform.reportFailure);
    const state = platform.stored!.state;
    platform.raw = JSON.stringify({ ...state, schemaVersion: 1, usageHistory: undefined, planVersion: undefined,
      spend: measured ? { ...state.spend, historyComplete: undefined } : undefined });
    const expected = measured ? state.spend : {
      runs: 1, runnerMs: 45_000, credits: 33, nearLimit: 0, preempted: 0, historyComplete: false,
    };
    await assert.rejects(controller.tick(123), error => error === platform.reportFailure);
    await assert.rejects(controller.tick(123), error => error === platform.reportFailure);
    assert.deepEqual(platform.stored!.state.spend, expected);
    assert.equal(platform.charged.length, charged + 1);
    assert.equal(platform.outputs.get('status')!.includes('earlier costs unavailable'), !measured);
    platform.reportFailure = undefined;
    await controller.tick(123);
    assert.deepEqual(platform.stored!.state.spend, expected);
    assert.equal(platform.charged.length, charged + 1);
    platform.reply('/sdlc revise Prefer a smaller change');
    await controller.tick(123);
    assert.deepEqual(platform.stored!.state.spend, expected);
  }
});

test('a rejected result still consumes budget', async () => {
  const { platform, controller } = await coding();
  const before = platform.stored!.state.spend.credits;
  platform.costs = [{ runnerMs: 45_000, credits: 33, preempted: false }];
  platform.finish({ jobId: '123-999' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.spend.credits, before + 33);
  assert.equal(platform.stored!.state.usageHistory!.at(-1)!.acceptedResult, undefined);
});

test('pause discards in-flight results; only a maintainer can resume', async () => {
  const { platform, controller } = await coding();
  const job = platform.stored!.state.job!;
  platform.runs.set(job.id, { id: 20, status: 'in_progress', conclusion: null, url: 'https://github.com/run/20' });
  platform.reply('/sdlc pause');
  await controller.tick(123);
  assert.equal(platform.stored!.state.job, undefined);
  assert.deepEqual(platform.cancelled, [20]);
  platform.reply('/sdlc resume'); await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'paused');
  platform.reply('/sdlc resume', 'maintainer'); await controller.tick(123);
  assert.notEqual(platform.stored!.state.job!.id, job.id);
});

test('issue edits and trusted revision drift stop execution until replanning', async () => {
  const first = await coding();
  first.platform.input.body = 'Changed scope';
  await first.controller.tick(123);
  assert.equal(first.platform.stored!.state.phase, 'blocked');
  const second = await coding();
  second.platform.baselineSha = 'f'.repeat(40);
  second.platform.trustedChange = true;
  await second.controller.tick(123);
  assert.equal(second.platform.stored!.state.phase, 'blocked');
});

test('default branch movement outside trusted paths is adopted instead of blocking', async () => {
  const { platform, controller } = await coding();
  const moved = 'f'.repeat(40);
  platform.baselineSha = moved;
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  const state = platform.stored!.state;
  assert.notEqual(state.phase, 'blocked');
  assert.equal(state.controlSha, moved);
  assert.equal(state.job!.controlSha, moved);
});

test('approval pins the plan to the revision it is approved against', async () => {
  const moved = 'f'.repeat(40);
  const adopted = await planned();
  adopted.platform.baselineSha = moved;
  adopted.platform.reply('/sdlc approve v1');
  await adopted.controller.tick(123);
  const state = adopted.platform.stored!.state;
  assert.equal(state.phase, 'decomposing');
  assert.equal(state.baseSha, moved);
  assert.equal(state.headSha, moved);
  assert.equal(state.controlSha, moved);

  const rejected = await planned();
  rejected.platform.baselineSha = moved;
  rejected.platform.trustedChange = true;
  rejected.platform.reply('/sdlc approve v1');
  await rejected.controller.tick(123);
  assert.equal(rejected.platform.stored!.state.phase, 'awaiting_approval');
  assert.match([...rejected.platform.outputs.values()].join('\n'), /trusted revision changed/);
});

test('untrusted worker output cannot publish policy changes or skip stages', async () => {
  const { platform, controller } = await coding();
  platform.finish({ changes: [{ path: '.github/workflows/ci.yml', content: 'skip tests' }] });
  await controller.tick(123);
  assert.equal(platform.changed, 0);
  assert.equal(platform.stored!.state.job!.stage, 'code');
  platform.finish({ jobId: '123-999' }); await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
});

test('cancelling or removing the intake label stops future work', async () => {
  const { platform, controller } = await coding();
  platform.input.labeled = false;
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'cancelled');
  assert.equal(platform.stored!.state.job, undefined);
});

test('job budget prevents an endless run even after successful agents', async () => {
  const { platform } = await planned();
  platform.reply('/sdlc approve v1');
  await new Controller(platform, { ...policy, maxJobs: 1 }).tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
});

test('closing the feature PR persists cancellation without marking tasks complete', async () => {
  const { platform, controller } = await planned();
  platform.patch(state => { state.phase = 'pr_open'; state.prNumber = 126; });
  platform.disposition = 'closed';
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'cancelled');
  assert.equal(platform.closedTasks, 0);
  assert.match(platform.outputs.get('status')!, /cancelled/);
});

test('lost dispatches reuse their job identity and stop after bounded attempts', async () => {
  const platform = new FakePlatform();
  let time = new Date('2026-09-08T12:00:00Z');
  const controller = new Controller(platform, policy, () => time);
  await controller.tick(123, intake(platform));
  const first = platform.stored!.state.job!.id;
  time = new Date(time.getTime() + policy.dispatchGraceMinutes * 60_000 + 1);
  await controller.tick(123);
  assert.equal(platform.dispatched.length, 2);
  assert.equal(platform.dispatched[1]!.id, first);
  time = new Date(time.getTime() + policy.dispatchGraceMinutes * 60_000 + 1);
  await controller.tick(123);
  assert.notEqual(platform.stored!.state.job!.id, first);
  time = new Date(time.getTime() + policy.dispatchGraceMinutes * 60_000 + 1);
  await controller.tick(123);
  time = new Date(time.getTime() + policy.dispatchGraceMinutes * 60_000 + 1);
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.dispatched.length, 4);
});

test('a lost dispatch response recovers the remote run without dispatching again', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  const failure = Object.assign(new Error('Dispatch response lost'), { status: 503 });
  platform.dispatchFailure = failure;
  await assert.rejects(controller.tick(123, intake(platform)), error => error === failure);
  const job = platform.stored!.state.job!;
  assert.ok(job.dispatchedAt);
  assert.equal(platform.dispatched.length, 1);

  platform.dispatchFailure = undefined;
  platform.runs.set(job.id, { id: 42, status: 'in_progress', conclusion: null,
    url: 'https://github.com/owner/repo/actions/runs/42' });
  await controller.tick(123);
  assert.equal(platform.dispatched.length, 1);
  assert.equal(platform.stored!.state.job!.id, job.id);
  assert.equal(platform.stored!.state.job!.runId, 42);
});

test('timed-out workers are cancelled and replaced within the infrastructure budget', async () => {
  const platform = new FakePlatform();
  let time = new Date('2026-09-08T12:00:00Z');
  const controller = new Controller(platform, policy, () => time);
  await controller.tick(123, intake(platform));
  const first = platform.stored!.state.job!.id;
  platform.runs.set(first, { id: 20, status: 'in_progress', conclusion: null, url: 'https://github.com/run/20' });
  time = new Date(time.getTime() + policy.jobTimeoutMinutes * 60_000 + 1);
  await controller.tick(123);
  assert.deepEqual(platform.cancelled, [20]);
  assert.notEqual(platform.stored!.state.job!.id, first);
  assert.equal(platform.stored!.state.failures, 1);
});

test('failed cancellation cannot revive a durably interrupted job', async () => {
  const { platform, controller } = await coding();
  const job = platform.stored!.state.job!;
  platform.runs.set(job.id, { id: 20, status: 'in_progress', conclusion: null,
    url: 'https://github.com/owner/repo/actions/runs/20' });
  const failure = Object.assign(new Error('Cancellation unavailable'), { status: 503 });
  platform.cancelFailure = failure;
  platform.reply('/sdlc pause');
  await assert.rejects(controller.tick(123), error => error === failure);
  assert.equal(platform.stored!.state.phase, 'paused');
  assert.equal(platform.stored!.state.job, undefined);
  assert.deepEqual(platform.cancelled, [20]);

  platform.cancelFailure = undefined;
  platform.runs.set(job.id, { id: 20, status: 'completed', conclusion: 'success',
    url: 'https://github.com/owner/repo/actions/runs/20' });
  const dispatches = platform.dispatched.length;
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'paused');
  assert.equal(platform.stored!.state.job, undefined);
  assert.equal(platform.dispatched.length, dispatches);
});

test('invalid cost receipts and denied downloads exhaust bounded attempts without accepting results', async () => {
  const invalid = costSchema.safeParse({ credits: -1, preempted: false });
  assert.ok(!invalid.success);
  for (const failure of [invalid.error, Object.assign(new Error('Cost download denied'), { status: 403 })]) {
    const { platform, controller } = await coding();
    for (let completion = 0; completion < 3; completion += 1) { platform.finish(); await controller.tick(123); }
    const before = platform.stored!.state;
    assert.equal(before.job!.stage, 'security');
    platform.costFailure = failure;
    let reportReads = 0;
    platform.report = async () => { reportReads += 1; throw new Error('Result must not be read'); };
    for (let attempt = 1; attempt <= policy.maxJobAttempts; attempt += 1) {
      const job = platform.stored!.state.job!;
      platform.finish({ outcome: 'pass', summary: 'Review claims success' });
      const run = platform.runs.get(job.id)!;
      await controller.tick(123);
      const state = platform.stored!.state;
      assert.equal(state.failures, attempt);
      assert.notEqual(state.job?.id, job.id);
      assert.deepEqual(state.spend, { ...before.spend, historyComplete: false });
      assert.deepEqual(state.evidence, before.evidence);
      assert.deepEqual(state.approval, before.approval);
      assert.equal(state.repairs, before.repairs);
      assert.ok(state.error!.includes(`Cost receipt for security job ${job.id} was rejected`));
      assert.ok(state.error!.includes(run.url));
      assert.match(state.error!, /credits|Cost download denied/);
    }
    const state = platform.stored!.state;
    assert.equal(state.phase, 'blocked');
    assert.equal(state.resumePhase, 'security');
    assert.equal(state.job, undefined);
    const requests = platform.charged.length;
    await controller.tick(123);
    assert.equal(platform.charged.length, requests);
    assert.equal(platform.stored!.state.failures, policy.maxJobAttempts);
    assert.match(platform.outputs.get('status')!, /Cost receipt for security job/);
    assert.equal(reportReads, 0);
    assert.equal(platform.changed, 0);
    assert.equal(platform.published, 0);
  }
});

test('transient cost errors preserve the registered job and recover without double charging', async () => {
  for (const failure of [
    new RetryablePlatformError('Cost artifact not yet available'),
    Object.assign(new Error('Cost artifact not ready'), { status: 404 }),
    Object.assign(new Error('Cost service unavailable'), { status: 503 }),
    Object.assign(new Error('Cost rate limited'), { status: 403, response: { headers: { 'retry-after': '60' } } }),
    Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
  ]) {
    const platform = new FakePlatform();
    const controller = new Controller(platform, policy, () => new Date('2026-09-14T12:00:00Z'));
    await controller.tick(123, intake(platform));
    platform.finish({ plan: 'Implement the feature.' });
    const job = platform.stored!.state.job!;
    const before = platform.stored!.state.spend;
    platform.costFailure = failure;
    await assert.rejects(controller.tick(123), error => error === failure);
    assert.equal(platform.stored!.state.job!.id, job.id);
    assert.equal(platform.stored!.state.job!.costedRun, undefined);
    assert.equal(platform.stored!.state.failures, 0);
    assert.deepEqual(platform.stored!.state.spend, before);
    platform.costFailure = undefined;
    platform.costs = [{ runnerMs: 120_000, credits: 42, preempted: false, creditLimit: 250 }];
    await controller.tick(123);
    assert.equal(platform.stored!.state.phase, 'awaiting_approval');
    assert.deepEqual(platform.stored!.state.spend, {
      runs: 1, runnerMs: 120_000, credits: 42, nearLimit: 0, preempted: 0, historyComplete: true,
    });
    const requests = platform.charged.length;
    await controller.tick(123);
    assert.equal(platform.charged.length, requests);
    assert.equal(platform.stored!.state.spend.runs, 1);
  }
});

test('persistent cost errors consume bounded failures after the job deadline', async () => {
  const platform = new FakePlatform();
  let time = new Date('2026-09-14T12:00:00Z');
  const controller = new Controller(platform, policy, () => time);
  await controller.tick(123, intake(platform));
  const failure = Object.assign(new Error('Cost service unavailable'), { status: 503 });
  platform.costFailure = failure;
  for (let attempt = 1; attempt <= policy.maxJobAttempts; attempt += 1) {
    const job = platform.stored!.state.job!;
    platform.finish({ plan: 'Must not be accepted without the cost receipt.' });
    time = new Date(Date.parse(job.createdAt) + policy.jobTimeoutMinutes * 60_000);
    await assert.rejects(controller.tick(123), error => error === failure);
    assert.equal(platform.stored!.state.job!.id, job.id);
    assert.equal(platform.stored!.state.failures, attempt - 1);
    time = new Date(time.getTime() + 1);
    await controller.tick(123);
    assert.notEqual(platform.stored!.state.job?.id, job.id);
    assert.equal(platform.stored!.state.failures, attempt);
    assert.match(platform.stored!.state.error!, /Cost receipt for research job .* remained unavailable past the job timeout/);
    assert.equal(platform.stored!.state.plan, undefined);
    assert.equal(platform.stored!.state.spend.runs, 0);
    assert.equal(platform.stored!.state.spend.historyComplete, false);
  }
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.stored!.state.resumePhase, 'researching');
  assert.equal(platform.stored!.state.job, undefined);
});

test('transient artifact errors preserve the completed job for a later retry', async () => {
  const failures = [
    new RetryablePlatformError('Artifact not visible yet'),
    Object.assign(new Error('Artifact not ready'), { status: 404 }),
    Object.assign(new Error('Request timeout'), { status: 408 }),
    Object.assign(new Error('Rate limited'), { status: 429 }),
    Object.assign(new Error('Secondary rate limit'), { status: 403,
      response: { headers: { 'retry-after': '60' } } }),
    Object.assign(new Error('Artifact service unavailable'), { status: 503 }),
    Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
  ];
  for (const failure of failures) {
    const platform = new FakePlatform();
    const controller = new Controller(platform, policy);
    await controller.tick(123, intake(platform));
    platform.finish({ plan: 'Implement the feature.' });
    const jobId = platform.stored!.state.job!.id;
    platform.reportFailure = failure;
    await assert.rejects(controller.tick(123), error => error === failure);
    assert.equal(platform.stored!.state.job!.id, jobId);
    assert.equal(platform.stored!.state.failures, 0);
    platform.reportFailure = undefined;
    await controller.tick(123);
    assert.equal(platform.stored!.state.phase, 'awaiting_approval');
  }
});

test('persistent artifact errors consume one infrastructure failure after the job timeout', async () => {
  const platform = new FakePlatform();
  let time = new Date('2026-09-08T12:00:00Z');
  const controller = new Controller(platform, policy, () => time);
  await controller.tick(123, intake(platform));
  platform.finish({ plan: 'Implement the feature.' });
  const jobId = platform.stored!.state.job!.id;
  platform.reportFailure = Object.assign(new Error('Artifact service unavailable'), { status: 503 });
  time = new Date(time.getTime() + policy.jobTimeoutMinutes * 60_000 + 1);
  await controller.tick(123);
  assert.notEqual(platform.stored!.state.job!.id, jobId);
  assert.equal(platform.stored!.state.failures, 1);
});

test('surrounding whitespace in the issue and plan survives persistence', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  platform.input.body = 'Implement a feature\n';
  await controller.tick(123, intake(platform));
  platform.finish({ plan: '## Plan\n\nImplement the feature with regression coverage.\n' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
  platform.reply('/sdlc approve v1');
  await controller.tick(123);
  assert.equal(platform.outputs.get('comment:1'), undefined);
  assert.equal(platform.stored!.state.phase, 'decomposing');
});

test('rejected commands always explain themselves to the commenter', async () => {
  const { platform, controller } = await planned();
  platform.reply('/sdlc approve v1', 'stranger');
  await controller.tick(123);
  assert.match(platform.outputs.get('comment:1')!, /only the requester or a repository maintainer/);
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
});

test('an open feature PR rejects further commands instead of ignoring them', async () => {
  const { platform, controller } = await planned();
  platform.patch(state => { state.phase = 'pr_open'; state.prNumber = 126; });
  platform.reply('/sdlc cancel');
  await controller.tick(123);
  assert.match(platform.outputs.get('comment:1')!, /pull request #126 is open/);
  assert.match(platform.outputs.get('status')!, /no longer accepts/);
  assert.equal(platform.stored!.state.phase, 'pr_open');
});

test('processed command events do not accumulate beyond the surviving comments', async () => {
  const { platform, controller } = await planned();
  platform.reply('/sdlc pause');
  await controller.tick(123);
  assert.deepEqual(platform.stored!.state.processedEvents, ['comment:1']);
  platform.messages = [{ id: 7, body: '/sdlc resume', actor: 'maintainer', human: true, createdAt: '2026-09-08T12:00:00Z' }];
  await controller.tick(123);
  assert.deepEqual(platform.stored!.state.processedEvents, ['comment:7']);
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
});

test('task issues are linked once rather than on every reconciliation', async () => {
  const { platform, controller } = await coding();
  assert.equal(platform.linked, 1);
  assert.equal(platform.stored!.state.tasksLinked, true);
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.taskId, 'second');
  assert.equal(platform.linked, 1);
});