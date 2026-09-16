import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Octokit } from '@octokit/rest';
import { strToU8, zipSync } from 'fflate';
import { GitHub, decodeCostArchive, decodeReportArchive, neutralizeClosingKeywords } from '../src/github.ts';
import { Controller, RetryablePlatformError } from '../src/controller.ts';
import { policySchema } from '../src/contracts.ts';
import { createLifecycle, startJob } from '../src/lifecycle.ts';
import { approvePlan, digest, makePlan } from '../src/domain.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const baseSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);

function api(handler: (method: string, path: string, body: Record<string, unknown>) => unknown) {
  return new Octokit({ request: { fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const result = handler(init?.method ?? 'GET', decodeURIComponent(url.pathname), init?.body ? JSON.parse(String(init.body)) : {});
    const response = result instanceof Response ? result :
      new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  } } });
}

function active() {
  const state = createLifecycle(123, 'requester', 'Feature', baseSha);
  state.plan = makePlan('Approved plan', 0);
  state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
    authorized: true, actor: 'requester', commentId: 1, at: '2026-09-08T12:00:00Z' });
  state.phase = 'coding';
  state.feedback = 'Implement the accepted repair';
  const job = startJob(state, 'code', '2026-09-08T12:00:00Z');
  return { state, job };
}

function publishable() {
  const { state } = active();
  state.phase = 'publishing';
  state.job = undefined;
  state.headSha = newSha;
  state.tasks = [{ id: 'feature', title: 'Feature', description: 'Feature', acceptance: ['Works'], dependsOn: [], completed: true }];
  state.evidence = ['scan', 'security', 'test', 'validate', 'document', 'review'].map(stage => ({
    stage: stage as 'scan' | 'security' | 'test' | 'validate' | 'review', sha: newSha,
    jobId: `123-${stage}`, runId: 1, summary: 'Verified',
  }));
  return state;
}

test('artifact decoding accepts only the bounded result file and a strict schema', () => {
  const report = { jobId: '123-1', inputSha: baseSha, outcome: 'pass', summary: 'Done', changes: [] };
  assert.deepEqual(decodeReportArchive(zipSync({ 'result.json': strToU8(JSON.stringify(report)) })), report);
  assert.throws(() => decodeReportArchive(zipSync({ '../result.json': strToU8('{}') })), /Missing/);
  assert.throws(() => decodeReportArchive(new Uint8Array(2_000_001)), /size/);
  assert.throws(() => decodeReportArchive(zipSync({ 'result.json': strToU8('{"outcome":"pass"}') })));
});

test('untrusted Markdown cannot preserve issue-closing directives', () => {
  const sanitized = neutralizeClosingKeywords([
    'Closes #1', '\\`Fixes owner/repo#2', '`Resolved` #3', '`Closes #4`',
    '`Closes #5', 'resolve https://github.com/owner/repo/issues/6', 'Fixed\n#7', 'Discusses #8',
  ].join('\n'));
  assert.equal(sanitized, [
    'Closes issue #1', '\\`Fixes issue owner/repo#2', '`Resolved` #3', '`Closes issue #4`',
    '`Closes issue #5', 'resolve issue https://github.com/owner/repo/issues/6', 'Fixed issue\n#7', 'Discusses #8',
  ].join('\n'));
});

test('state writes carry the prior content SHA for compare-and-swap', async () => {
  const { state } = active();
  let written: Record<string, unknown> | undefined;
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path, body) => {
    if (path.includes('/git/ref/')) return { object: { sha: baseSha } };
    assert.equal(method, 'PUT');
    written = body;
    return { content: { sha: newSha } };
  }));
  const record = { state, version: baseSha };
  await github.save(record);
  assert.equal(written?.sha, baseSha);
  assert.equal(written?.branch, 'sdlc-state');
  assert.equal(record.version, newSha);
});

test('legacy state loads read-only and round-trips with the original concurrency token', async () => {
  for (const spend of [undefined, { runs: 2, runnerMs: 120_000, credits: 21.5, nearLimit: 1, preempted: 0 }]) {
    const { state, job } = active();
    job.runId = 7;
    if (spend) job.costedRun = 7;
    let stored = JSON.stringify({ ...state, schemaVersion: 1, spend });
    const original = stored;
    let version = baseSha;
    let writes = 0;
    const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path, body) => {
      if (path.includes('/git/ref/')) return { object: { sha: baseSha } };
      if (method === 'GET') return {
        type: 'file', sha: version, size: stored.length, content: Buffer.from(stored).toString('base64'),
      };
      assert.equal(method, 'PUT');
      if (body.sha !== version) return new Response('{"message":"State write conflict"}', { status: 409 });
      assert.equal(body.branch, 'sdlc-state');
      stored = Buffer.from(String(body.content), 'base64').toString('utf8');
      version = newSha;
      writes += 1;
      return { content: { sha: version } };
    }));
    const record = (await github.load(123))!;
    const stale = (await github.load(123))!;
    assert.equal(record.needsMigration, true);
    assert.equal(record.version, baseSha);
    assert.equal(record.state.spend.historyComplete, spend !== undefined);
    assert.deepEqual(record.state.job, state.job);
    assert.equal(stored, original);
    assert.equal(writes, 0);
    await github.save(record);
    assert.equal(record.needsMigration, undefined);
    assert.equal(record.version, newSha);
    assert.deepEqual(JSON.parse(stored), record.state);
    const reloaded = (await github.load(123))!;
    assert.equal(reloaded.needsMigration, false);
    assert.deepEqual(reloaded.state, record.state);
    await assert.rejects(github.save(stale), /State write conflict/);
    assert.equal(stale.needsMigration, true);
    assert.equal(writes, 1);
    assert.deepEqual((await github.load(123))!.state, record.state);
  }
});

test('controller and real GitHub adapter migrate open PR state once without unrelated writes', async () => {
  for (const spend of [undefined, { runs: 4, runnerMs: 234_000, credits: 312.5, nearLimit: 1, preempted: 1 }]) {
    const state = publishable();
    state.phase = 'pr_open';
    state.prNumber = 126;
    let stored = JSON.stringify({ ...state, schemaVersion: 1, spend });
    let version = baseSha;
    const mutations: string[] = [];
    const comments = [{ id: 99, body: '<!-- sdlc:status -->\nOld status',
      user: { login: 'sdlc[bot]', type: 'Bot' }, created_at: '2026-09-08T12:00:00Z', updated_at: '2026-09-08T12:00:00Z' }];
    const client = api((method, path, body) => {
      if (method !== 'GET') mutations.push(`${method} ${path}`);
      if (method === 'GET' && path === '/repos/owner/repo/issues/123') return {
        title: 'Feature', body: '', user: { login: 'requester' }, state: 'open', labels: [policy.label],
      };
      if (method === 'GET' && path === '/repos/owner/repo/contents/issues/123.json') return {
        type: 'file', sha: version, size: Buffer.byteLength(stored), content: Buffer.from(stored).toString('base64'),
      };
      if (method === 'GET' && path === '/repos/owner/repo/git/ref/heads/sdlc-state') return { object: { sha: baseSha } };
      if (method === 'PUT' && path === '/repos/owner/repo/contents/issues/123.json') {
        assert.equal(body.sha, version);
        assert.equal(body.branch, 'sdlc-state');
        stored = Buffer.from(String(body.content), 'base64').toString('utf8');
        version = newSha;
        return { content: { sha: version } };
      }
      if (method === 'GET' && path === '/repos/owner/repo/pulls/126') {
        assert.equal(JSON.parse(stored).schemaVersion, 2);
        return { state: 'open', merged: false };
      }
      if (method === 'GET' && path === '/repos/owner/repo/issues/123/comments') return comments;
      if (method === 'PATCH' && path === '/repos/owner/repo/issues/comments/99') {
        comments[0]!.body = String(body.body);
        return comments[0];
      }
      throw new Error(`Unexpected migration side effect: ${method} ${path}`);
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Controller(new GitHub('owner/repo', policy, 'sdlc[bot]', client), policy).tick(123);
      assert.deepEqual(JSON.parse(stored), JSON.parse(JSON.stringify({ ...state,
        spend: spend ? { ...spend, historyComplete: true } : { ...state.spend, historyComplete: false },
      })));
      assert.deepEqual(mutations, [
        'PUT /repos/owner/repo/contents/issues/123.json', 'PATCH /repos/owner/repo/issues/comments/99',
      ]);
      assert.equal(comments[0]!.body.includes('earlier costs unavailable'), spend === undefined);
    }
  }
});

test('invalid or mismatched legacy records stop the real controller before any write', async () => {
  const state = { ...publishable(), phase: 'pr_open', prNumber: 126, schemaVersion: 1, spend: undefined };
  for (const stored of [
    { ...state, spend: null },
    { ...state, spend: {} },
    { ...state, schemaVersion: 3 },
    { ...state, bypass: true },
    { ...state, issueNumber: 124 },
    { ...state, branch: 'agentic/epic-124-v1' },
  ]) {
    const requests: string[] = [];
    const serialized = JSON.stringify(stored);
    const client = api((method, path) => {
      requests.push(`${method} ${path}`);
      if (method === 'GET' && path === '/repos/owner/repo/issues/123') return {
        title: 'Feature', body: '', user: { login: 'requester' }, state: 'open', labels: [policy.label],
      };
      if (method === 'GET' && path === '/repos/owner/repo/contents/issues/123.json') return {
        type: 'file', sha: baseSha, size: serialized.length, content: Buffer.from(serialized).toString('base64'),
      };
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    await assert.rejects(new Controller(new GitHub('owner/repo', policy, 'sdlc[bot]', client), policy).tick(123),
      /spend|schemaVersion|Unrecognized key|identity/);
    assert.deepEqual(requests, ['GET /repos/owner/repo/issues/123', 'GET /repos/owner/repo/contents/issues/123.json']);
    assert.equal(JSON.stringify(stored), serialized);
  }
});

test('denied or conflicting migration writes stop the real controller before PR or comment effects', async () => {
  for (const status of [403, 409]) {
    const state = { ...publishable(), phase: 'pr_open', prNumber: 126, schemaVersion: 1, spend: undefined };
    const serialized = JSON.stringify(state);
    const requests: string[] = [];
    const client = api((method, path, body) => {
      requests.push(`${method} ${path}`);
      if (method === 'GET' && path === '/repos/owner/repo/issues/123') return {
        title: 'Feature', body: '', user: { login: 'requester' }, state: 'open', labels: [policy.label],
      };
      if (method === 'GET' && path === '/repos/owner/repo/contents/issues/123.json') return {
        type: 'file', sha: baseSha, size: serialized.length, content: Buffer.from(serialized).toString('base64'),
      };
      if (method === 'GET' && path === '/repos/owner/repo/git/ref/heads/sdlc-state') return { object: { sha: baseSha } };
      if (method === 'PUT' && path === '/repos/owner/repo/contents/issues/123.json') {
        assert.equal(body.sha, baseSha);
        assert.equal(body.branch, 'sdlc-state');
        return new Response('{"message":"Migration write rejected"}', { status });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    await assert.rejects(new Controller(new GitHub('owner/repo', policy, 'sdlc[bot]', client), policy).tick(123),
      error => error instanceof Error && 'status' in error && error.status === status);
    assert.deepEqual(requests, [
      'GET /repos/owner/repo/issues/123', 'GET /repos/owner/repo/contents/issues/123.json',
      'GET /repos/owner/repo/git/ref/heads/sdlc-state', 'PUT /repos/owner/repo/contents/issues/123.json',
    ]);
    assert.equal(JSON.stringify(state), serialized);
  }
});

test('interrupted migration writes recover without losing state or remigrating committed data', async () => {
  for (const afterCommit of [false, true]) {
    const { state } = active();
    let stored = JSON.stringify({ ...state, schemaVersion: 1, spend: undefined });
    let version = baseSha;
    let interrupt = true;
    let writes = 0;
    const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path, body) => {
      if (path.includes('/git/ref/')) return { object: { sha: baseSha } };
      if (method === 'GET') return {
        type: 'file', sha: version, size: stored.length, content: Buffer.from(stored).toString('base64'),
      };
      assert.equal(body.sha, version);
      if (interrupt && !afterCommit) { interrupt = false; throw new Error('Interrupted migration'); }
      stored = Buffer.from(String(body.content), 'base64').toString('utf8');
      version = newSha;
      writes += 1;
      if (interrupt) { interrupt = false; throw new Error('Interrupted migration'); }
      return { content: { sha: version } };
    }));
    const record = (await github.load(123))!;
    await assert.rejects(github.save(record), /Interrupted migration/);
    assert.equal(record.needsMigration, true);
    assert.equal(record.version, baseSha);
    const recovered = (await github.load(123))!;
    assert.equal(recovered.needsMigration, !afterCommit);
    assert.deepEqual(recovered.state, record.state);
    if (recovered.needsMigration) await github.save(recovered);
    assert.equal(writes, 1);
    assert.equal((await github.load(123))!.needsMigration, false);
  }
});

test('worker discovery rejects runs from other actors, commits, or reruns', async () => {
  const { job } = active();
  const valid = { id: 3, display_title: `SDLC ${job.id}`, head_sha: baseSha, actor: { login: 'sdlc[bot]' },
    run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/run/3' };
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api(() => ({ total_count: 4, workflow_runs: [
    { ...valid, id: 1, actor: { login: 'stranger' } },
    { ...valid, id: 2, head_sha: newSha }, valid, { ...valid, id: 4, run_attempt: 2 },
  ] })));
  assert.equal((await github.findRun(job))?.id, 3);
});

test('failed check workflows need a successful trusted result job before their artifacts are accepted', async () => {
  const { job } = active();
  job.stage = 'scan';
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api(() => ({ total_count: 1,
    jobs: [{ name: 'SDLC Check Result', conclusion: 'failure' }],
  })));
  await assert.rejects(github.report({ id: 1, status: 'completed', conclusion: 'failure', url: 'https://github.com/run/1' }, job), /trusted check-result/);
});

test('completed runs remain retryable while their result artifact is not yet visible', async () => {
  const { job } = active();
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api(() => ({ total_count: 0, artifacts: [] })));
  await assert.rejects(github.report({ id: 1, status: 'completed', conclusion: 'success', url: 'https://github.com/run/1' }, job),
    error => error instanceof RetryablePlatformError);
});

test('cost sums job durations and reads the workflow-written budget outcome', async () => {
  const { job } = active();
  const listJobs = () => undefined;
  const listArtifacts = () => undefined;
  const jobs = [
    { started_at: '2026-09-11T15:39:40Z', completed_at: '2026-09-11T15:40:24Z' },
    { started_at: '2026-09-11T15:40:28Z', completed_at: '2026-09-11T15:44:15Z' },
    { started_at: null, completed_at: '2026-09-11T15:44:19Z' },
    { started_at: '2026-09-11T15:46:23Z', completed_at: '2026-09-11T15:46:00Z' },
  ];
  const build = (artifacts: unknown[], archive: Uint8Array) => new GitHub('owner/repo', policy, 'sdlc[bot]', {
    actions: {
      listJobsForWorkflowRun: listJobs, listWorkflowRunArtifacts: listArtifacts,
      downloadArtifact: async () => ({ data: archive }),
    },
    paginate: async (route: unknown) => (route === listJobs ? jobs : artifacts),
  } as unknown as Octokit);
  const run = { id: 1, status: 'completed' as const, conclusion: 'success', url: 'https://github.com/run/1' };
  const archive = zipSync({ 'cost.json': strToU8('{"credits":50.8,"preempted":true}') });

  // 44s plus 227s; the unstarted and negative-duration jobs contribute nothing.
  assert.deepEqual(await build([{ id: 9, name: 'sdlc-cost', expired: false, size_in_bytes: 90 }], archive).cost(run, job),
    { runnerMs: 271_000, credits: 50.8, preempted: true });
  const configured = zipSync({ 'cost.json': strToU8('{"credits":50.8,"preempted":true,"creditLimit":500}') });
  assert.deepEqual(await build([{ id: 9, name: 'sdlc-cost', expired: false, size_in_bytes: 120 }], configured).cost(run, job),
    { runnerMs: 271_000, credits: 50.8, preempted: true, creditLimit: 500 });
  const measured = { credits: 50.8, preempted: true, creditLimit: 500, models: ['claude-sonnet-4.6', 'gpt-5.4'] };
  const modelArchive = zipSync({ 'cost.json': strToU8(JSON.stringify(measured)) });
  assert.deepEqual(await build([{ id: 9, name: 'sdlc-cost', expired: false, size_in_bytes: 200 }], modelArchive).cost(run, job),
    { runnerMs: 271_000, ...measured });
  for (const artifacts of [[], [{ id: 9, name: 'sdlc-cost', expired: true, size_in_bytes: 90 }],
    [{ id: 9, name: 'sdlc-cost', expired: false, size_in_bytes: 20_000 }]]) {
    assert.deepEqual(await build(artifacts, archive).cost(run, job), { runnerMs: 271_000, credits: null, preempted: null });
  }
  for (const stage of ['scan', 'validate'] as const) {
    assert.deepEqual(await build([], archive).cost(run, { ...job, stage }), { runnerMs: 271_000, credits: 0, preempted: false });
  }
  assert.throws(() => decodeCostArchive(zipSync({ 'other.json': strToU8('{}') })), /Missing/);
  assert.throws(() => decodeCostArchive(zipSync({ 'cost.json': strToU8('{"credits":-1,"preempted":false}') })));
});

test('artifact discovery consumes the complete paginated result set', async () => {
  const { job } = active();
  const listArtifacts = () => undefined;
  const report = { jobId: job.id, inputSha: job.inputSha, outcome: 'pass', summary: 'Done', changes: [] };
  let downloads = 0;
  let artifacts = [{ id: 9, name: 'sdlc-result', expired: false, size_in_bytes: 100 }];
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', {
    actions: {
      listWorkflowRunArtifacts: listArtifacts,
      downloadArtifact: async () => { downloads += 1; return { data: zipSync({ 'result.json': strToU8(JSON.stringify(report)) }) }; },
    },
    paginate: async (route: unknown) => {
      assert.equal(route, listArtifacts);
      return artifacts;
    },
  } as unknown as Octokit);
  assert.deepEqual(await github.report({ id: 1, status: 'completed', conclusion: 'success', url: 'https://github.com/run/1' }, job), report);
  assert.equal(downloads, 1);
  artifacts = [...artifacts, { id: 10, name: 'sdlc-result', expired: false, size_in_bytes: 100 }];
  await assert.rejects(github.report({ id: 1, status: 'completed', conclusion: 'success', url: 'https://github.com/run/1' }, job),
    /Duplicate/);
  assert.equal(downloads, 1);
});

test('a commit already published before a crash is recovered without writing again', async () => {
  const { state, job } = active();
  const changes = [{ path: 'feature.txt', content: 'Feature' }];
  const blob = createHash('sha1').update('blob 7\0Feature').digest('hex');
  const unchanged = { path: 'unchanged.txt', mode: '100644', type: 'blob', sha: 'f'.repeat(40) };
  let published = [{ path: 'feature.txt', mode: '100644', type: 'blob', sha: blob }, unchanged];
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path) => {
    assert.equal(method, 'GET');
    if (path.includes('/git/ref/')) return { object: { sha: newSha } };
    if (path.includes('/git/commits/')) return {
      message: `SDLC ${job.id} ${digest(changes)}`, parents: [{ sha: baseSha }],
      tree: { sha: path.endsWith(newSha) ? 'd'.repeat(40) : 'c'.repeat(40) },
    };
    return { truncated: false, tree: path.endsWith('d'.repeat(40)) ? published : [unchanged] };
  }));
  assert.equal(await github.applyChanges(state, job, changes), newSha);
  for (const divergent of [
    [{ path: 'feature.txt', mode: '100644', type: 'blob', sha: 'e'.repeat(40) }, unchanged],
    [{ path: 'feature.txt', mode: '100644', type: 'blob', sha: blob },
      unchanged, { path: 'extra.txt', mode: '100644', type: 'blob', sha: 'e'.repeat(40) }],
    [{ path: 'feature.txt', mode: '100644', type: 'blob', sha: blob }],
    [{ path: 'feature.txt', mode: '100644', type: 'blob', sha: blob },
      { ...unchanged, sha: 'e'.repeat(40) }],
    [{ path: 'feature.txt', mode: '100755', type: 'blob', sha: blob }, unchanged],
  ]) {
    published = divergent;
    await assert.rejects(github.applyChanges(state, job, changes), /Published tree/);
  }
});

test('publisher refuses to update a working branch that moves after commit creation', async () => {
  const { state, job } = active();
  let refReads = 0;
  let updates = 0;
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path) => {
    if (path.includes('/git/ref/')) {
      refReads += 1;
      return { object: { sha: refReads === 1 ? baseSha : newSha } };
    }
    if (method === 'GET' && path.includes('/git/commits/')) return { tree: { sha: 'c'.repeat(40) } };
    if (method === 'GET' && path.includes('/git/trees/')) return { truncated: false, tree: [] };
    if (method === 'POST' && path.endsWith('/git/trees')) return { sha: 'd'.repeat(40) };
    if (method === 'POST' && path.endsWith('/git/commits')) return { sha: 'e'.repeat(40) };
    if (method === 'PATCH') updates += 1;
    return {};
  }));
  await assert.rejects(github.applyChanges(state, job, [{ path: 'feature.txt', content: 'Feature' }]),
    /Working branch moved/);
  assert.equal(refReads, 2);
  assert.equal(updates, 0);
});

test('publisher preserves baseline tests and refuses symlink ancestors', async () => {
  const { state, job } = active();
  for (const path of ['test/domain.test.ts', 'linked/file.ts']) {
    const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, route) => {
      assert.equal(method, 'GET');
      if (route.includes('/git/ref/')) return { object: { sha: baseSha } };
      if (route.includes('/git/commits/')) return { tree: { sha: 'c'.repeat(40) } };
      return { truncated: false, tree: [
        { path: 'test/domain.test.ts', type: 'blob', mode: '100644', sha: baseSha },
        { path: 'linked', type: 'blob', mode: '120000', sha: baseSha },
      ] };
    }));
    await assert.rejects(github.applyChanges(state, job, [{ path, content: 'Changed' }]), /immutable|ancestor/);
  }
});

test('publisher rejects additions whose ancestor casing differs from the source tree', async () => {
  const { state, job } = active();
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, route) => {
    assert.equal(method, 'GET');
    if (route.includes('/git/ref/')) return { object: { sha: baseSha } };
    if (route.includes('/git/commits/')) return { tree: { sha: 'c'.repeat(40) } };
    return { truncated: false, tree: [
      { path: 'lib', type: 'tree', mode: '040000', sha: baseSha },
      { path: 'lib/existing.txt', type: 'blob', mode: '100644', sha: baseSha },
    ] };
  }));
  await assert.rejects(github.applyChanges(state, job, [
    { path: 'Lib/new.txt', content: 'New' },
  ]), /different casing/);
});

test('publisher applies a validated tree to only the working branch without force', async () => {
  const { state, job } = active();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path, body) => {
    if (method !== 'GET') writes.push({ path, body });
    if (path.includes('/git/ref/')) return { object: { sha: baseSha } };
    if (path.includes('/git/commits/') && method === 'GET') return { tree: { sha: 'c'.repeat(40) } };
    if (method === 'GET') return { truncated: false, tree: [] };
    return { sha: newSha };
  }));
  assert.equal(await github.applyChanges(state, job, [{ path: 'feature.txt', content: 'Feature' }]), newSha);
  const update = writes.at(-1)!;
  assert.match(update.path, /refs\/heads\/agentic\/epic-123-v1$/);
  assert.equal(update.body.force, false);
  assert.equal(writes[0]!.body.base_tree, 'c'.repeat(40));
});

test('paginated comments, task markers, and links prevent duplicate side effects', async () => {
  const { state } = active();
  const dependency: typeof state.tasks[number] = {
    id: 'first', title: 'First', description: 'First', acceptance: ['Works'], dependsOn: [], issueNumber: 124, completed: false,
  };
  const dependent: typeof state.tasks[number] = {
    id: 'second', title: 'Second', description: 'Second', acceptance: ['Works'], dependsOn: ['first'], issueNumber: 125, completed: false,
  };
  state.tasks = [dependency, dependent];
  const taskMarker = `<!-- sdlc:task:${state.issueNumber}:${state.plan!.hash}:${dependency.id} -->`;
  const listComments = () => undefined;
  const listForRepo = () => undefined;
  let updates = 0;
  let creates = 0;
  let requests = 0;
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', {
    issues: {
      listComments,
      listForRepo,
      updateComment: async () => { updates += 1; return { data: {} }; },
      createComment: async () => { creates += 1; return { data: {} }; },
      create: async () => { creates += 1; throw new Error('Task should have been reused'); },
      get: async () => { throw new Error('Dependency should have been reused'); },
    },
    paginate: async (route: unknown) => {
      if (route === listComments) return [{ id: 1, body: '<!-- sdlc:status -->\nOld',
        user: { login: 'sdlc[bot]', type: 'Bot' }, created_at: '2026-09-08T12:00:00Z', updated_at: '2026-09-08T12:00:00Z' }];
      if (route === listForRepo) return [{ id: 99, number: 124, body: `${taskMarker}\nTask`, user: { login: 'sdlc[bot]' } }];
      if (String(route).endsWith('/sub_issues')) return [{ id: 99, number: 124 }];
      if (String(route).endsWith('/dependencies/blocked_by')) return [{ number: 124 }];
      throw new Error(`Unexpected pagination route: ${String(route)}`);
    },
    request: async () => { requests += 1; return { data: {} }; },
  } as unknown as Octokit);
  await github.comment(123, 'status', 'New');
  assert.equal(await github.task(state, dependency), 124);
  await github.linkTasks(state);
  assert.equal(updates, 1);
  assert.equal(creates, 0);
  assert.equal(requests, 0);
});

test('publication inspects every PR page and reuses later owned side effects', async () => {
  const state = publishable();
  const listPulls = () => { throw new Error('Direct one-page PR lookup is forbidden'); };
  const listReviews = () => undefined;
  const listChecks = () => undefined;
  let pullCreates = 0;
  let reviewCreates = 0;
  let checkCreates = 0;
  const marker = `<!-- sdlc:feature:${state.issueNumber}:${state.plan!.hash} -->`;
  const reviewMarker = `<!-- sdlc:review:${state.headSha} -->`;
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', {
    git: { getRef: async () => ({ data: { object: { sha: newSha } } }) },
    pulls: {
      list: listPulls,
      create: async () => { pullCreates += 1; throw new Error('PR should have been reused'); },
      listReviews,
      createReview: async () => { reviewCreates += 1; return { data: {} }; },
    },
    checks: { listForRef: listChecks, create: async () => { checkCreates += 1; return { data: {} }; } },
    paginate: async (route: unknown) => {
      if (route === listPulls) return [{ number: 126, state: 'open', body: `${marker}\nExisting`, user: { login: 'sdlc[bot]' } }];
      if (route === listReviews) return [{ body: `${reviewMarker}\nExisting`, user: { login: 'sdlc[bot]' } }];
      if (route === listChecks) return [{ conclusion: 'success', app: { slug: 'sdlc' } }];
      throw new Error('Unexpected pagination route');
    },
  } as unknown as Octokit);
  assert.equal(await github.publish(state), 126);
  assert.equal(pullCreates, 0);
  assert.equal(reviewCreates, 0);
  assert.equal(checkCreates, 0);
});

test('an unrelated pull request found by pagination blocks publication', async () => {
  const state = publishable();
  const listPulls = () => { throw new Error('Direct one-page PR lookup is forbidden'); };
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', {
    git: { getRef: async () => ({ data: { object: { sha: newSha } } }) },
    pulls: { list: listPulls },
    paginate: async (route: unknown) => {
      assert.equal(route, listPulls);
      return [{ number: 200, state: 'open', body: 'Unrelated', user: { login: 'someone' } }];
    },
  } as unknown as Octokit);
  await assert.rejects(github.publish(state), /unrelated pull request/);
});

test('final PR, advisory review, and commit check are idempotent and reference the reviewed SHA', async () => {
  const state = publishable();
  state.spend.models = ['claude-sonnet-4.6', 'gpt-5.4'];
  state.plan = makePlan('Approved plan. Fixes #455.', 0);
  state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
    authorized: true, actor: 'requester', commentId: 1, at: '2026-09-08T12:00:00Z' });
  state.evidence = ['scan', 'security', 'test', 'validate', 'document', 'review'].map(stage => ({
    stage: stage as 'scan' | 'security' | 'test' | 'validate' | 'review', sha: newSha,
    jobId: `123-${stage}`, runId: 1, summary: 'Verified. Closes owner/repo#456.',
  }));
  state.pendingCosts = [{ job: { id: '123-9', stage: 'code', inputSha: baseSha, controlSha: baseSha,
    planHash: state.plan.hash, createdAt: '2026-09-08T12:00:00Z' }, expiresAt: '2026-09-08T13:30:00Z' }];
  const pulls: Record<string, unknown>[] = [];
  const reviews: Record<string, unknown>[] = [];
  const checks: Record<string, unknown>[] = [];
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path, body) => {
    if (path.includes('/git/ref/')) return { object: { sha: newSha } };
    if (path.endsWith('/issues/123')) return { title: 'Feature', body: 'Request', user: { login: 'requester' }, state: 'open', labels: [] };
    if (path.endsWith('/pulls')) {
      if (method === 'GET') return pulls;
      pulls.push({ ...body, number: 126, state: 'open', user: { login: 'sdlc[bot]' } });
      return { number: 126 };
    }
    if (path.endsWith('/reviews')) {
      if (method === 'GET') return reviews;
      reviews.push({ ...body, user: { login: 'sdlc[bot]' } });
      return { id: 1 };
    }
    if (path.endsWith('/check-runs')) {
      if (method === 'GET') return { total_count: checks.length, check_runs: checks };
      checks.push({ ...body, app: { slug: 'sdlc' } });
      return { id: 1 };
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  }));
  assert.equal(await github.publish(state), 126);
  const snapshot = String(pulls[0]!.body);
  delete state.pendingCosts;
  state.spend.credits += 42;
  state.spend.models.push('later-observed-model');
  const changedConfiguration = new GitHub('owner/repo', { ...policy, maxJobCredits: 575 },
    'sdlc[bot]', github.api, 'later-model');
  assert.equal(await changedConfiguration.publish(state), 126);
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0]!.head, state.branch);
  assert.equal(pulls[0]!.base, 'main');
  assert.equal(pulls[0]!.draft, false);
  assert.match(String(pulls[0]!.body), /Closes #123/);
  assert.match(String(pulls[0]!.body), /Fixes issue #455/);
  assert.match(String(pulls[0]!.body), /Closes issue owner\/repo#456/);
  assert.doesNotMatch(String(pulls[0]!.body), /earlier costs unavailable/);
  const cost = String(pulls[0]!.body).split('## Cost\n\n')[1]!.split('\n\n## Evidence')[0]!;
  assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(cost)![1]!), {
    SDLC_MODEL: 'auto', SDLC_AIC_CREDIT_LIMIT: 250,
  });
  assert.match(cost, /Configuration at PR creation/);
  assert.match(cost, /not a resolved per-run model/);
  assert.match(cost, /each inference job, not each turn/);
  assert.match(cost, /earlier runs may have used different settings/);
  assert.match(cost, /Observed agent models:\*\* `claude-sonnet-4\.6`, `gpt-5\.4`/);
  assert.match(cost, /Multiple models may be observed, including with auto selection/);
  assert.match(cost, /Missing\/legacy runs and separate detection inference are not covered/);
  assert.match(cost, /not a billing breakdown/);
  assert.doesNotMatch(cost, /later-observed-model/);
  assert.match(cost, /Cost snapshot at PR creation/);
  assert.match(cost, /Pending cost collection:\*\* 1 job\(s\) are excluded from these totals/);
  assert.match(cost, /https:\/\/github.com\/owner\/repo\/issues\/123/);
  assert.equal(String(pulls[0]!.body), snapshot, 'Later costs and configuration cannot rewrite the original PR snapshot');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.event, 'COMMENT');
  assert.equal(reviews[0]!.commit_id, newSha);
  assert.match(String(reviews[0]!.body), /Closes issue owner\/repo#456/);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.head_sha, newSha);
  pulls[0]!.state = 'closed';
  await assert.rejects(github.publish(state), /already closed/);
});

test('new PRs distinguish partial cost totals from the full lifecycle cost', async () => {
  const state = publishable();
  state.spend = { runs: 2, runnerMs: 120_000, credits: 12.5, nearLimit: 0, preempted: 0, historyComplete: false };
  let description = '';
  const github = new GitHub('owner/repo', { ...policy, maxJobCredits: 575 }, 'sdlc[bot]', api((method, path, body) => {
    if (path.includes('/git/ref/')) return { object: { sha: newSha } };
    if (path.endsWith('/issues/123')) return { title: 'Feature', body: 'Request', user: { login: 'requester' }, state: 'open', labels: [] };
    if (path.endsWith('/pulls')) {
      if (method === 'GET') return [];
      description = String(body.body);
      return { number: 126 };
    }
    if (path.endsWith('/reviews')) return method === 'GET' ? [] : { id: 1 };
    if (path.endsWith('/check-runs')) return method === 'GET' ? { total_count: 0, check_runs: [] } : { id: 1 };
    throw new Error(`Unexpected request: ${method} ${path}`);
  }), 'custom-model');
  await github.publish(state);
  assert.match(description, /earlier costs unavailable\. Totals cover recorded runs only/);
  assert.match(description, /2\.0 runner minutes and 12\.5 AI credits across 2 runs/);
  const cost = description.split('## Cost\n\n')[1]!.split('\n\n## Evidence')[0]!;
  assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(cost)![1]!), {
    SDLC_MODEL: 'custom-model', SDLC_AIC_CREDIT_LIMIT: 575,
  });
  assert.match(cost, /Observed agent models:\*\* unavailable/);
  assert.doesNotMatch(cost, /Observed agent models:\*\* `custom-model`/);
});

test('the reporting model defaults to auto when unset or empty', () => {
  const client = api(() => { throw new Error('No API request expected'); });
  for (const model of [undefined, '']) {
    assert.equal(new GitHub('owner/repo', policy, 'sdlc[bot]', client, model).model, 'auto');
  }
});

test('state reads validate identity and reject corrupt or oversized data', async () => {
  const { state } = active();
  let stored = state;
  let size = 100;
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api(() => ({
    type: 'file', sha: newSha, size, content: Buffer.from(JSON.stringify(stored)).toString('base64'),
  })));
  assert.equal((await github.load(123))!.version, newSha);
  stored = { ...state, issueNumber: 124 };
  await assert.rejects(github.load(123), /identity/);
  stored = state; size = 1_000_001;
  await assert.rejects(github.load(123), /Invalid state/);
});

test('repository write authorization checks live permission', async () => {
  let permission = 'write';
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api(() => ({ permission })));
  assert.equal(await github.canWrite('maintainer'), true);
  permission = 'read';
  assert.equal(await github.canWrite('maintainer'), false);
});

test('only controller-owned comments are updated and edited commands are ignored', async () => {
  const comments: Record<string, unknown>[] = [{ id: 1, body: '<!-- sdlc:status -->\nForged', user: { login: 'stranger', type: 'User' },
    created_at: '2026-09-08T12:00:00Z', updated_at: '2026-09-08T13:00:00Z' }];
  let updates = 0;
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, _path, body) => {
    if (method === 'GET') return comments;
    if (method === 'POST') comments.push({ id: 2, body: body.body, user: { login: 'sdlc[bot]', type: 'Bot' } });
    if (method === 'PATCH') { updates += 1; comments[1]!.body = body.body; }
    return {};
  }));
  await github.comment(123, 'status', 'Running');
  await github.comment(123, 'status', 'Running');
  await github.comment(123, 'status', 'Done');
  assert.equal(comments.length, 2);
  assert.equal(updates, 1);
  assert.equal((await github.comments(123))[0]!.human, false);
});

test('trusted path comparison fails closed on anything it cannot judge', async () => {
  const compare = (data: Record<string, unknown>) =>
    new GitHub('owner/repo', policy, 'sdlc[bot]', api(() => data)).trustedPathsChanged(baseSha, newSha);
  assert.equal(await compare({ status: 'ahead',
    files: [{ filename: 'docs/operations.md' }, { filename: 'src/clock/face.ts' }] }), false);
  assert.equal(await new GitHub('owner/repo', policy, 'sdlc[bot]', api(() => {
    throw new Error('an identical revision must not be compared');
  })).trustedPathsChanged(baseSha, baseSha), false);
  for (const data of [
    { status: 'ahead', files: [{ filename: 'src/worker.ts' }] },
    { status: 'ahead', files: [{ filename: '.github/workflows/ci.yml' }] },
    { status: 'ahead', files: [{ filename: 'docs/moved.md', previous_filename: 'tsconfig.json' }] },
    { status: 'diverged', files: [{ filename: 'README.md' }] },
    { status: 'ahead' },
    { status: 'ahead', files: Array.from({ length: 300 }, (_, index) => ({ filename: `app/file-${index}.ts` })) },
  ]) {
    assert.equal(await compare(data), true);
  }
});

test('state storage bootstraps an isolated branch and preserves compare-and-swap on creation', async () => {
  const { state } = active();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path, body) => {
    if (method === 'GET') return new Response('{"message":"Not Found"}', { status: 404 });
    writes.push({ path, body });
    if (method === 'PUT') return { content: { sha: newSha } };
    return { sha: baseSha };
  }));
  assert.equal(await github.load(123), undefined);
  await github.save({ state });
  assert.deepEqual(writes.find(write => write.path.endsWith('/commits'))!.body.parents, []);
  assert.equal(writes.find(write => write.path.endsWith('/refs'))!.body.ref, 'refs/heads/sdlc-state');
});