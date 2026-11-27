import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test, { beforeEach } from 'node:test';
import { renderIntakeWorkflow } from '../src/receipts.ts';
import { intakeTemplate, parseRegistry, registryPath, type Registry } from '../src/targets.ts';

type Route = { status?: number; body?: unknown; message?: string };
type Routes = Record<string, Route>;
type Call = { method: string; path: string; body?: Record<string, unknown> };

const setupScript = resolve('scripts/sdlc-target-setup.sh');
const verifyScript = resolve('scripts/sdlc-target-verify.sh');
const shell = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const hasJq = !spawnSync('jq', ['--version']).error;
const skip = hasJq ? false : 'jq is not installed';
const label = (JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')) as { label: string }).label;
const template = readFileSync(intakeTemplate, 'utf8');

const control = 'ctl-org/control';
const target = 'ctl-org/app';
const head = 'a'.repeat(40);
const older = 'b'.repeat(40);
const branch = `sdlc/intake-${head.slice(0, 12)}`;
const caller = renderIntakeWorkflow(template, control, head, label);
const callerPath = `repos/${target}/contents/.github/workflows/sdlc-intake.yml`;
const encodedHead = encodeURIComponent(`ctl-org:${branch}`);
const pullUrl = `https://github.com/${target}/pull/7`;
const urls = (text: string) => text.match(/https:\/\/[^\s)]+/g) ?? [];

// Set SDLC_SCRIPT_TRANSCRIPTS to a file path to record each script run as Markdown review evidence.
const transcripts = process.env.SDLC_SCRIPT_TRANSCRIPTS;
let currentTest = '';
beforeEach(t => { currentTest = t.name; });

const fakeGh = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
let method;
let input = false;
let path;
for (let index = 1; index < args.length; index++) {
  const arg = args[index];
  if (arg === '-X') method = args[++index];
  else if (arg === '-H') index++;
  else if (arg === '--paginate') continue;
  else if (arg === '--input') input = args[++index] === '-';
  else if (arg.startsWith('-')) { process.stderr.write('fake gh: unsupported flag ' + arg + '\\n'); process.exit(3); }
  else path = arg.replace(/^\\//, '');
}
if (args[0] !== 'api' || !path) { process.stderr.write('fake gh: unsupported call\\n'); process.exit(3); }
method = method || (input ? 'POST' : 'GET');
const text = input ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ method, path, body: text ? JSON.parse(text) : undefined }) + '\\n');
const route = JSON.parse(fs.readFileSync(process.env.FAKE_GH_ROUTES, 'utf8'))[method + ' ' + path];
const status = route ? route.status || 200 : 404;
if (status >= 400) {
  process.stderr.write('gh: ' + ((route && route.message) || 'Not Found') + ' (HTTP ' + status + ')\\n');
  process.exit(1);
}
if (status !== 204) process.stdout.write(JSON.stringify(route.body === undefined ? {} : route.body));
`;

function content(text: string, sha = 'f'.repeat(40)) {
  return { body: { sha, content: Buffer.from(text).toString('base64').replace(/.{60}/g, '$&\n') } };
}

function entry(overrides: Partial<Registry['targets'][number]> = {}): Registry['targets'][number] {
  return {
    id: 2, repository: target, enabled: false, activatedAt: '2026-01-01T00:00:00Z',
    intake: { workflow: '.github/workflows/sdlc-intake.yml', receiptRef: head }, ...overrides,
  };
}

function registry(...targets: Registry['targets']): Registry {
  return { schemaVersion: 1, targets };
}

// A private org-owned control and target where every check passes or can be fixed by the script.
function routes(published: Registry = registry()): Routes {
  return {
    [`GET repos/${control}`]: { body: {
      full_name: control, id: 1, visibility: 'private', default_branch: 'main', owner: { login: 'ctl-org', type: 'Organization' },
    } },
    [`GET repos/${control}/git/ref/heads/main`]: { body: { object: { sha: head } } },
    [`GET repos/${control}/contents/.github/sdlc/policy.json?ref=${head}`]: content(readFileSync('.github/sdlc/policy.json', 'utf8')),
    [`GET repos/${control}/contents/${intakeTemplate}?ref=${head}`]: content(template),
    [`GET repos/${control}/contents/${registryPath}?ref=${head}`]: content(JSON.stringify(published)),
    [`GET repos/${control}/actions/permissions/access`]: { body: { access_level: 'none' } },
    [`PUT repos/${control}/actions/permissions/access`]: { status: 204 },
    [`GET repos/${control}/actions/variables/SDLC_APP_ID`]: { body: { name: 'SDLC_APP_ID', value: '101' } },
    [`GET repos/${control}/environments/sdlc-controller/secrets/SDLC_APP_PRIVATE_KEY`]: { body: { name: 'SDLC_APP_PRIVATE_KEY' } },
    [`GET repos/${control}/environments/sdlc-reader/variables/SDLC_READER_APP_ID`]: { body: { name: 'SDLC_READER_APP_ID', value: '202' } },
    [`GET repos/${control}/environments/sdlc-reader/secrets/SDLC_READER_PRIVATE_KEY`]: { body: { name: 'SDLC_READER_PRIVATE_KEY' } },
    [`GET repos/${control}/contents/.github/workflows/sdlc-intake-receipt.yml?ref=${head}`]: content('name: receipt\n'),
    [`GET repos/${control}/compare/${head}...${head}`]: { body: { status: 'identical', ahead_by: 0 } },
    [`GET repos/${target}`]: { body: {
      full_name: target, id: 2, visibility: 'private', default_branch: 'main', owner: { login: 'ctl-org', type: 'Organization' },
      archived: false, disabled: false, has_issues: true, permissions: { admin: true },
    } },
    [`GET repos/${target}/actions/permissions`]: { body: { enabled: true, allowed_actions: 'all' } },
    'GET user/installations': { body: { total_count: 2, installations: [
      { id: 11, app_id: 101, account: { login: 'ctl-org' }, repository_selection: 'selected', suspended_at: null,
        permissions: { actions: 'read', checks: 'write', contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' } },
      { id: 22, app_id: 202, account: { login: 'ctl-org' }, repository_selection: 'selected', suspended_at: null,
        permissions: { contents: 'read', metadata: 'read' } },
    ] } },
    'GET user/installations/11/repositories': { body: { repositories: [{ id: 99 }] } },
    'PUT user/installations/11/repositories/2': { status: 204 },
    'GET user/installations/22/repositories': { body: { repositories: [{ id: 2 }] } },
    [`POST repos/${target}/labels`]: { status: 201, body: { name: label } },
    [`GET repos/${target}/pulls?state=open&head=${encodedHead}`]: { body: [] },
    [`GET repos/${target}/git/ref/heads/main`]: { body: { object: { sha: 'c'.repeat(40) } } },
    [`POST repos/${target}/git/refs`]: { status: 201, body: { ref: `refs/heads/${branch}` } },
    [`PUT ${callerPath}`]: { status: 201, body: {} },
    [`POST repos/${target}/pulls`]: { status: 201, body: { html_url: `https://github.com/${target}/pull/7` } },
  };
}

// The intake caller and label already in place, as after the setup pull request merges.
function ready(published: Registry = registry(entry())): Routes {
  return {
    ...routes(published),
    [`GET repos/${control}/actions/permissions/access`]: { body: { access_level: 'organization' } },
    'GET user/installations/11/repositories': { body: { repositories: [{ id: 2 }] } },
    [`GET repos/${target}/labels/${label}`]: { body: { name: label } },
    [`GET ${callerPath}?ref=main`]: content(caller),
  };
}

function run(script: string, args: string[], routeTable: Routes, initial: Registry = registry()) {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-scripts-'));
  try {
    const bin = join(root, 'bin');
    const work = join(root, 'tmp');
    mkdirSync(bin);
    mkdirSync(work);
    writeFileSync(join(bin, 'gh'), fakeGh);
    chmodSync(join(bin, 'gh'), 0o755);
    writeFileSync(join(root, 'routes.json'), JSON.stringify(routeTable));
    writeFileSync(join(root, 'log'), '');
    const registryFile = join(root, 'targets.json');
    const before = `${JSON.stringify(initial, null, 2)}\n`;
    writeFileSync(registryFile, before);
    const result = spawnSync(shell, [script, '--control', control, '--registry', registryFile, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: work,
        FAKE_GH_ROUTES: join(root, 'routes.json'), FAKE_GH_LOG: join(root, 'log'),
      },
    });
    const calls = readFileSync(join(root, 'log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Call);
    const after = readFileSync(registryFile, 'utf8');
    assert.deepEqual(readdirSync(work), [], 'the scripts must remove their working directory');
    const writes = calls.filter(call => call.method !== 'GET');
    if (transcripts) {
      const writeList = writes.map(call => `- \`${call.method} ${call.path}\``).join('\n') || '- None';
      const output = `${result.stdout}${result.stderr}`.replaceAll(root, '<tmp>');
      appendFileSync(transcripts, `## ${currentTest}\n\n\`\`\`console\n$ ${basename(script)} ${args.join(' ')}\n`
        + `${output}\`\`\`\n\nExit status ${result.status}. GitHub writes:\n\n${writeList}\n\n`
        + `Registry ${after === before ? 'unchanged' : 'changed'}.\n\n`);
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, before, after, writes };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeKeys(calls: Call[]): string[] {
  return calls.map(call => `${call.method} ${call.path}`);
}

test('setup dry run only reads from GitHub and leaves the registry unchanged', { skip }, () => {
  const result = run(setupScript, ['--target', target], routes());
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.writes, []);
  assert.equal(result.after, result.before);
  for (const change of ['access level', 'Add ctl-org/app to the Controller App', `Create label '${label}'`, 'open a pull request', 'Register ctl-org/app']) {
    assert.match(result.stdout, new RegExp(`\\[plan\\].*${change}`));
  }
  assert.match(result.stdout, /Re-run with --apply/);
});

test('setup --apply makes each planned change once and renders the caller the controller expects', { skip }, () => {
  const result = run(setupScript, ['--target', target, '--apply'], routes());
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(writeKeys(result.writes), [
    `PUT repos/${control}/actions/permissions/access`,
    'PUT user/installations/11/repositories/2',
    `POST repos/${target}/labels`,
    `POST repos/${target}/git/refs`,
    `PUT ${callerPath}`,
    `POST repos/${target}/pulls`,
  ]);
  const [access, , labelBody, ref, file, pull] = result.writes.map(call => call.body);
  assert.deepEqual(access, { access_level: 'organization' });
  assert.equal(labelBody?.name, label);
  assert.deepEqual(ref, { ref: `refs/heads/${branch}`, sha: 'c'.repeat(40) });
  assert.equal(file?.branch, branch);
  assert.equal(file?.sha, undefined);
  assert.equal(Buffer.from(String(file?.content), 'base64').toString('utf8'), caller);
  assert.deepEqual([pull?.head, pull?.base], [branch, 'main']);
  const written = parseRegistry(JSON.parse(result.after), { id: 1, repository: control });
  assert.equal(result.after, `${JSON.stringify(written, null, 2)}\n`);
  assert.deepEqual({ ...written.targets[0], activatedAt: undefined }, { ...entry(), activatedAt: undefined });
  assert.ok(urls(result.stdout).some((url) => url === pullUrl), result.stdout);
});

test('setup --apply refuses every change when any check fails', { skip }, () => {
  const table = routes();
  table[`GET repos/${target}`] = { body: { ...(table[`GET repos/${target}`]!.body as object), visibility: 'public' } };
  const result = run(setupScript, ['--target', target, '--apply'], table);
  assert.equal(result.status, 1);
  assert.deepEqual(result.writes, []);
  assert.equal(result.after, result.before);
  assert.match(result.stdout, /\[FAIL\].*cannot call a reusable workflow in a private repository/);
  assert.match(result.stdout, /No changes made/);
});

test('setup refuses a control repository more visible than the target', { skip }, () => {
  const table = routes();
  table[`GET repos/${control}`] = { body: { ...(table[`GET repos/${control}`]!.body as object), visibility: 'public' } };
  const result = run(setupScript, ['--target', target], table);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /A public control repository refuses a private target/);
});

test('setup renames a label whose case differs because receipts compare it exactly', { skip }, () => {
  const table = ready();
  table[`GET repos/${target}/labels/${label}`] = { body: { name: label.toLowerCase() } };
  table[`PATCH repos/${target}/labels/${label.toLowerCase()}`] = { body: { name: label } };
  const result = run(setupScript, ['--target', target, '--apply'], table, registry(entry()));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(writeKeys(result.writes), [`PATCH repos/${target}/labels/${label.toLowerCase()}`]);
  assert.deepEqual(result.writes[0]?.body, { new_name: label });
  assert.equal(result.after, result.before);
});

test('setup moves the receipt pin in the registry and the caller together', { skip }, () => {
  const result = run(setupScript, ['--target', target, '--receipt-ref', 'default'], ready(), registry(entry({
    enabled: true, intake: { workflow: '.github/workflows/sdlc-intake.yml', receiptRef: older },
  })));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`\\[plan\\].*Move the receipt pin of ${target} from ${older} to ${head}`));
  assert.match(result.stdout, /intake from ctl-org\/app stops while their pins differ/);
  assert.match(result.stdout, /\[ok\].*matches the template pinned/);
});

test('setup refuses a registry entry whose repository was renamed or recreated', { skip }, () => {
  const result = run(setupScript, ['--target', target], routes(), registry(entry({ repository: 'ctl-org/old-name' })));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /renamed or recreated repository needs a deliberate registry edit/);
});

test('setup reports App installations it cannot list instead of failing', { skip }, () => {
  const table = ready();
  table['GET user/installations'] = { status: 403, message: 'Resource not accessible by integration' };
  const result = run(setupScript, ['--target', target], table, registry(entry()));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[warn\].*Cannot list App installations.*Controller App \(101\)/);
  assert.match(result.stdout, /\[warn\].*Cannot list App installations.*Reader App \(202\)/);
});

test('setup flags a Reader App that holds more than read access to contents', { skip }, () => {
  const table = ready();
  const listing = table['GET user/installations']!.body as { installations: { permissions: Record<string, string> }[] };
  listing.installations[1]!.permissions.issues = 'write';
  listing.installations[0]!.permissions.checks = 'read';
  const result = run(setupScript, ['--target', target], table, registry(entry()));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[FAIL\].*Controller App installation 11 lacks checks: write/);
  assert.match(result.stdout, /\[warn\].*Reader App also holds issues/);
});

test('verify passes for a ready target, normalizing CRLF line endings in the caller', { skip }, () => {
  const table = ready();
  table[`GET ${callerPath}?ref=main`] = content(caller.replaceAll('\n', '\r\n'));
  const result = run(verifyScript, ['--target', target], table, registry(entry()));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.writes, []);
  assert.match(result.stdout, /is ready for intake/);
  assert.match(result.stdout, /Intake stays off until/);
});

test('verify fails when the caller differs from the rendered template', { skip }, () => {
  const table = ready();
  table[`GET ${callerPath}?ref=main`] = content(`${caller}# edited\n`);
  table[`GET repos/${target}/pulls?state=open&head=${encodedHead}`] = { body: [{ html_url: `https://github.com/${target}/pull/7` }] };
  const result = run(verifyScript, ['--target', target], table, registry(entry()));
  assert.equal(result.status, 1);
  assert.deepEqual(result.writes, []);
  assert.match(result.stdout, /\[FAIL\].*differs from the template pinned.*merge /);
  assert.ok(urls(result.stdout).some((url) => url === pullUrl), result.stdout);
});

test('verify warns when the registry on the control default branch differs from the local file', { skip }, () => {
  const result = run(verifyScript, ['--target', target], ready(registry()), registry(entry()));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[warn\].*not registered on main of ctl-org\/control yet/);
});

test('verify requires a registry entry', { skip }, () => {
  const result = run(verifyScript, ['--target', target], ready());
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not in .*targets.json; run scripts\/sdlc-target-setup.sh first/);
});

test('setup --enable verifies the target before enabling it and resets activation', { skip }, () => {
  const result = run(setupScript, ['--target', target, '--enable', '--apply'], ready(), registry(entry()));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.writes, []);
  const [enabled] = parseRegistry(JSON.parse(result.after)).targets;
  assert.equal(enabled?.enabled, true);
  assert.ok(Date.parse(enabled!.activatedAt) > Date.parse(entry().activatedAt));
  assert.match(result.stdout, /intake starts when it merges/);
});

test('setup --enable refuses a target whose caller has not merged', { skip }, () => {
  const table = ready();
  delete table[`GET ${callerPath}?ref=main`];
  const result = run(setupScript, ['--target', target, '--enable', '--apply'], table, registry(entry()));
  assert.equal(result.status, 1);
  assert.deepEqual(result.writes, []);
  assert.equal(result.after, result.before);
  assert.match(result.stdout, /Not enabling ctl-org\/app/);
});

test('setup --disable edits only the local registry', { skip }, () => {
  const result = run(setupScript, ['--target', 'CTL-ORG/App', '--disable', '--apply'], {}, registry(entry({ enabled: true })));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls, []);
  assert.equal(parseRegistry(JSON.parse(result.after)).targets[0]?.enabled, false);
});

test('scripts reject invalid usage before calling GitHub', { skip }, () => {
  for (const args of [[], ['--target', 'not a repo'], ['--target', target, '--enable', '--disable'],
    ['--target', target, '--enable', '--receipt-ref', head], ['--target', target, '--receipt-ref', 'main'], ['--target', control]]) {
    const result = run(setupScript, args, {});
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.deepEqual(result.calls, []);
  }
});

test('setup scripts pass shellcheck', { skip: spawnSync('shellcheck', ['--version']).error ? 'shellcheck is not installed' : false }, () => {
  const result = spawnSync('shellcheck', ['-x', setupScript, verifyScript, resolve('scripts/lib/sdlc-target.sh')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout);
});
