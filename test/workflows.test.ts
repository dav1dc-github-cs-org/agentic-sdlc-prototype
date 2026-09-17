import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { costSchema, resolvePolicy } from '../src/contracts.ts';

const read = (name: string) => parse(readFileSync(`.github/workflows/${name}`, 'utf8'));

test('controller listens for intake, new commands, completion, and recovery events', () => {
  const workflow = read('sdlc-controller.yml');
  assert.deepEqual(workflow.on.issue_comment.types, ['created']);
  assert.ok(workflow.on.issues.types.includes('labeled'));
  assert.ok(workflow.on.schedule.length);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.reconcile.environment, 'sdlc-controller');
  assert.match(workflow.jobs.reconcile.if, /SDLC_ENABLED/);
  assert.match(workflow.jobs.reconcile.if, /default_branch/);
});

test('controller fails loudly when the worker actor gate cannot match the App', () => {
  const steps = read('sdlc-controller.yml').jobs.reconcile.steps as { run?: string; env?: Record<string, string> }[];
  const guard = steps.find(step => step.env?.expected === '${{ vars.SDLC_APP_SLUG }}');
  assert.ok(guard, 'the controller must compare SDLC_APP_SLUG against the minted App slug');
  assert.equal(guard.env?.actual, '${{ steps.app.outputs.app-slug }}');
  assert.match(guard.run ?? '', /exit 1/);
  assert.ok(steps.indexOf(guard) < steps.findIndex(step => step.run?.includes('src/main.ts')));
});

test('generated agents have no publishing credentials or direct write permissions', () => {
  const source = readFileSync('.github/workflows/sdlc-agent.md', 'utf8');
  const frontmatter = parse(source.split('---')[1]!);
  assert.equal(frontmatter.permissions.contents, 'read');
  assert.equal(frontmatter.permissions.issues, 'read');
  assert.equal(frontmatter.permissions['pull-requests'], 'read');
  assert.equal(frontmatter.checkout[0].ref, '${{ github.sha }}');
  assert.equal(frontmatter.engine.env.GH_AW_MAX_AI_CREDITS, '${{ needs.budget.outputs.credit_limit }}');
  assert.equal(frontmatter['safe-outputs']['report-failure-as-issue'], false);
  assert.equal(frontmatter['safe-outputs']['report-failed-jobs'], false);
  assert.equal(frontmatter['safe-outputs']['missing-tool'], false);
  assert.equal(frontmatter['safe-outputs']['missing-data'], false);
  assert.equal(frontmatter['safe-outputs']['report-incomplete']['create-issue'], false);
  assert.equal(source.includes('SDLC_APP_PRIVATE_KEY'), false);
  assert.equal(source.includes('create-github-app-token'), false);
  assert.equal(source.includes('create-pull-request:'), false);
  const compiled = read('sdlc-agent.lock.yml');
  assert.equal(compiled.jobs.agent.permissions.contents, 'read');
  const mutationScopes = ['contents', 'issues', 'pull-requests', 'checks', 'deployments', 'packages', 'security-events'];
  for (const job of Object.values(compiled.jobs) as { permissions?: Record<string, string> }[]) {
    for (const scope of mutationScopes) assert.notEqual(job.permissions?.[scope], 'write');
  }
  const serialized = JSON.stringify(compiled);
  assert.equal(serialized.includes('"GH_AW_REPORT_INCOMPLETE_CREATE_ISSUE":"true"'), false);
  assert.equal(serialized.includes('"GH_AW_REPORT_INCOMPLETE_CREATE_ISSUE":"false"'), true);
});

test('agents use the repository model with an auto fallback for inference and metadata', () => {
  const source = readFileSync('.github/workflows/sdlc-agent.md', 'utf8');
  const frontmatter = parse(source.split('---')[1]!);
  const model = "${{ vars.SDLC_MODEL || 'auto' }}";
  assert.equal(frontmatter.engine.id, 'copilot');
  assert.equal(frontmatter.engine.model, model);
  const compiled = read('sdlc-agent.lock.yml');
  for (const [job, variable] of [
    ['activation', 'GH_AW_INFO_MODEL'],
    ['agent', 'COPILOT_MODEL'],
    ['detection', 'COPILOT_MODEL'],
  ] as const) {
    const steps = compiled.jobs[job].steps as { env?: Record<string, string> }[];
    const modelSteps = steps.filter(step => step.env?.[variable] !== undefined);
    assert.ok(modelSteps.length > 0, `${job} must explicitly select its model`);
    for (const step of modelSteps) assert.equal(step.env?.[variable], model);
  }
  const controller = read('sdlc-controller.yml').jobs.reconcile.steps.find((step: { run?: string }) => step.run === 'node src/main.ts');
  assert.equal(controller.env.SDLC_MODEL, model);
});

test('checks cannot pass by silently skipping a required stage', () => {
  const workflow = read('sdlc-checks.yml');
  assert.deepEqual(workflow.jobs.result.needs, ['prepare', 'codeql', 'security', 'tests', 'integration']);
  assert.match(workflow.jobs.result.if, /always\(\)/);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.jobs.tests.permissions, undefined);
  assert.equal(JSON.stringify(workflow.jobs.tests).includes('secrets.'), false);
  assert.equal(workflow.jobs.codeql.steps.find((step: { uses?: string }) => step.uses?.includes('/init@')).with['build-mode'], 'none');
  assert.equal(workflow.jobs.codeql.outputs.diagnostics, '${{ steps.findings.outputs.diagnostics }}');
  const gate = workflow.jobs.codeql.steps.find((step: { id?: string }) => step.id === 'findings');
  assert.match(gate.run, /validate\.ts sarif/);
  assert.equal(gate['continue-on-error'], undefined);
  const result = workflow.jobs.result.steps.find((step: { env?: Record<string, string> }) => step.env?.SDLC_CHECK_RESULTS);
  assert.equal(result.env.SDLC_CHECK_RESULTS, '${{ toJSON(needs) }}');
});

test('preflight and integration workflows retain read-only credentials and the required scanner policy', () => {
  const checks = read('sdlc-checks.yml');
  assert.equal(checks.jobs.prepare.outputs.scan_sha, '${{ steps.context.outputs.scan_sha }}');
  assert.equal(checks.jobs.codeql.outputs.blocker, '${{ steps.findings.outputs.blocker }}');
  for (const name of ['codeql', 'security']) {
    assert.ok(checks.jobs[name].steps.some((step: { run?: string }) => step.run === 'node control/src/worker.ts dependencies'));
    const source = checks.jobs[name].steps.find((step: { with?: { path?: string } }) => step.with?.path === 'source');
    assert.equal(source.with.ref, '${{ needs.prepare.outputs.scan_sha }}');
  }
  assert.equal(checks.jobs.integration.outputs.integration_hash, '${{ steps.merge.outputs.integration_hash }}');
  assert.equal(JSON.stringify(checks.jobs.integration).includes('SDLC_APP_PRIVATE_KEY'), false);
  const ci = read('ci.yml').jobs.codeql;
  assert.equal(ci.permissions.contents, 'read');
  assert.equal(ci.steps.find((step: { uses?: string }) => step.uses?.includes('/init@')).with.queries, 'security-extended');
  const gate = ci.steps.find((step: { run?: string }) => step.run?.includes('validate.ts sarif'));
  assert.ok(gate);
  assert.equal(gate['continue-on-error'], undefined);
});

test('manual workflows pin actions to immutable commits and never persist git credentials', () => {
  for (const name of ['ci.yml', 'sdlc-controller.yml', 'sdlc-checks.yml']) {
    for (const job of Object.values(read(name).jobs) as { steps: { uses?: string; with?: Record<string, unknown> }[] }[]) {
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
        if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with?.['persist-credentials'], false);
      }
    }
  }
});

test('cost accounting stays bound to the compiler and policy it measures', () => {
  const compiled = readFileSync('.github/workflows/sdlc-agent.lock.yml', 'utf8');
  // A renamed gh-aw step would silently report every run as never pre-empted.
  assert.ok(compiled.includes('id: parse-mcp-gateway'), 'the gh-aw gateway parser step must still exist');
  assert.match(compiled, /PREEMPTED: \$\{\{ steps\.parse-mcp-gateway\.outputs\.ai_credits_rate_limit_error \}\}/);
  const workflow = parse(compiled);
  const limit = '${{ needs.budget.outputs.credit_limit }}';
  assert.equal(workflow.jobs.budget.permissions.contents, undefined);
  assert.equal(workflow.jobs.budget.outputs.credit_limit, '${{ steps.limit.outputs.credit_limit }}');
  for (const name of ['agent', 'detection']) {
    assert.ok(workflow.jobs[name].needs.includes('budget'));
    const execution = workflow.jobs[name].steps.find((step: { env?: Record<string, string> }) => step.env?.COPILOT_MODEL);
    assert.equal(execution.env.GH_AW_MAX_AI_CREDITS, limit);
    assert.ok(/\\"maxAiCredits\\":\$\{GH_AW_MAX_AI_CREDITS\}/.test(execution.run));
  }
  const prepare = workflow.jobs.agent.steps.find((step: { run?: string }) => step.run?.includes('src/worker.ts prepare'));
  assert.equal(prepare.env.SDLC_AIC_CREDIT_LIMIT, limit);
  const receipt = workflow.jobs.agent.steps.find((step: { env?: Record<string, string> }) => step.env?.CREDIT_LIMIT);
  assert.equal(receipt.env.CREDIT_LIMIT, limit);
  assert.equal(receipt.env.TOKEN_USAGE_PATH, '/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl');
  const source = parse(readFileSync('.github/workflows/sdlc-agent.md', 'utf8').split('---')[1]!);
  assert.equal(receipt.run, source['post-steps'].find((step: { env?: Record<string, string> }) => step.env?.CREDIT_LIMIT).run);
  const controller = read('sdlc-controller.yml').jobs.reconcile.steps.find((step: { run?: string }) => step.run === 'node src/main.ts');
  assert.equal(controller.env.SDLC_AIC_CREDIT_LIMIT, "${{ vars.SDLC_AIC_CREDIT_LIMIT || '250' }}");
});

test('credit limit validation accepts bounded integers and rejects unsafe runtime values', () => {
  const source = parse(readFileSync('.github/workflows/sdlc-agent.md', 'utf8').split('---')[1]!);
  const step = source.jobs.budget.steps[0];
  assert.equal(step.env.SDLC_AIC_CREDIT_LIMIT, "${{ vars.SDLC_AIC_CREDIT_LIMIT || '250' }}");
  assert.equal(source['max-ai-credits'], undefined);
  const policy = JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8'));
  assert.equal(policy.maxJobCredits, 250);
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-credit-limit-'));
  try {
    for (const [index, value] of ['250', '1', '500', '10000', '0', '-1', '1.5', '10001', 'NaN',
      'auto', '1e3', '001', ' 250 ', '250\n', '1\n2', '1;exit 0', ''].entries()) {
      const output = join(directory, `${index}.txt`);
      const result = spawnSync('bash', ['-e', '-c', step.run], { encoding: 'utf8',
        env: { SDLC_AIC_CREDIT_LIMIT: value, GITHUB_OUTPUT: output } });
      if (index < 4) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, 'utf8'), `credit_limit=${value}\n`);
        assert.equal(resolvePolicy(policy, value).maxJobCredits, Number(value));
      } else {
        assert.equal(result.status, 1, value);
        assert.match(result.stdout, /SDLC_AIC_CREDIT_LIMIT must be a whole number/);
        assert.throws(() => readFileSync(output), /ENOENT/);
        if (value !== '') assert.throws(() => resolvePolicy(policy, value), /SDLC_AIC_CREDIT_LIMIT/);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('generated firewall configurations enforce the chosen limit instead of a compiler default', () => {
  const workflow = read('sdlc-agent.lock.yml');
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-firewall-budget-'));
  mkdirSync(join(directory, 'gh-aw'));
  try {
    for (const name of ['agent', 'detection']) {
      const execution = workflow.jobs[name].steps.find((step: { env?: Record<string, string> }) => step.env?.COPILOT_MODEL);
      const writeConfig = execution.run.split('\n').find((line: string) => line.startsWith("printf '%s\\n' ") && line.includes('awf-config.json'));
      assert.ok(writeConfig, 'the compiler must expose the runtime firewall configuration');
      for (const limit of [250, 575]) {
        const result = spawnSync('bash', ['-e', '-c', writeConfig], { encoding: 'utf8', env: {
          GH_AW_MAX_AI_CREDITS: String(limit), RUNNER_TEMP: directory,
        } });
        assert.equal(result.status, 0, result.stderr);
        const config = JSON.parse(readFileSync(join(directory, 'gh-aw/awf-config.json'), 'utf8'));
        assert.equal(config.apiProxy.maxAiCredits, limit);
        assert.equal(config.apiProxy.enabled, true);
        assert.equal(config.apiProxy.enableTokenSteering, true);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('cost receipts accept observed model IDs without inventing them for legacy runs', () => {
  const receipt = { credits: 12, preempted: false, creditLimit: 250 };
  assert.deepEqual(costSchema.parse(receipt), receipt);
  assert.deepEqual(costSchema.parse({ ...receipt, models: ['claude-sonnet-4.6', 'gpt-5.4'] }),
    { ...receipt, models: ['claude-sonnet-4.6', 'gpt-5.4'] });
  for (const models of [['auto'], ['AUTO'], ['unknown'], ['auto\n'], ['unknown\r'], ['model\n'],
    ['model\u2028'], [''], ['model\n## forged heading'], Array(21).fill('model')]) {
    assert.equal(costSchema.safeParse({ ...receipt, models }).success, false);
  }
});

test('workflow-written cost receipt includes the exact limit used by the inference jobs', () => {
  const source = parse(readFileSync('.github/workflows/sdlc-agent.md', 'utf8').split('---')[1]!);
  const step = source['post-steps'].find((step: { env?: Record<string, string> }) => step.env?.CREDIT_LIMIT);
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-cost-receipt-'));
  try {
    const summary = join(directory, 'summary.md');
    const result = spawnSync('bash', ['-e', '-c', step.run], { cwd: directory, encoding: 'utf8', env: {
      PATH: process.env.PATH, CREDITS: '401.5', PREEMPTED: 'true', CREDIT_LIMIT: '400', GITHUB_STEP_SUMMARY: summary,
    } });
    assert.equal(result.status, 0, result.stderr);
    const cost = costSchema.parse(JSON.parse(readFileSync(join(directory, '.sdlc-cost/cost.json'), 'utf8')));
    assert.deepEqual(cost, { credits: 401.5, preempted: true, creditLimit: 400, models: [],
      tokenUsage: { status: 'unavailable', models: [] } });
    assert.match(readFileSync(summary, 'utf8'), /400 AI credits/);
    assert.match(readFileSync(summary, 'utf8'), /Observed agent models: unavailable/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workflow cost receipts capture concrete usage models and tolerate unavailable telemetry', () => {
  const source = parse(readFileSync('.github/workflows/sdlc-agent.md', 'utf8').split('---')[1]!);
  const step = source['post-steps'].find((step: { env?: Record<string, string> }) => step.env?.CREDIT_LIMIT);
  assert.equal(step.env.TOKEN_USAGE_PATH, '/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl');
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-model-usage-'));
  try {
    const telemetry = join(directory, 'token-usage.jsonl');
    const linked = join(directory, 'linked.jsonl');
    symlinkSync(telemetry, linked);
    const entries = [
      { event: 'token_usage', model: 'gpt-5.4', input_tokens: 20, output_tokens: 5 },
      { model: 'claude-sonnet-4.6', input_tokens: 40, output_tokens: 10 },
      { model: 'gpt-5.4' }, { model: 'auto' }, { model: 'AUTO' }, { model: 'unknown' },
      { model: 'auto\n' }, { model: 'unknown\r' }, { model: 'model\n' }, { model: 'model\u2028' },
      { model: 'bad\n## heading' }, { model: {} }, { model: 'a'.repeat(129) },
      { event: 'request', model: 'unobserved-model' }, { requested_model: 'configured-model' }, null,
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n{"model":';
    for (const [content, path, expected] of [
      [entries, telemetry, ['claude-sonnet-4.6', 'gpt-5.4']],
      ['', telemetry, []], ['invalid\nnull\n[]', telemetry, []],
      [entries, join(directory, 'missing'), []], [entries, linked, []], [entries, directory, []],
      [' '.repeat(5_000_001) + entries, telemetry, []],
      [Array.from({ length: 21 }, (_, index) => JSON.stringify({ model: `model-${index}` })).join('\n'),
        telemetry, Array.from({ length: 21 }, (_, index) => `model-${index}`).sort().slice(0, 20)],
    ] as const) {
      writeFileSync(telemetry, content);
      const summary = join(directory, 'summary.md');
      const result = spawnSync('bash', ['-e', '-c', step.run], { cwd: directory, encoding: 'utf8', env: {
        PATH: process.env.PATH, CREDITS: '12', PREEMPTED: 'true', CREDIT_LIMIT: '250',
        TOKEN_USAGE_PATH: path, GITHUB_STEP_SUMMARY: summary,
      } });
      assert.equal(result.status, 0, result.stderr);
      const cost = costSchema.parse(JSON.parse(readFileSync(join(directory, '.sdlc-cost/cost.json'), 'utf8')));
      assert.deepEqual({ ...cost, tokenUsage: undefined },
        { credits: 12, preempted: true, creditLimit: 250, models: expected, tokenUsage: undefined });
      assert.equal(cost.tokenUsage!.status, expected.length ? 'partial' : 'unavailable');
      assert.deepEqual(cost.tokenUsage!.models.map(usage => usage.model), expected);
      assert.ok(readFileSync(summary, 'utf8').includes(`Observed agent models: ${expected.length ? expected.join(', ') : 'unavailable'}.`));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('model token receipts snapshot the selector and count each request once without inventing missing tokens', () => {
  const source = parse(readFileSync('.github/workflows/sdlc-agent.md', 'utf8').split('---')[1]!);
  const step = source['post-steps'].find((step: { env?: Record<string, string> }) => step.env?.CREDIT_LIMIT);
  assert.equal(step.env.REQUESTED_MODEL, source.engine.model);
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-attributed-tokens-'));
  try {
    const telemetry = join(directory, 'token-usage.jsonl');
    const first = { event: 'token_usage', request_id: 'first', model: 'gpt-5.4',
      input_tokens: 100, output_tokens: 20, cache_read_tokens: 40, cache_write_tokens: 0 };
    const second = { ...first, request_id: 'second', input_tokens: 80, output_tokens: 30, cache_read_tokens: 20 };
    const third = { ...first, request_id: 'third', model: 'claude-sonnet-4.6', input_tokens: 10 };
    const execute = (entries: unknown[], requestedModel = 'auto') => {
      writeFileSync(telemetry, entries.map(entry => JSON.stringify(entry)).join('\n'));
      const result = spawnSync('bash', ['-e', '-c', step.run], { cwd: directory, encoding: 'utf8', env: {
        PATH: process.env.PATH, CREDITS: '12', PREEMPTED: 'false', CREDIT_LIMIT: '250',
        REQUESTED_MODEL: requestedModel, TOKEN_USAGE_PATH: telemetry, GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
      } });
      assert.equal(result.status, 0, result.stderr);
      const raw = readFileSync(join(directory, '.sdlc-cost/cost.json'), 'utf8');
      assert.ok(Buffer.byteLength(raw) <= 10_000, 'enriched receipts must fit the existing artifact bound');
      return costSchema.parse(JSON.parse(raw));
    };
    const cost = execute([first, first, second, third]);
    assert.equal(cost.requestedModel, 'auto');
    assert.equal(cost.credits, 12);
    assert.deepEqual(cost.tokenUsage, { status: 'available', models: [
      { model: 'claude-sonnet-4.6', requests: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0 },
      { model: 'gpt-5.4', requests: 2, inputTokens: 180, outputTokens: 50, cacheReadTokens: 60, cacheWriteTokens: 0 },
    ] });
    for (const value of [undefined, null, -1, 0.5, '100', {}, { toString: null, valueOf: null }, Number.MAX_SAFE_INTEGER + 1]) {
      const partial = execute([first, { ...second, input_tokens: value }], 'claude-sonnet-4.6');
      assert.equal(partial.requestedModel, 'claude-sonnet-4.6');
      assert.equal(partial.tokenUsage!.status, 'partial');
      assert.deepEqual(partial.tokenUsage!.models, [
        { model: 'gpt-5.4', requests: 2, inputTokens: null, outputTokens: 50, cacheReadTokens: 60, cacheWriteTokens: 0 },
      ]);
    }
    assert.equal(execute([first], 'auto\n').requestedModel, undefined);
    assert.equal(execute([{ ...first, input_tokens: Number.MAX_SAFE_INTEGER }, second]).tokenUsage!.models[0]!.inputTokens, null);
    const maximum = execute(Array.from({ length: 20 }, (_, index) => ({ model: `m${index}`.padEnd(128, 'a'),
      input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER,
      cache_read_tokens: Number.MAX_SAFE_INTEGER, cache_write_tokens: Number.MAX_SAFE_INTEGER })), 'm'.repeat(128));
    assert.equal(maximum.models!.length, 20);
    assert.equal(maximum.tokenUsage!.status, 'available');
    for (const field of ['jobId', 'persona', 'stage', 'inputSha', 'planHash', 'approved']) {
      assert.equal(costSchema.safeParse({ ...cost, [field]: 'forged' }).success, false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workflow cost receipts distinguish missing signals from measured zero and false', () => {
  const source = parse(readFileSync('.github/workflows/sdlc-agent.md', 'utf8').split('---')[1]!);
  const step = source['post-steps'].find((step: { env?: Record<string, string> }) => step.env?.CREDIT_LIMIT);
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-missing-cost-'));
  try {
    for (const [credits, preempted, expectedCredits, expectedPreempted] of [
      ['', '', null, null], ['invalid', 'invalid', null, null], ['..', 'false', null, false],
      ['-1', 'false', null, false], ['Infinity', 'true', null, true],
      ['100001', 'true', null, true], ['0', 'false', 0, false], ['249', '', 249, null],
    ] as const) {
      const result = spawnSync('bash', ['-e', '-c', step.run], { cwd: directory, encoding: 'utf8', env: {
        PATH: process.env.PATH, CREDITS: credits, PREEMPTED: preempted, CREDIT_LIMIT: '250',
        GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
      } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(costSchema.parse(JSON.parse(readFileSync(join(directory, '.sdlc-cost/cost.json'), 'utf8'))),
        { credits: expectedCredits, preempted: expectedPreempted, creditLimit: 250, models: [],
          tokenUsage: { status: 'unavailable', models: [] } });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('shared worker instructions agree with the Documentation role on permitted edits', () => {
  const role = readFileSync('.github/agents/document.agent.md', 'utf8');
  assert.match(role, /Update only paths in `policy\.docsPaths`/);
  const instructions = readFileSync('.github/workflows/sdlc-agent.md', 'utf8').replace(/\s+/g, ' ');
  assert.match(instructions, /Only `code`, `test`, and `document` stages may propose file changes/);
  assert.match(instructions, /The `test` stage may change only paths in `policy\.testPaths`/);
  assert.match(instructions, /the `document` stage may change only paths in `policy\.docsPaths`/);
  assert.match(instructions, /do not override protected-path restrictions/);
  assert.match(instructions, /Existing baseline tests are immutable/);
  assert.match(instructions, /All other stages must leave the source checkout unchanged/);
  assert.doesNotMatch(instructions, /Only code and test stages may propose file changes/);
  const prompt = read('sdlc-agent.lock.yml').jobs.activation.steps.find(
    (step: { env?: Record<string, string> }) => step.env?.GH_AW_PROMPT_CONFIG);
  assert.ok(prompt);
  const config = JSON.parse(prompt.env.GH_AW_PROMPT_CONFIG);
  assert.ok(config.items.some((item: { content_env?: string }) => item.content_env &&
    prompt.env[item.content_env]?.trim() === '{{#runtime-import .github/workflows/sdlc-agent.md}}'));
});

test('research requires a product-fit architecture decision and blocks unsupported execution', () => {
  const source = readFileSync('.github/agents/research.agent.md', 'utf8');
  const profile = parse(source.split('---')[1]!);
  assert.equal(profile.name, 'sdlc-research');
  assert.deepEqual(profile.tools, ['read', 'search', 'execute']);
  assert.match(source, /## Technology and Architecture Decision/);
  for (const section of ['Application baseline', 'Product requirements', 'Options and tradeoffs',
    'Recommendation', 'Pipeline compatibility', 'Prerequisites']) {
    assert.ok(source.includes(`**${section}**`), `Research must address ${section}`);
  }
  const instructions = source.replace(/\s+/g, ' ');
  assert.match(instructions, /controller's implementation language does not dictate the application stack/);
  assert.match(instructions, /`supported`, `requires maintainer changes`, or `unknown`/);
  assert.match(instructions, /return `blocked`.*report's `summary`, not only in `plan`/);
  assert.match(instructions, /Plan approval does not authorize protected-path changes or weaker gates/);
});

test('coding requires scoped acceptance evidence, diagnostic repairs, and incomplete checkpoints', () => {
  const source = readFileSync('.github/agents/code.agent.md', 'utf8');
  const profile = parse(source.split('---')[1]!);
  assert.equal(profile.name, 'sdlc-code');
  assert.deepEqual(profile.tools, ['read', 'search', 'edit', 'execute']);
  for (const heading of ['Before Editing', 'Implementation and Verification', 'Before Returning']) {
    assert.ok(source.includes(`## ${heading}`));
  }
  for (const section of ['Scope and changes', 'Acceptance and evidence', 'Outstanding work', 'Stop reason and handoff']) {
    assert.ok(source.includes(`**${section}**`));
  }
  const instructions = source.replace(/\s+/g, ' ');
  assert.match(instructions, /Map each assigned acceptance criterion to an observable expected result/);
  assert.match(instructions, /exact worked examples.*boundaries, invalid inputs, no-ops, and deterministic replay/);
  assert.match(instructions, /Coverage percentage is not requirements coverage/);
  assert.match(instructions, /candidate regression, pre-existing or protected defect, or infrastructure\/tooling failure/);
  assert.match(instructions, /actual diagnostic for the registered source commit/);
  assert.match(instructions, /rule identifier, path, and line where available/);
  assert.match(instructions, /report the required maintainer action/);
  assert.match(instructions, /smallest coherent change, then immediately run the focused check/);
  assert.match(instructions, /without modifying baseline test files/);
  assert.match(instructions, /Treat test code as scanned source/);
  assert.match(instructions, /recheck the actual rule with approved available tooling/);
  assert.match(instructions, /consumer entry point.*working directory, server root, or package exports/);
  assert.match(instructions, /Static markup, CSS, or DOM-mock assertions do not prove browser rendering/);
  assert.match(instructions, /Do not add unapproved tooling/);
  assert.match(instructions, /Record exact commands, working directories, exit statuses/);
  assert.match(instructions, /`npm run verify` does not imply CodeQL ran/);
  assert.match(instructions, /outcome: "blocked"/);
  assert.match(instructions, /Coding work incomplete/);
  assert.match(instructions, /node control\/src\/worker\.ts collect/);
  assert.match(instructions, /Never leave a provisional `pass` on disk/);
  assert.match(instructions, /Do not estimate remaining credits/);
  assert.match(instructions, /runner termination can prevent upload/);
  assert.match(instructions, /untrusted diagnostics, not accepted changes or evidence/);
  assert.match(instructions, /Return `pass` only when the assigned work and required coding checks are complete/);
  assert.match(instructions, /Return `blocked` for unfinished work/);
  assert.match(instructions, /Downstream gates remain independent/);
});

test('security requires explicit completeness and non-passing review checkpoints', () => {
  const source = readFileSync('.github/agents/security.agent.md', 'utf8');
  const profile = parse(source.split('---')[1]!);
  assert.equal(profile.name, 'sdlc-security');
  assert.deepEqual(profile.tools, ['read', 'search', 'execute']);
  for (const heading of ['Risk-first Review', 'Checkpoints and Budget', 'Result Decision', 'Required Summary']) {
    assert.ok(source.includes(`## ${heading}`));
  }
  const instructions = source.replace(/\s+/g, ' ');
  for (const section of ['Scope and evidence', 'Review coverage', 'Findings', 'Outstanding work', 'Stop reason and handoff']) {
    assert.ok(source.includes(`**${section}**`));
  }
  assert.match(instructions, /outcome: "blocked"/);
  assert.match(instructions, /node control\/src\/worker\.ts collect/);
  assert.match(instructions, /Never leave a provisional `pass` on disk/);
  assert.match(instructions, /Return `blocked` if required review is unfinished/);
  assert.match(instructions, /do not equate it to remaining credits/);
  assert.match(instructions, /failed runs are untrusted diagnostics, never passing evidence/);
});

test('testing derives coverage from approved behavior and reports ambiguity and execution gaps', () => {
  const source = readFileSync('.github/agents/test.agent.md', 'utf8');
  const profile = parse(source.split('---')[1]!);
  assert.equal(profile.name, 'sdlc-test');
  assert.deepEqual(profile.tools, ['read', 'search', 'edit', 'execute']);
  for (const heading of ['Derive the Test Plan', 'Assertions and Execution', 'Scope and Result Decision', 'Required Summary']) {
    assert.ok(source.includes(`## ${heading}`));
  }
  for (const section of ['Expected behavior', 'Coverage map', 'Derived cases', 'Risk and order',
    'Test level and tooling', 'Ambiguity and gaps', 'Execution evidence', 'Defects and questions', 'Remaining work']) {
    assert.ok(source.includes(`**${section}**`));
  }
  const instructions = source.replace(/\s+/g, ' ');
  assert.match(instructions, /Fill missing test details, not missing product decisions/);
  assert.match(instructions, /Run every new or changed test/);
  assert.match(instructions, /Node or DOM-mock tests do not prove browser rendering/);
  assert.match(instructions, /Return `blocked` for ambiguous expected behavior/);
  assert.match(instructions, /Existing baseline test files are immutable/);
  assert.match(instructions, /proposed test changes are not published.*`changes_requested` report/);
});

test('every agent stage has a valid repository-scoped role profile', () => {
  const files = readdirSync('.github/agents');
  for (const stage of ['research', 'decompose', 'code', 'security', 'test', 'document', 'review']) {
    assert.ok(files.includes(`${stage}.agent.md`));
    const profile = parse(readFileSync(`.github/agents/${stage}.agent.md`, 'utf8').split('---')[1]!);
    assert.ok(profile.description.length > 30);
    assert.ok(profile.tools.length);
  }
});