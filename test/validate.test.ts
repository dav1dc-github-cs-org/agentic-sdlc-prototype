import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { policySchema } from '../src/contracts.ts';
import { runTestSuite, validateAudit, validateCoverage, validateSarif, validateSecrets } from '../src/validate.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const coverage = (lines: number, branches: number) => ({ total: { lines: { pct: lines }, branches: { pct: branches } } });

test('coverage must meet fixed thresholds and cannot regress against the baseline', () => {
  assert.doesNotThrow(() => validateCoverage(coverage(85, 75), coverage(90, 80), policy));
  assert.throws(() => validateCoverage(coverage(90, 80), coverage(85, 75), policy), /regressed/);
  assert.throws(() => validateCoverage(coverage(60, 50), coverage(79, 75), policy), /below/);
  assert.throws(() => validateCoverage({}, coverage(90, 80), policy));
  assert.throws(() => validateCoverage(coverage(90, 80), coverage(NaN, 80), policy));
});

test('dependency audit cannot pass with missing data or high-severity vulnerabilities', () => {
  assert.doesNotThrow(() => validateAudit({ metadata: { vulnerabilities: { high: 0, critical: 0 } } }));
  assert.throws(() => validateAudit({ metadata: { vulnerabilities: { high: 1, critical: 0 } } }), /vulnerabilities/);
  assert.throws(() => validateAudit({ error: 'Network unavailable' }));
});

test('CodeQL findings are evaluated from rule metadata, not agent opinion', () => {
  const clean = { runs: [{ tool: { driver: { rules: [{ id: 'injection', properties: { 'security-severity': '8.1' } }] } }, results: [] }] };
  assert.doesNotThrow(() => validateSarif(clean));
  assert.throws(() => validateSarif({ runs: [] }));
  assert.throws(() => validateSarif({ runs: [{ ...clean.runs[0], results: [{ ruleId: 'injection', level: 'warning' }] }] }), /blocking/);
  assert.throws(() => validateSarif({ runs: [{ ...clean.runs[0], results: [{ ruleId: 'unknown' }] }] }), /unclassified/);
  assert.doesNotThrow(() => validateSarif({ runs: [{ tool: { driver: { rules: [
    { id: 'low', properties: { 'security-severity': '3.0' } },
  ] } }, results: [{ ruleIndex: 0, level: 'warning' }] }] }));
});

test('severity declared by a query pack extension is honoured instead of blocking blindly', () => {
  const extended = { runs: [{
    tool: { driver: { rules: [] }, extensions: [{ rules: [
      { id: 'pack/low', properties: { 'security-severity': '2.5' } },
      { id: 'pack/high', properties: { 'security-severity': '9.0' } },
    ] }] },
    results: [{ ruleId: 'pack/low', level: 'warning' }],
  }] };
  assert.doesNotThrow(() => validateSarif(extended));
  assert.throws(() => validateSarif({ runs: [{ ...extended.runs[0],
    results: [{ ruleId: 'pack/high', level: 'warning' }] }] }), /blocking/);
  assert.doesNotThrow(() => validateSarif({ runs: [{ ...extended.runs[0],
    results: [{ rule: { index: 0, toolComponent: { index: 0 } }, level: 'warning' }] }] }));
});

test('CodeQL diagnostics identify blocking locations and bound untrusted metadata', () => {
  const rule = { id: 'js/regex/missing-regexp-anchor', properties: { 'security-severity': '7.8' } };
  const finding = { ruleIndex: 0, locations: [{ physicalLocation: {
    artifactLocation: { uri: 'test/turtle-graphics/ui.test.ts' }, region: { startLine: 93 },
  } }] };
  assert.throws(() => validateSarif({ runs: [{ tool: { driver: { rules: [rule] } }, results: [finding] }] }),
    /js\/regex\/missing-regexp-anchor at test\/turtle-graphics\/ui.test.ts:93 \(security severity 7\.8\)/);
  assert.throws(() => validateSarif({ runs: [{ tool: { driver: {} }, results: [{}] }] }),
    /unknown rule at unknown location \(security severity unclassified\)/);
  const metadata = 'untrusted\noutput=pass\r\n' + 'x'.repeat(2000);
  const oversized = { ruleId: metadata, level: 'error', locations: [{ physicalLocation: {
    artifactLocation: { uri: metadata },
  } }] };
  assert.throws(() => validateSarif({ runs: [{ tool: { driver: {} }, results: Array(12).fill(oversized) }] }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /12 blocking/);
    assert.match(error.message, /2 additional findings omitted/);
    assert.ok(error.message.length <= 6000);
    assert.equal(error.message.split('\n').length, 12);
    assert.doesNotMatch(error.message, /\r/);
    return true;
  });
});

test('CodeQL entry point emits JSON-encoded failure diagnostics without passing the gate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-codeql-'));
  const output = join(directory, 'github-output.txt');
  const sarif = join(directory, 'javascript.sarif');
  const script = resolve('src/validate.ts');
  const execute = (input: unknown) => {
    writeFileSync(output, '');
    if (input === undefined) rmSync(sarif, { force: true });
    else writeFileSync(sarif, JSON.stringify(input));
    return spawnSync(process.execPath, [script, 'sarif', directory], {
      encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output },
    });
  };
  try {
    const finding = { runs: [{ tool: { driver: { rules: [{
      id: 'pack/high', properties: { 'security-severity': '8.1' },
    }] } }, results: [{ ruleIndex: 0, locations: [{ physicalLocation: {
      artifactLocation: { uri: 'src/feature.ts\nforged=pass' }, region: { startLine: 12 },
    } }] }] }] };
    for (const [input, expected] of [
      [finding, /pack\/high at src\/feature\.ts forged=pass:12/],
      [{ runs: [] }, /too_small/],
      [undefined, /did not produce a SARIF report/],
    ] as const) {
      const result = execute(input);
      assert.notEqual(result.status, 0);
      assert.equal(result.error, undefined);
      const lines = readFileSync(output, 'utf8').split('\n');
      assert.equal(lines.length, input === finding ? 3 : 2);
      assert.equal(lines[lines.length - 1], '');
      assert.ok(lines[0]!.startsWith('diagnostics='));
      const diagnostics = JSON.parse(lines[0]!.slice('diagnostics='.length));
      assert.match(diagnostics, expected);
      assert.ok(diagnostics.length <= 6000);
      if (input === finding) {
        assert.ok(lines[1]!.startsWith('blocker='));
        assert.equal(JSON.parse(lines[1]!.slice('blocker='.length)).diagnostics[0].tool, 'codeql');
      }
    }
    const clean = execute({ runs: [{ tool: { driver: {} }, results: [] }] });
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(readFileSync(output, 'utf8'), '');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('secret findings and malformed scanner output block the gate', () => {
  assert.doesNotThrow(() => validateSecrets([]));
  assert.throws(() => validateSecrets([{ RuleID: 'credential' }]), /potential credentials/);
  assert.throws(() => validateSecrets({ success: true }));
});

test('the test runner executes real tests and measures their coverage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-tests-'));
  const sensitive = ['GH_TOKEN', 'GITHUB_TOKEN', 'SDLC_APP_PRIVATE_KEY', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT'];
  const previous = new Map(sensitive.map(name => [name, process.env[name]]));
  for (const name of sensitive) process.env[name] = `sentinel-${name}`;
  try {
    mkdirSync(join(directory, 'src'));
    mkdirSync(join(directory, 'test'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true }, include: ['src'] }));
    writeFileSync(join(directory, 'src/add.js'), 'export const add = (first, second) => first + second;\n');
    writeFileSync(join(directory, 'test/add.test.js'),
      'import assert from "node:assert/strict"; import test from "node:test"; import { add } from "../src/add.js"; ' +
      `for (const name of ${JSON.stringify(sensitive)}) assert.notEqual(process.env[name], "sentinel-" + name); ` +
      'for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "SDLC_APP_PRIVATE_KEY", "NODE_OPTIONS"]) assert.equal(process.env[name], undefined); ' +
      'assert.ok(process.env.PATH); test("adds", () => assert.equal(add(2, 3), 5));\n');
    const fixturePolicy = { ...policy, testPaths: ['test/*.test.js'], sourcePaths: ['src/*.js'] };
    const measured = runTestSuite(directory, fixturePolicy, join(directory, 'coverage'));
    assert.equal(measured.total.lines.pct, 100);
    writeFileSync(join(directory, 'test/add.test.js'), 'throw new Error("regression");\n');
    assert.throws(() => runTestSuite(directory, fixturePolicy, join(directory, 'failed')), /execution failed/);
    assert.throws(() => runTestSuite(directory, { ...fixturePolicy, testPaths: ['missing/*'] }, join(directory, 'empty')), /No tests/);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});