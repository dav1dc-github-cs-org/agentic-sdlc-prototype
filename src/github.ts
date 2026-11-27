import { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { digest } from './domain.ts';
import { isProtectedPath, isTestPath, mergeSnapshots, validateChanges } from './changes.ts';
import { assertIntegration } from './recovery.ts';
import { validateDependencyChanges } from './dependencies.ts';
import { costSchema, lifecycleSchema, migrateLifecycle, reportSchema, targetRefSchema, type Change, type Cost, type Policy, type Report } from './contracts.ts';
import { activeDecisions, assertPublishable, formatObservedModels, type Job, type JobIdentity, type Lifecycle, type TargetRef, type Task } from './lifecycle.ts';
import { RetryablePlatformError, type Baseline, type Comment, type Issue, type Platform, type RecordState, type Run } from './controller.ts';
import { assertExposure, receiptWorkflow, registryPath, runTitle, sameRepository, splitRepository, targetBindingChanged } from './targets.ts';

export function workerFile(job: Pick<Job, 'stage'>): string {
  return ['scan', 'validate', 'integrate'].includes(job.stage) ? 'sdlc-checks.yml' : 'sdlc-agent.lock.yml';
}

export function decodeReportArchive(bytes: Uint8Array): Report {
  if (bytes.byteLength > 2_000_000) throw new Error('Artifact exceeds size limit');
  // Filtering on the declared size keeps a compressed entry from being inflated before it is bounded.
  const files = unzipSync(bytes, {
    filter: file => file.name === 'result.json' && file.originalSize <= 2_000_000,
  });
  const report = files['result.json'];
  if (!report || report.byteLength > 2_000_000) throw new Error('Missing or oversized result.json');
  return reportSchema.parse(JSON.parse(Buffer.from(report).toString('utf8')));
}

export function decodeCostArchive(bytes: Uint8Array): Cost {
  if (bytes.byteLength > 10_000) throw new Error('Cost artifact exceeds size limit');
  const files = unzipSync(bytes, {
    filter: file => file.name === 'cost.json' && file.originalSize <= 10_000,
  });
  const cost = files['cost.json'];
  if (!cost) throw new Error('Missing cost.json');
  return costSchema.parse(JSON.parse(Buffer.from(cost).toString('utf8')));
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'status' in error && error.status === 404;
}

export function neutralizeClosingKeywords(markdown: string): string {
  const reference = String.raw`(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+)`;
  const keyword = String.raw`\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b(?=\s+${reference})`;
  return markdown.replace(new RegExp(keyword, 'gi'), '$1 issue');
}

function boundedMarkdown(markdown: string, maxBytes: number, overflowNotice: string): string {
  if (Buffer.byteLength(markdown, 'utf8') <= maxBytes) return markdown;
  const suffix = `\n\n> Summary shortened. ${overflowNotice}`;
  const availableBytes = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let prefix = '';
  let prefixBytes = 0;
  for (const character of markdown) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (prefixBytes + characterBytes > availableBytes) break;
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix.trimEnd()}${suffix}`;
}

export interface TargetBinding extends TargetRef { api: Octokit }

type Scope = { owner: string; repo: string };

export class GitHub implements Platform {
  // Issues, Git data, pull requests, and checks live in the target; state, dispatch, and run evidence stay in the control plane.
  readonly api: Octokit;
  readonly scope: Scope;
  readonly controlApi: Octokit;
  readonly control: Scope;
  readonly target?: TargetRef;
  readonly policy: Policy;
  readonly botLogin: string;
  readonly model: string;
  // Reconciliation reads the same lists repeatedly; caches live only for the duration of one process.
  private readonly commentCache = new Map<number, Awaited<ReturnType<GitHub['fetchComments']>>>();
  private botIssues?: Awaited<ReturnType<GitHub['fetchBotIssues']>>;

  constructor(repository: string, policy: Policy, botLogin: string, api: Octokit, model = 'auto', target?: TargetBinding) {
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
    if (!match || !/^[a-z0-9-]+\[bot\]$/.test(botLogin)) throw new Error('Invalid repository or App bot identity');
    this.control = { owner: match[1]!, repo: match[2]! };
    this.controlApi = api;
    if (target) {
      const binding = targetRefSchema.safeParse({ id: target.id, repository: target.repository });
      if (!binding.success || sameRepository(target.repository, repository)) throw new Error('Invalid foreign target binding');
      this.target = binding.data;
      this.scope = splitRepository(binding.data.repository);
      this.api = target.api;
    } else {
      this.scope = this.control;
      this.api = api;
    }
    this.policy = policy;
    this.botLogin = botLogin;
    this.model = model || 'auto';
  }

  async issue(number: number): Promise<Issue> {
    const { data } = await this.api.issues.get({ ...this.scope, issue_number: number });
    if (data.pull_request) throw new Error('Pull request comments are not issue commands');
    if (!data.user?.login) throw new Error('Issue author is unavailable');
    return { number, title: data.title, body: data.body ?? '', author: data.user.login,
      open: data.state === 'open', labeled: data.labels.some(label =>
        typeof label === 'string' ? label === this.policy.label : label.name === this.policy.label) };
  }

  private async fetchComments(number: number) {
    return this.api.paginate(this.api.issues.listComments, { ...this.scope, issue_number: number, per_page: 100 });
  }

  private async cachedComments(number: number) {
    const cached = this.commentCache.get(number);
    if (cached) return cached;
    const comments = await this.fetchComments(number);
    this.commentCache.set(number, comments);
    return comments;
  }

  async comments(number: number): Promise<Comment[]> {
    const comments = await this.cachedComments(number);
    return comments.flatMap(comment => comment.user?.login ? [{ id: comment.id, body: comment.body ?? '',
      actor: comment.user.login, human: comment.user.type === 'User' && comment.created_at === comment.updated_at,
      createdAt: comment.created_at }] : []);
  }

  async canWrite(actor: string): Promise<boolean> {
    try {
      const { data } = await this.api.repos.getCollaboratorPermissionLevel({ ...this.scope, username: actor });
      return ['write', 'maintain', 'admin'].includes(data.permission) || data.user?.permissions?.push === true;
    } catch (error) { if (missing(error)) return false; throw error; }
  }

  // Every target contact first proves the registered identity and that mirroring its content cannot widen its audience.
  async verifyTarget() {
    if (!this.target) throw new Error('No foreign target is bound');
    const { data: repo } = await this.api.repos.get(this.scope);
    if (repo.id !== this.target.id || !sameRepository(repo.full_name, this.target.repository)) {
      throw new Error('Target repository identity changed; revalidate its registry entry before continuing');
    }
    const { data: control } = await this.controlApi.repos.get(this.control);
    assertExposure(control, repo);
    return { repo, control };
  }

  async baseline(): Promise<Baseline> {
    if (this.target) {
      const { repo, control } = await this.verifyTarget();
      return { branch: repo.default_branch, sha: await this.head(repo.default_branch),
        controlSha: await this.controlHead(control.default_branch) };
    }
    const { data: repo } = await this.api.repos.get(this.scope);
    return { branch: repo.default_branch, sha: await this.head(repo.default_branch) };
  }

  async controlRevision(): Promise<{ branch: string; sha: string }> {
    const { data: repo } = await this.controlApi.repos.get(this.control);
    return { branch: repo.default_branch, sha: await this.controlHead(repo.default_branch) };
  }

  private async controlHead(branch: string): Promise<string> {
    return (await this.controlApi.git.getRef({ ...this.control, ref: `heads/${branch}` })).data.object.sha;
  }

  private async controlFile(path: string, ref: string): Promise<unknown> {
    try {
      const { data } = await this.controlApi.repos.getContent({ ...this.control, path, ref });
      if (Array.isArray(data) || data.type !== 'file' || data.size > 1_000_000) return undefined;
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    } catch (error) {
      if (missing(error) || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private ownsState(state: Lifecycle): boolean {
    return this.target ? state.target?.id === this.target.id : state.target === undefined;
  }

  private statePath(number: number): string {
    return this.target ? `targets/${this.target.id}/issues/${number}.json` : `issues/${number}.json`;
  }

  async baselineTests(state: Lifecycle): Promise<string[]> {
    return [...(await this.tree(state.baseSha)).files.keys()].filter(path => isTestPath(path, this.policy)).sort();
  }

  private async integrationTree(state: Lifecycle) {
    assertIntegration(state);
    const amendment = state.amendment!;
    const baseline = await this.baseline();
    if (baseline.sha !== amendment.targetSha || baseline.branch !== state.baseBranch) throw new Error('Approved integration baseline moved');
    const base = await this.tree(amendment.baseSha);
    const source = await this.tree(amendment.sourceSha);
    const target = await this.tree(amendment.targetSha);
    const resolutions = amendment.plan?.policy?.integrationResolutions ?? [];
    validateChanges(resolutions.map(item => ({ path: item.path, content: item.content })), 'code', this.policy,
      [...new Set([...base.files.keys(), ...target.files.keys()])].filter(path => isTestPath(path, this.policy)));
    return mergeSnapshots(base.files, source.files, target.files, resolutions);
  }

  async integration(state: Lifecycle): Promise<string> {
    return digest(await this.integrationTree(state));
  }

  async publishMaintenance(state: Lifecycle, recoveryId: string, hash: string): Promise<number> {
    const recovery = state.recoveries?.find(item => item.id === recoveryId);
    if (!recovery?.maintenance || recovery.maintenance.hash !== hash || recovery.status !== 'waiting_maintainer' ||
      recovery.maintenanceAuthorization?.hash !== hash ||
        digest({ baseSha: recovery.maintenanceBase, recoveryId, changes: recovery.maintenance.changes }) !== hash) {
      throw new Error('Maintenance proposal integrity check failed');
    }
    const baseline = await this.baseline();
    if (baseline.sha !== recovery.maintenanceBase || baseline.branch !== state.baseBranch) throw new Error('Maintenance baseline moved; request a fresh proposal');
    const branch = `agentic/maintenance-${recoveryId}-${hash.slice(0, 12)}`;
    const message = `SDLC maintenance ${recoveryId} ${hash}`;
    const parent = await this.tree(baseline.sha);
    for (const change of recovery.maintenance.changes) {
      const existing = parent.files.get(change.path);
      if (!existing || existing.type !== 'blob' || !['100644', '100755'].includes(existing.mode ?? '') ||
          !recovery.blocker.paths.includes(change.path) || change.content === null) throw new Error('Maintenance path is not a diagnosed regular baseline file');
    }
    const { data: tree } = await this.api.git.createTree({ ...this.scope, base_tree: parent.sha,
      tree: recovery.maintenance.changes.map(change => ({ path: change.path, mode: parent.files.get(change.path)!.mode as '100644',
        type: 'blob', content: change.content! })) });
    let head: string;
    try {
      head = await this.head(branch);
      const { data: existing } = await this.api.git.getCommit({ ...this.scope, commit_sha: head });
      if (existing.message !== message || existing.tree.sha !== tree.sha || existing.parents.length !== 1 ||
          existing.parents[0]!.sha !== baseline.sha) throw new Error('Maintenance branch changed outside its approved proposal');
    } catch (error) {
      if (!missing(error)) throw error;
      const { data: commit } = await this.api.git.createCommit({ ...this.scope, message, tree: tree.sha, parents: [baseline.sha] });
      await this.api.git.createRef({ ...this.scope, ref: `refs/heads/${branch}`, sha: commit.sha });
      head = commit.sha;
    }
    const { data: pulls } = await this.api.pulls.list({ ...this.scope, state: 'all', head: `${this.scope.owner}:${branch}`, base: baseline.branch });
    const existing = pulls.find(pull => pull.user?.login === this.botLogin && pull.head.sha === head);
    if (existing) return existing.number;
    const { data: pull } = await this.api.pulls.create({ ...this.scope, head: branch, base: baseline.branch, draft: true,
      title: `Proposed baseline repair for SDLC #${state.issueNumber}`, body: neutralizeClosingKeywords(
        `Related lifecycle #${state.issueNumber}. Recovery ${recoveryId}.\n\n${recovery.maintenance.summary}\n\n` +
        `Explicitly requested draft proposal. Patch hash: ${hash}. No feature approval or gate waiver is granted. ` +
        'Maintainers must review the diff and required CI, then merge normally. Resume the feature through a scoped amendment.') });
    return pull.number;
  }

  async applyIntegration(state: Lifecycle, job: Job, expectedHash: string): Promise<string> {
    const entries = await this.integrationTree(state);
    if (digest(entries) !== expectedHash || state.job?.id !== job.id || job.inputSha !== state.headSha) {
      throw new Error('Integration authority changed');
    }
    const parents = [...new Set([job.inputSha, state.amendment!.targetSha])];
    const message = `SDLC integration ${job.id} ${expectedHash}`;
    let head: string;
    try { head = await this.head(state.branch); }
    catch (error) {
      if (!missing(error)) throw error;
      await this.api.git.createRef({ ...this.scope, ref: `refs/heads/${state.branch}`, sha: job.inputSha });
      head = job.inputSha;
    }
    if (head !== job.inputSha) {
      const { data: commit } = await this.api.git.getCommit({ ...this.scope, commit_sha: head });
      const existing = [...(await this.tree(head)).files].filter(([, entry]) => entry.type !== 'tree')
        .map(([path, entry]) => ({ path, sha: entry.sha, mode: entry.mode, type: entry.type }))
        .sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0);
      if (commit.message === message && digest(commit.parents.map(parent => parent.sha)) === digest(parents) &&
          digest(existing) === expectedHash) return head;
      throw new Error('Integration branch changed outside the registered job');
    }
    for (const resolution of state.amendment!.plan?.policy?.integrationResolutions ?? []) if (resolution.content !== null) {
      const { data: blob } = await this.api.git.createBlob({ ...this.scope,
        content: Buffer.from(resolution.content).toString('base64'), encoding: 'base64' });
      if (entries.find(entry => entry.path === resolution.path)?.sha !== blob.sha) throw new Error('Integration resolution blob did not match its approved content');
    }
    const { data: tree } = await this.api.git.createTree({ ...this.scope, tree: entries.map(entry => ({
      path: entry.path, sha: entry.sha, mode: entry.mode as '100644', type: entry.type as 'blob',
    })) });
    const { data: commit } = await this.api.git.createCommit({ ...this.scope, message, tree: tree.sha, parents });
    if (await this.head(state.branch) !== job.inputSha) throw new Error('Integration branch moved before publication');
    await this.api.git.updateRef({ ...this.scope, ref: `heads/${state.branch}`, sha: commit.sha, force: false });
    return commit.sha;
  }

  async trustedPathsChanged(from: string, to: string): Promise<boolean> {
    if (from === to) return false;
    const { data } = await this.controlApi.repos.compareCommitsWithBasehead({ ...this.control, basehead: `${from}...${to}` });
    const files = data.files;
    // Only a clean fast-forward with a complete file list can be judged. Reverts, force pushes, and
    // diffs at or past the comparison file cap are indistinguishable from a swapped harness.
    if (data.status !== 'ahead' || files === undefined || files.length >= 300) return true;
    const changed = files.flatMap(file => file.previous_filename === undefined ? [file.filename] : [file.filename, file.previous_filename])
      .filter(path => isProtectedPath(path, this.policy));
    // Intake-only files govern new receipts, not running lifecycles; the receipt callee is pinned by the registry.
    const intakeOnly = (path: string) => path === registryPath || path === receiptWorkflow || path.startsWith('.github/sdlc/templates/');
    if (changed.some(path => !intakeOnly(path))) return true;
    if (!this.target || !changed.includes(registryPath)) return false;
    return targetBindingChanged(await this.controlFile(registryPath, from), await this.controlFile(registryPath, to), this.target);
  }

  async head(branch: string): Promise<string> {
    return (await this.api.git.getRef({ ...this.scope, ref: `heads/${branch}` })).data.object.sha;
  }

  async load(number: number): Promise<RecordState | undefined> {
    try {
      const { data } = await this.controlApi.repos.getContent({ ...this.control, path: this.statePath(number), ref: this.policy.stateBranch });
      if (Array.isArray(data) || data.type !== 'file' || data.size > 1_000_000) throw new Error('Invalid state file');
      const stored = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      const state = migrateLifecycle(stored);
      if (state.issueNumber !== number || !this.ownsState(state) ||
          state.branch !== `agentic/epic-${number}-v${state.plan?.version ?? 1}` &&
          !['researching', 'preflighting', 'maintaining', 'paused', 'blocked', 'cancelled'].includes(state.phase)) {
        throw new Error('State identity mismatch');
      }
      return { state, version: data.sha, needsMigration: stored.schemaVersion !== state.schemaVersion };
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }

  async save(record: RecordState): Promise<void> {
    lifecycleSchema.parse(record.state);
    if (!this.ownsState(record.state)) throw new Error('State identity mismatch');
    const content = JSON.stringify(record.state, null, 2) + '\n';
    if (Buffer.byteLength(content) > 1_000_000) throw new Error('Lifecycle storage budget exceeded');
    await this.ensureStateBranch();
    const { data } = await this.controlApi.repos.createOrUpdateFileContents({
      ...this.control, branch: this.policy.stateBranch, path: this.statePath(record.state.issueNumber),
      message: `SDLC ${this.target ? `${this.target.id}/` : ''}#${record.state.issueNumber}: ${record.state.phase}`,
      content: Buffer.from(content).toString('base64'),
      sha: record.version,
    });
    if (!data.content?.sha) throw new Error('State write did not return a version');
    record.version = data.content.sha;
    delete record.needsMigration;
  }

  async ensureStateBranch(): Promise<void> {
    try { await this.controlHead(this.policy.stateBranch); return; }
    catch (error) { if (!missing(error)) throw error; }
    const { data: tree } = await this.controlApi.git.createTree({ ...this.control, tree: [
      { path: 'README.md', mode: '100644', type: 'blob', content: 'Controller-owned SDLC state. Do not edit manually.\n' },
    ] });
    const { data: commit } = await this.controlApi.git.createCommit({ ...this.control, tree: tree.sha,
      message: 'Initialize controller-owned SDLC state', parents: [] });
    await this.controlApi.git.createRef({ ...this.control, ref: `refs/heads/${this.policy.stateBranch}`, sha: commit.sha });
  }

  async activeIssues(): Promise<number[]> {
    const numbers = new Set<number>();
    try {
      const { data } = await this.controlApi.repos.getContent({ ...this.control,
        path: this.target ? `targets/${this.target.id}/issues` : 'issues', ref: this.policy.stateBranch });
      if (Array.isArray(data)) for (const item of data) {
        if (/^[1-9]\d*\.json$/.test(item.name)) numbers.add(Number(item.name.replace('.json', '')));
      }
    } catch (error) { if (!missing(error)) throw error; }
    // Foreign intake arrives only through authenticated receipts, so a label alone never starts work there.
    if (this.target) return [...numbers].sort((first, second) => first - second);
    const labeled = await this.api.paginate(this.api.issues.listForRepo, {
      ...this.scope, state: 'open', labels: this.policy.label, per_page: 100,
    });
    for (const issue of labeled) if (!issue.pull_request) numbers.add(issue.number);
    return [...numbers].sort((first, second) => first - second);
  }

  async comment(number: number, key: string, body: string): Promise<void> {
    const marker = `<!-- sdlc:${key} -->`;
    const text = `${marker}\n${body}`;
    const comments = await this.cachedComments(number);
    const existing = comments.find(comment => comment.user?.login === this.botLogin && comment.body?.startsWith(marker));
    if (existing?.body === text) return;
    if (existing) await this.api.issues.updateComment({ ...this.scope, comment_id: existing.id, body: text });
    else await this.api.issues.createComment({ ...this.scope, issue_number: number, body: text });
    this.commentCache.delete(number);
  }

  private async fetchBotIssues() {
    return this.api.paginate(this.api.issues.listForRepo, { ...this.scope,
      creator: this.botLogin, state: 'all', per_page: 100 });
  }

  async task(parent: Lifecycle, task: Task): Promise<number> {
    const marker = `<!-- sdlc:task:${parent.issueNumber}:${parent.plan!.hash}:${task.id} -->`;
    this.botIssues ??= await this.fetchBotIssues();
    let child = this.botIssues.find(issue => issue.user?.login === this.botLogin && issue.body?.startsWith(marker));
    if (!child) {
      child = (await this.api.issues.create({ ...this.scope, title: task.title,
        body: `${marker}\nParent: #${parent.issueNumber}\n\n${task.description}\n\n## Acceptance criteria\n\n` +
          task.acceptance.map(item => `- ${item}`).join('\n') + `\n\nDependencies: ${task.dependsOn.join(', ') || 'None'}`,
      })).data;
      this.botIssues.push(child);
    }
    const linked = await this.api.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
      ...this.scope, issue_number: parent.issueNumber, per_page: 100,
    });
    if (!linked.some(issue => issue.id === child!.id)) {
      await this.api.request('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
        ...this.scope, issue_number: parent.issueNumber, sub_issue_id: child.id,
      });
    }
    return child.number;
  }

  async linkTasks(state: Lifecycle): Promise<void> {
    for (const task of state.tasks) {
      if (!task.dependsOn.length) continue;
      const existing = await this.api.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', {
        ...this.scope, issue_number: task.issueNumber!, per_page: 100,
      });
      for (const id of task.dependsOn) {
        const dependency = state.tasks.find(candidate => candidate.id === id)!;
        if (existing.some(issue => issue.number === dependency.issueNumber)) continue;
        const { data } = await this.api.issues.get({ ...this.scope, issue_number: dependency.issueNumber! });
        await this.api.request('POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', {
          ...this.scope, issue_number: task.issueNumber!, issue_id: data.id,
        });
      }
    }
  }

  async dispatch(job: Job, state: Lifecycle): Promise<void> {
    if (!this.ownsState(state)) throw new Error('State identity mismatch');
    // Workers always run in the control repository, so a foreign target dispatches against the control default branch.
    await this.controlApi.actions.createWorkflowDispatch({ ...this.control, workflow_id: workerFile(job),
      ref: this.target ? (await this.controlRevision()).branch : state.baseBranch,
      inputs: { issue: String(state.issueNumber), job: job.id,
        source_sha: job.inputSha, control_sha: job.controlSha, stage: job.stage,
        ...(this.target ? { target_id: String(this.target.id), target_owner: this.scope.owner, target_name: this.scope.repo } : {}) },
    });
  }

  async findRun(job: JobIdentity): Promise<Run | undefined> {
    const runs = await this.controlApi.paginate(this.controlApi.actions.listWorkflowRuns, {
      ...this.control, workflow_id: workerFile(job), event: 'workflow_dispatch',
      head_sha: job.controlSha, created: `>=${job.createdAt}`, per_page: 100,
    });
    // Job IDs repeat across targets; the target-qualified title keeps one target's run from satisfying another's job.
    const title = runTitle(job.id, this.target);
    const matches = runs.filter(run => run.display_title === title && run.head_sha === job.controlSha &&
      run.actor?.login === this.botLogin && run.run_attempt === 1 &&
      (!job.runId || run.id === job.runId)).sort((first, second) => first.id - second.id);
    const run = matches[0];
    if (!run) return undefined;
    return { id: run.id, status: run.status ?? 'unknown', conclusion: run.conclusion, url: run.html_url };
  }

  async cancelRun(runId: number): Promise<void> {
    await this.controlApi.actions.cancelWorkflowRun({ ...this.control, run_id: runId });
  }

  async report(run: Run, job: Job): Promise<Report> {
    if (['scan', 'validate', 'integrate'].includes(job.stage)) {
      const jobs = await this.controlApi.paginate(this.controlApi.actions.listJobsForWorkflowRun, {
        ...this.control, run_id: run.id, filter: 'latest', per_page: 100,
      });
      const result = jobs.find(item => item.name === 'SDLC Check Result');
      if (!result) throw new RetryablePlatformError('The trusted check-result job is not available yet');
      if (result.conclusion !== 'success') {
        throw new Error('The trusted check-result job did not complete successfully');
      }
    }
    const artifacts = await this.controlApi.paginate(this.controlApi.actions.listWorkflowRunArtifacts, { ...this.control, run_id: run.id, per_page: 100 });
    const matches = artifacts.filter(artifact => artifact.name === 'sdlc-result' && !artifact.expired);
    if (!matches.length) throw new RetryablePlatformError('The worker artifact is not available yet');
    if (matches.length !== 1 || matches[0]!.size_in_bytes > 2_000_000) throw new Error('Duplicate or oversized worker artifact');
    const response = await this.controlApi.actions.downloadArtifact({ ...this.control, artifact_id: matches[0]!.id, archive_format: 'zip' });
    return decodeReportArchive(new Uint8Array(response.data as ArrayBuffer));
  }

  async cost(run: Run, job: JobIdentity): Promise<Cost & { runnerMs: number }> {
    const jobs = await this.controlApi.paginate(this.controlApi.actions.listJobsForWorkflowRun, {
      ...this.control, run_id: run.id, filter: 'latest', per_page: 100,
    });
    // Public repositories report zero billable time, so charge the summed job durations instead.
    const runnerMs = jobs.reduce((total, item) => {
      const started = Date.parse(item.started_at ?? '');
      const completed = Date.parse(item.completed_at ?? '');
      return total + (completed > started ? completed - started : 0);
    }, 0);
    if (['scan', 'validate', 'integrate'].includes(job.stage)) return { runnerMs, credits: 0, preempted: false };
    const artifacts = await this.controlApi.paginate(this.controlApi.actions.listWorkflowRunArtifacts, {
      ...this.control, run_id: run.id, per_page: 100,
    });
    const matches = artifacts.filter(artifact => artifact.name === 'sdlc-cost' && !artifact.expired);
    if (matches.length !== 1 || matches[0]!.size_in_bytes > 10_000) return { runnerMs, credits: null, preempted: null };
    const response = await this.controlApi.actions.downloadArtifact({
      ...this.control, artifact_id: matches[0]!.id, archive_format: 'zip',
    });
    return { runnerMs, ...decodeCostArchive(new Uint8Array(response.data as ArrayBuffer)) };
  }

  private async tree(sha: string) {
    const { data: commit } = await this.api.git.getCommit({ ...this.scope, commit_sha: sha });
    const { data } = await this.api.git.getTree({ ...this.scope, tree_sha: commit.tree.sha, recursive: '1' });
    if (data.truncated) throw new Error('Repository tree is too large for this prototype');
    return { sha: commit.tree.sha, files: new Map(data.tree.map(item => [item.path!, item])) };
  }

  async applyChanges(state: Lifecycle, job: Job, changes: Change[]): Promise<string> {
    validateChanges(changes, job.stage, this.policy);
    validateDependencyChanges(state, job, changes);
    if (state.headSha !== job.inputSha) throw new Error('Source commit changed during publication');
    const message = `SDLC ${job.id} ${digest(changes)}`;
    let head: string;
    try { head = await this.head(state.branch); }
    catch (error) {
      if (!missing(error)) throw error;
      await this.api.git.createRef({ ...this.scope, ref: `refs/heads/${state.branch}`, sha: job.inputSha });
      head = job.inputSha;
    }
    if (head !== job.inputSha) {
      const { data: commit } = await this.api.git.getCommit({ ...this.scope, commit_sha: head });
      if (commit.message !== message || commit.parents.length !== 1 || commit.parents[0]!.sha !== job.inputSha) {
        throw new Error('Working branch changed outside the active job');
      }
    }
    const source = await this.tree(job.inputSha);
    const sourceTree = source.files;
    const baselineTree = state.baseSha === job.inputSha ? sourceTree : (await this.tree(state.baseSha)).files;
    validateChanges(changes, job.stage, this.policy, [...baselineTree.keys()].filter(path => isTestPath(path, this.policy)));
    const caseFolded = new Map<string, string[]>();
    for (const path of sourceTree.keys()) {
      const folded = path.toLowerCase();
      caseFolded.set(folded, [...(caseFolded.get(folded) ?? []), path]);
    }
    for (const change of changes) {
      const existing = sourceTree.get(change.path);
      if (existing && (existing.type !== 'blob' || !['100644', '100755'].includes(existing.mode ?? ''))) {
        throw new Error('Only regular text files may be modified');
      }
      if (change.content === null && !existing) throw new Error('Cannot delete a missing file');
      const segments = change.path.split('/');
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const prefix = segments.slice(0, depth).join('/');
        if ((caseFolded.get(prefix.toLowerCase()) ?? []).some(path => path !== prefix)) {
          throw new Error('Existing path has different casing');
        }
        if (depth === segments.length) continue;
        const ancestor = sourceTree.get(prefix);
        if (ancestor && ancestor.type !== 'tree') throw new Error('Non-directory path ancestor');
      }
      if (changes.some(other => other !== change && change.path.startsWith(`${other.path}/`))) {
        throw new Error('Conflicting file and directory changes');
      }
    }
    if (head !== job.inputSha) {
      const expected = new Map([...sourceTree].filter(([, entry]) => entry.type !== 'tree')
        .map(([path, entry]) => [path, { type: entry.type, mode: entry.mode, sha: entry.sha }]));
      for (const change of changes) {
        if (change.content === null) expected.delete(change.path);
        else expected.set(change.path, {
          type: 'blob', mode: sourceTree.get(change.path)?.mode === '100755' ? '100755' : '100644',
          sha: createHash('sha1').update(`blob ${Buffer.byteLength(change.content)}\0`).update(change.content).digest('hex'),
        });
      }
      const actual = new Map([...(await this.tree(head)).files].filter(([, entry]) => entry.type !== 'tree'));
      if (actual.size !== expected.size || [...expected].some(([path, entry]) => {
        const published = actual.get(path);
        return !published || published.sha !== entry.sha || published.mode !== entry.mode || published.type !== entry.type;
      })) throw new Error('Published tree does not match the registered job proposal');
      return head;
    }
    const { data: tree } = await this.api.git.createTree({ ...this.scope, base_tree: source.sha,
      tree: changes.map(change => ({ path: change.path,
        mode: sourceTree.get(change.path)?.mode === '100755' ? '100755' as const : '100644' as const,
        type: 'blob' as const, ...(change.content === null ? { sha: null } : { content: change.content }),
      })),
    });
    const { data: commit } = await this.api.git.createCommit({ ...this.scope, message, tree: tree.sha, parents: [job.inputSha] });
    if (await this.head(state.branch) !== job.inputSha) throw new Error('Working branch moved before publication');
    await this.api.git.updateRef({ ...this.scope, ref: `heads/${state.branch}`, sha: commit.sha, force: false });
    return commit.sha;
  }

  async publish(state: Lifecycle): Promise<number> {
    assertPublishable(state);
    if (await this.head(state.branch) !== state.headSha) throw new Error('Final branch differs from reviewed commit');
    const marker = `<!-- sdlc:feature:${state.issueNumber}:${state.plan!.hash} -->`;
    const existing = await this.api.paginate(this.api.pulls.list, { ...this.scope, state: 'all',
      head: `${this.scope.owner}:${state.branch}`, base: state.baseBranch, per_page: 100 });
    const mine = existing.filter(candidate => candidate.user?.login === this.botLogin && candidate.body?.startsWith(marker));
    if (existing.length > mine.length) throw new Error('Working branch already has an unrelated pull request');
    let pullNumber = mine.find(candidate => candidate.state === 'open')?.number;
    if (!pullNumber && mine.length) throw new Error('The feature pull request for this plan was already closed');
    const issueUrl = `https://github.com/${this.scope.owner}/${this.scope.repo}/issues/${state.issueNumber}`;
    const runUrl = (id: number) => `https://github.com/${this.control.owner}/${this.control.repo}/actions/runs/${id}`;
    const evidence = state.evidence.map(item => boundedMarkdown(
      `- **${item.stage}**: ${neutralizeClosingKeywords(item.summary)}\n  ` +
      `[Run ${item.runId}](${runUrl(item.runId)})`,
      1400, `[Full report and evidence](${runUrl(item.runId)})`,
    )).join('\n');
    const active = activeDecisions(state);
    const decisionSummaryBudget = active.length ? Math.floor(22_000 / active.length) : 1400;
    const decisions = active.map(item => {
      const grant = state.plan!.policy?.decisionGrants?.find(candidate => candidate.id === item.grantId);
      const option = grant?.options.find(candidate => candidate.id === item.optionId);
      const choice = grant && option ? `${grant.question}: ${option.description}` : `${item.grantId}/${item.optionId}`;
      const summary = `- **${neutralizeClosingKeywords(item.grantId)} / ${neutralizeClosingKeywords(item.optionId)}: ` +
        `${neutralizeClosingKeywords(choice)}**: ` +
        `${neutralizeClosingKeywords(item.rationale)}\n  ` +
        `Evidence: ${item.evidence.map(neutralizeClosingKeywords).join('; ')}. ` +
        `[Decision run ${item.job.runId}](${runUrl(item.job.runId!)})`;
      return boundedMarkdown(summary, Math.min(1400, decisionSummaryBudget),
        `[Full decision rationale and evidence in the issue timeline](${issueUrl})`);
    }).join('\n');
    if (!pullNumber) {
      const configuration = neutralizeClosingKeywords(JSON.stringify({
        SDLC_MODEL: this.model,
        SDLC_AIC_CREDIT_LIMIT: this.policy.maxJobCredits,
      }, null, 2));
      const plan = boundedMarkdown(neutralizeClosingKeywords(state.plan!.body), 18_000,
        `[Full approved plan and approval record](${issueUrl})`);
      const body = `${marker}\nCloses #${state.issueNumber}\n\n## Approved plan\n\n${plan}\n\n` +
        `Approved by @${state.approval!.actor}. Plan hash: \`${state.plan!.hash}\`.\n\n` +
        `## Delegated decisions\n\n${decisions || 'None'}\n\n` +
        `Full decision rationale and evidence are recorded in the [issue timeline](${issueUrl}).\n\n` +
        `Reviewed commit: \`${state.headSha}\`.\n\n## Cost\n\n` +
        `Configuration at PR creation:\n\n\`\`\`json\n${configuration}\n\`\`\`\n\n` +
        'The model setting is a configured selector, not a resolved per-run model. ' +
        'The credit limit applies separately to each inference job, not each turn; earlier runs may have used different settings.\n\n' +
        `**Observed agent models:** ${formatObservedModels(state.spend.models)}.\n\n` +
        'From available primary-agent token-usage telemetry only. Multiple models may be observed, including with auto selection. ' +
        'Missing/legacy runs and separate detection inference are not covered; this is not a billing breakdown.\n\n' +
        `Cost snapshot at PR creation. [Lifecycle status](${issueUrl}) ` +
        'tracks later cost settlement.\n\n' +
        (state.pendingCosts?.length ? `**Pending cost collection:** ${state.pendingCosts.length} job(s) are excluded from these totals.\n\n` : '') +
        (state.spend.historyComplete ? '' :
          '**Partial cost history:** earlier costs unavailable. Totals cover recorded runs only.\n\n') +
        `${(state.spend.runnerMs / 60_000).toFixed(1)} runner minutes and ` +
        `${state.spend.credits.toFixed(1)} AI credits across ${state.spend.runs} runs, ` +
        `including retries, repairs, and superseded plans. ` +
        `${state.spend.nearLimit} run(s) finished near the per-job credit limit; ` +
        `${state.spend.preempted} were pre-empted by it.\n\n## Evidence\n\n${evidence}\n\n` +
        'Agent reviews are advisory. A human must review and merge this PR. No automatic merge is enabled.';
      if (Buffer.byteLength(body, 'utf8') > 60_000) {
        throw new Error('Rendered pull request body exceeds its safe publication budget');
      }
      pullNumber = (await this.api.pulls.create({ ...this.scope, head: state.branch, base: state.baseBranch, draft: false,
        title: `[Agentic SDLC] ${(await this.issue(state.issueNumber)).title}`.slice(0, 200),
        body,
      })).data.number;
    }
    const reviewMarker = `<!-- sdlc:review:${state.headSha} -->`;
    const reviews = await this.api.paginate(this.api.pulls.listReviews, { ...this.scope, pull_number: pullNumber, per_page: 100 });
    if (!reviews.some(review => review.user?.login === this.botLogin && review.body.startsWith(reviewMarker))) {
      await this.api.pulls.createReview({ ...this.scope, pull_number: pullNumber, commit_id: state.headSha,
        event: 'COMMENT', body: `${reviewMarker}\n## Independent agent review\n\n` +
          neutralizeClosingKeywords(state.evidence.find(item => item.stage === 'review')!.summary) });
    }
    const checks = await this.api.paginate(this.api.checks.listForRef, { ...this.scope, ref: state.headSha, check_name: 'SDLC / Complete', per_page: 100 });
    if (!checks.some(check => `${check.app?.slug}[bot]` === this.botLogin && check.conclusion === 'success')) {
      await this.api.checks.create({ ...this.scope, name: 'SDLC / Complete', head_sha: state.headSha,
        status: 'completed', conclusion: 'success', output: { title: 'Approved plan and current-commit gates passed', summary: evidence } });
    }
    return pullNumber;
  }

  async pullRequest(number: number): Promise<'open' | 'closed' | 'merged'> {
    const { data } = await this.api.pulls.get({ ...this.scope, pull_number: number });
    return data.merged ? 'merged' : data.state === 'closed' ? 'closed' : 'open';
  }

  async closeTasks(state: Lifecycle): Promise<void> {
    for (const task of state.tasks) {
      if (task.issueNumber) await this.api.issues.update({ ...this.scope, issue_number: task.issueNumber,
        state: 'closed', state_reason: 'completed' });
    }
  }

  async retireTasks(numbers: number[]): Promise<void> {
    for (const number of numbers) await this.api.issues.update({ ...this.scope, issue_number: number,
      state: 'closed', state_reason: 'not_planned' });
  }
}