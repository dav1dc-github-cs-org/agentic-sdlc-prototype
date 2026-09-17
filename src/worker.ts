import { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assessChanges, describeCapabilities, validateChanges, type Capabilities } from './changes.ts';
import { blockerSchema, reportSchema, resolvePolicy, shaSchema, workerReportSchema, type Change, type Policy } from './contracts.ts';
import { dependencyChanges, dependencyPlan, validatePlanPolicy, verifyDependencyFiles } from './dependencies.ts';
import { GitHub } from './github.ts';
import { assertJobAuthorization, executionHash, type Lifecycle, type Stage } from './lifecycle.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function prepareContext(state: Lifecycle, input: {
  issue: number; job: string; sourceSha: string; controlSha: string; stage: string;
}): void {
  const job = state.job;
  if (!job || state.issueNumber !== input.issue || job.id !== input.job ||
      job.inputSha !== input.sourceSha || state.headSha !== input.sourceSha ||
      job.controlSha !== input.controlSha || state.controlSha !== input.controlSha || job.stage !== input.stage ||
      ['paused', 'cancelled', 'blocked', 'merged', 'pr_open'].includes(state.phase)) {
    throw new Error('Dispatch does not match a runnable registered job');
  }
  if (job.executionHash !== undefined && job.executionHash !== executionHash(state)) throw new Error('Execution breakdown changed');
  assertJobAuthorization(state, job);
}

export function collectChanges(source: string, sha: string, stage: Stage, policy: Policy): Change[] {
  shaSchema.parse(sha);
  const directory = realpathSync(source);
  const git = (args: string[]) => execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', maxBuffer: 2_000_000, timeout: 30_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false' },
  }).split('\0').filter(Boolean);
  const paths = new Set([
    ...git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', sha, '--']),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const changes: Change[] = [];
  const unsupported = 'Only bounded regular text files can be collected';
  for (const path of paths) {
    validateChanges([{ path, content: '' }], stage, policy);
    const absolute = resolve(directory, path);
    if (!absolute.startsWith(directory + sep)) throw new Error('File escapes the source checkout');
    let handle: number | undefined;
    try {
      // O_NOFOLLOW rejects a swapped symlink, and the descriptor is then the only path-independent view.
      handle = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(handle);
      if (!info.isFile() || info.size > policy.maxChangeBytes) throw new Error(unsupported);
      changes.push({ path, content: new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(handle)) });
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') changes.push({ path, content: null });
      else if (code === 'ELOOP') throw new Error(unsupported);
      else throw error;
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  }
  validateChanges(changes, stage, policy);
  return changes.sort((first, second) => first.path.localeCompare(second.path));
}

export function restoreCheckpoint(state: Lifecycle, source: string, policy: Policy, baselineTests: readonly string[]): boolean {
  const job = state.job!;
  const checkpoint = state.recoveries?.find(recovery => recovery.status === 'active' && recovery.checkpoint &&
    recovery.checkpoint.job.inputSha === job.inputSha && recovery.checkpoint.job.controlSha === job.controlSha &&
    recovery.checkpoint.job.planHash === job.planHash && recovery.checkpoint.job.taskId === job.taskId &&
    recovery.checkpoint.job.stage === job.stage && recovery.checkpoint.job.stepId === job.stepId &&
    recovery.checkpoint.job.executionHash === job.executionHash)?.checkpoint;
  if (!checkpoint) return false;
  validateChanges(checkpoint.changes, job.stage, policy, baselineTests);
  writeDraft(source, checkpoint.changes);
  return true;
}

export function writeDraft(source: string, changes: Change[]): void {
  const directory = realpathSync(source);
  for (const change of changes) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(change.path) || change.path.startsWith('/') ||
        change.path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new Error('Unsafe draft path');
    }
    let parent = directory;
    for (const segment of change.path.split('/').slice(0, -1)) {
      const next = join(parent, segment);
      try { mkdirSync(next); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      if (realpathSync(next) !== next) throw new Error('Draft path contains a symlink');
      parent = next;
    }
    const path = join(directory, change.path);
    if (change.content === null) {
      try { unlinkSync(path); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      continue;
    }
    const handle = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
    try {
      if (!fstatSync(handle).isFile()) throw new Error('Draft target must be a regular file');
      ftruncateSync(handle, 0);
      writeFileSync(handle, change.content, 'utf8');
    } finally { closeSync(handle); }
  }
}

async function prepare(): Promise<void> {
  const policy = resolvePolicy(JSON.parse(readFileSync(join(root, '.github/sdlc/policy.json'), 'utf8')),
    process.env.SDLC_AIC_CREDIT_LIMIT);
  const input = {
    issue: z.coerce.number().int().positive().parse(process.env.SDLC_ISSUE), job: process.env.SDLC_JOB ?? '',
    sourceSha: shaSchema.parse(process.env.SDLC_SOURCE_SHA), controlSha: shaSchema.parse(process.env.SDLC_CONTROL_SHA),
    stage: process.env.SDLC_STAGE ?? '',
  };
  if (process.env.GITHUB_SHA !== input.controlSha || process.env.GITHUB_ACTOR !== process.env.SDLC_BOT_LOGIN) {
    throw new Error('Worker must run the trusted workflow revision under the controller App identity');
  }
  const github = new GitHub(process.env.GITHUB_REPOSITORY ?? '', policy, process.env.SDLC_BOT_LOGIN ?? '',
    new Octokit({ auth: process.env.GH_TOKEN }));
  const record = await github.load(input.issue);
  if (!record) throw new Error('No registered lifecycle');
  prepareContext(record.state, input);
  const capabilities = describeCapabilities(record.state.job!.stage, policy, await github.baselineTests(record.state));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `base_sha=${shaSchema.parse(record.state.baseSha)}\nscan_sha=${record.state.job!.probeSha ?? input.sourceSha}\n`);
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  if (record.state.job!.purpose === 'dependency_repair') {
    const changes = dependencyChanges(record.state, policy).filter(change => !record.state.dependencyPatches?.some(patch =>
      patch.path === change.path && patch.planHash === record.state.plan?.hash));
    writeDraft(join(workspace, 'source'), changes);
  }
  restoreCheckpoint(record.state, join(workspace, 'source'), policy, capabilities.immutableTests);
  writeFileSync(join(workspace, '.sdlc-context.json'), JSON.stringify({ state: record.state, policy, capabilities }, null, 2));
  mkdirSync(join(workspace, '.sdlc-output'), { recursive: true });
  if (input.stage === 'security' || input.stage === 'code') {
    const security = input.stage === 'security';
    const checkpoint = {
      outcome: 'blocked' as const,
      summary: (security ? 'Security review incomplete. Review has not started.\n\n' : 'Coding work incomplete. Work has not started.\n\n') +
        `Scope: source commit ${input.sourceSha}.\n` +
        'Review coverage and evidence: no checks recorded.\n' +
        (security ? 'Outstanding work: all applicable security review areas.\n\n' : 'Outstanding work: all assigned acceptance criteria.\n\n') +
        'Stop reason and handoff: initial checkpoint only; complete the independent review before reporting pass.',
      blocker: { category: 'incomplete_work' as const, scope: security ? 'repository' as const : 'task' as const, paths: [],
        constraint: 'The registered stage has not completed', diagnostics: [], remedies: ['Continue the registered work and verify it'] },
    };
    writeFileSync(join(workspace, '.sdlc-output/report.json'), JSON.stringify(checkpoint));
    writeFileSync(join(workspace, '.sdlc-output/result.json'), JSON.stringify(reportSchema.parse({
      ...checkpoint, jobId: input.job, inputSha: input.sourceSha, changes: [],
    })));
  }
}

function collect(): void {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const context = JSON.parse(readFileSync(join(workspace, '.sdlc-context.json'), 'utf8')) as {
    state: Lifecycle; policy: Policy; capabilities?: Capabilities;
  };
  const job = context.state.job!;
  const raw = workerReportSchema.parse(JSON.parse(readFileSync(join(workspace, '.sdlc-output/report.json'), 'utf8')));
  const changes = collectChanges(join(workspace, 'source'), job.inputSha, job.stage, context.policy);
  validateChanges(changes, job.stage, context.policy, context.capabilities?.immutableTests ?? []);
  const report = reportSchema.parse({ ...raw, jobId: job.id, inputSha: job.inputSha, changes });
  writeFileSync(join(workspace, '.sdlc-output/result.json'), JSON.stringify(report));
}

function checkPermissions(): void {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const context = JSON.parse(readFileSync(join(workspace, '.sdlc-context.json'), 'utf8')) as {
    state: Lifecycle; policy: Policy; capabilities: Capabilities;
  };
  const paths = process.argv.slice(3);
  if (!paths.length) throw new Error('Provide at least one proposed path');
  const result = assessChanges(paths.map(path => ({ path, content: '' })), context.state.job!.stage,
    context.policy, context.capabilities.immutableTests);
  console.log(JSON.stringify(result));
  if (!result.allowed) process.exitCode = 1;
}

function checks(): void {
  const jobId = process.env.SDLC_JOB;
  const inputSha = process.env.SDLC_SOURCE_SHA;
  const stage = process.env.SDLC_STAGE;
  if (!['scan', 'validate', 'integrate'].includes(stage ?? '')) throw new Error('Unexpected check stage');
  const results = JSON.parse(process.env.SDLC_CHECK_RESULTS ?? '{}') as Record<string, {
    result?: string; outputs?: { diagnostics?: string; blocker?: string; integration_hash?: string };
  }>;
  const required = stage === 'scan' ? ['prepare', 'codeql', 'security'] : stage === 'integrate' ? ['prepare', 'integration'] : ['prepare', 'tests'];
  const failed = required.filter(name => results[name]?.result !== 'success');
  const integrationHash = stage === 'integrate' ? results.integration?.outputs?.integration_hash : undefined;
  if (stage === 'integrate' && !failed.length && !/^[a-f0-9]{64}$/.test(integrationHash ?? '')) failed.push('integration_receipt');
  const encoded = failed.includes('codeql') ? results.codeql?.outputs?.diagnostics : undefined;
  let diagnostics = '';
  if (typeof encoded === 'string' && encoded.length <= 32_000) {
    try {
      const parsed = z.string().min(1).max(6000).safeParse(JSON.parse(encoded));
      if (parsed.success) diagnostics = `\n\nCodeQL diagnostics (untrusted scanner data):\n${parsed.data}`;
    } catch { diagnostics = ''; }
  }
  let blocker;
  const encodedBlocker = failed.includes('codeql') ? results.codeql?.outputs?.blocker :
    failed.includes('integration') ? results.integration?.outputs?.blocker : undefined;
  if (encodedBlocker && encodedBlocker.length <= 32000) {
    try { blocker = blockerSchema.parse(JSON.parse(encodedBlocker)); } catch { blocker = undefined; }
  }
  if (failed.length && !blocker) blocker = { category: 'incomplete_work' as const, scope: 'repository' as const, paths: [],
    constraint: 'Required deterministic checks have not completed successfully', diagnostics: failed.map(name => ({
      tool: 'platform' as const, message: `${name}: ${results[name]?.result ?? 'missing'}` })),
    remedies: ['Inspect the failed check and retry only within the bounded recovery budget'] };
  const url = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const report = reportSchema.parse({ jobId, inputSha,
    outcome: failed.length ? 'changes_requested' : 'pass',
    summary: failed.length ? `Required checks failed or did not run: ${failed.join(', ')}. Inspect ${url}.${diagnostics}` :
      stage === 'scan' ? 'CodeQL, dependency audit, and secret scanning passed.' :
        stage === 'integrate' ? 'Approved baseline and retained feature trees were integrated without overlapping changes.' :
        'Baseline and candidate test suites passed; candidate coverage meets the fixed thresholds and non-regression requirement.',
    ...(blocker ? { blocker } : {}), ...(stage === 'integrate' && !failed.length ? { integrationHash } : {}),
    changes: [],
  });
  mkdirSync('.sdlc-output', { recursive: true });
  writeFileSync('.sdlc-output/result.json', JSON.stringify(report));
}

async function integration(): Promise<void> {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const context = JSON.parse(readFileSync(join(workspace, '.sdlc-context.json'), 'utf8')) as { state: Lifecycle; policy: Policy };
  const github = new GitHub(process.env.GITHUB_REPOSITORY ?? '', context.policy, process.env.SDLC_BOT_LOGIN ?? '',
    new Octokit({ auth: process.env.GH_TOKEN }));
  try {
    const hash = await github.integration(context.state);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `integration_hash=${hash}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2000) : 'Integration could not complete';
    const blocker = blockerSchema.parse({ category: 'approval_conflict', scope: 'repository', paths: [],
      constraint: 'The approved baseline must combine with retained work without discarding conflicting edits',
      diagnostics: [{ tool: 'policy', message }], remedies: ['Resolve the overlapping changes through a new scoped amendment'] });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `blocker=${JSON.stringify(blocker)}\n`);
    throw error;
  }
}

function dependencies(): void {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const context = JSON.parse(readFileSync(join(workspace, '.sdlc-context.json'), 'utf8')) as { state: Lifecycle; policy: Policy };
  validatePlanPolicy(dependencyPlan(context.state), context.policy);
  const source = join(workspace, 'source');
  if (context.state.job?.purpose === 'dependency_preflight' && context.state.preflight?.kind === 'dependencies') {
    writeDraft(source, dependencyChanges(context.state, context.policy));
  }
  verifyDependencyFiles(context.state, source);
}

if (import.meta.main) {
  const operation = process.argv[2];
  if (operation === 'prepare') await prepare();
  else if (operation === 'collect') collect();
  else if (operation === 'check') checkPermissions();
  else if (operation === 'checks') checks();
  else if (operation === 'integrate') await integration();
  else if (operation === 'dependencies') dependencies();
  else throw new Error('Expected prepare, collect, check, checks, integrate, or dependencies');
}