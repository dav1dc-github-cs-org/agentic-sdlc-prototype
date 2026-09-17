import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// REQ-013: the packaging script must produce a self-contained, relocatable
// folder whose entry HTML's module graph resolves purely via relative
// references from an arbitrary location outside the repository checkout
// (e.g. "/" or "/demo/chess/" on an ordinary static host), with no
// controller/test files copied in.
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const BUILD_SCRIPT = join(REPO_ROOT, 'apps', 'chess', 'build.mjs');

function packageIntoTempDir(): string {
  const outDir = mkdtempSync(join(tmpdir(), 'chess-dist-'));
  // Run genuinely outside the repo checkout: cwd is the temp dir, and the
  // script is invoked by absolute path, matching how a real build/copy step
  // would be run against a relocated destination.
  execFileSync(process.execPath, [BUILD_SCRIPT, outDir], { cwd: outDir });
  return outDir;
}

test('build.mjs packages a relocatable dist/chess folder with resolvable relative imports', async () => {
  const outDir = packageIntoTempDir();
  try {
    // Entry HTML references only a relative script src.
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    const scriptMatch = html.match(/<script type="module" src="([^"]+)"/);
    assert.ok(scriptMatch, 'index.html must reference its entry module via a relative <script> src');
    const entryScript = scriptMatch?.[1];
    assert.ok(entryScript, 'entry script src must be a non-empty string');
    assert.ok(!entryScript.startsWith('/'), 'entry script reference must be relative, not site-root-absolute');
    assert.ok(!/^https?:/.test(entryScript), 'entry script reference must not be a remote URL');

    // The module graph actually resolves and evaluates from the relocated
    // directory: import the packaged app.js (module side effects only run
    // `createApp` when `document` exists, which it does not under Node, so
    // this exercises real module resolution without requiring a DOM).
    const appModule = await import(`file://${join(outDir, entryScript)}`);
    assert.equal(typeof appModule.createApp, 'function');

    // The compiled chess modules resolve their own relative vendor import
    // from inside the packaged output.
    const sessionModule = await import(`file://${join(outDir, 'src', 'chess', 'session.js')}`);
    const session = sessionModule.createSession();
    assert.equal(session.getMode(), 'local');
    assert.equal(session.getGame().fen().split(' ')[0], 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');

    // Vendor files and license are present and byte-identical copies.
    for (const file of ['chess.js', 'chess.d.ts', 'LICENSE.txt']) {
      assert.ok(
        existsSync(join(outDir, 'apps', 'chess', 'vendor', file)),
        `packaged output must include vendor file ${file}`,
      );
    }
    const packagedLicense = readFileSync(join(outDir, 'apps', 'chess', 'vendor', 'LICENSE.txt'));
    const sourceLicense = readFileSync(join(REPO_ROOT, 'apps', 'chess', 'vendor', 'LICENSE.txt'));
    assert.ok(packagedLicense.equals(sourceLicense), 'vendored LICENSE.txt must be copied unmodified');

    // No controller source, controller test, or non-chess file is copied.
    const forbiddenPaths = [
      join(outDir, 'src', 'main.js'),
      join(outDir, 'src', 'worker.js'),
      join(outDir, 'src', 'controller.js'),
      join(outDir, 'test'),
      join(outDir, 'package.json'),
      join(outDir, 'node_modules'),
    ];
    for (const forbidden of forbiddenPaths) {
      assert.ok(!existsSync(forbidden), `packaged output must not include ${forbidden}`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('build.mjs works at a nested destination path (simulating /demo/chess/ hosting)', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'chess-nested-'));
  try {
    const nestedOut = join(outer, 'demo', 'chess');
    execFileSync(process.execPath, [BUILD_SCRIPT, nestedOut], { cwd: outer });
    const sessionModule = await import(`file://${join(nestedOut, 'src', 'chess', 'session.js')}`);
    const session = sessionModule.createSession();
    assert.equal(session.getMode(), 'local');
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('build.mjs rejects packaging when the compiled chess modules are missing', () => {
  // Verify the precondition check fires when dist/src/chess is absent, by
  // temporarily moving the real compiled output aside and restoring it
  // afterward (this repo's own dist/ output, produced by `npm run build`,
  // which every other test in this file also depends on).
  const distSrcChess = join(REPO_ROOT, 'dist', 'src', 'chess');
  const backup = `${distSrcChess}.bak-${process.pid}`;
  if (!existsSync(distSrcChess)) {
    // Nothing to move aside; the precondition trivially cannot be exercised
    // without a prior `npm run build`. Fail loudly rather than silently pass.
    throw new Error('Expected dist/src/chess to exist (run "npm run build" before tests).');
  }
  renameSync(distSrcChess, backup);
  try {
    const outDir = mkdtempSync(join(tmpdir(), 'chess-missing-build-'));
    try {
      assert.throws(() => {
        execFileSync(process.execPath, [BUILD_SCRIPT, outDir], { cwd: outDir, stdio: 'pipe' });
      }, /Compiled chess modules not found|Command failed/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    renameSync(backup, distSrcChess);
  }
});
