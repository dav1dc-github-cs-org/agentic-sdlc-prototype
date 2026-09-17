import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

// Pinned provenance for the vendored chess.js@1.4.0 archive files. These
// constants must match apps/chess/vendor/PROVENANCE.md and the approved plan
// exactly. Any accidental edit or re-vendoring without updating all of byte
// counts/hashes/provenance/this test is caught here.
const VENDOR_DIR = resolve(import.meta.dirname, '../../apps/chess/vendor');

const PINNED_FILES = [
  {
    name: 'chess.js',
    bytes: 107052,
    sha256: '76c7c34f0e2e9ab076521a5d6fe786a9cce537bb1b6f29d32a9c9970b5b232d2',
  },
  {
    name: 'chess.d.ts',
    bytes: 9163,
    sha256: '29f09463bf7aedb31c93b4f692b9001eb5529b9dcc52829a1c0d5895e2f2e8f8',
  },
  {
    name: 'LICENSE.txt',
    bytes: 1315,
    sha256: '0b3a3c2b4432a26bb18f9d06f5bba4de015bcc980306b7db28b06025495e2186',
  },
] as const;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

for (const file of PINNED_FILES) {
  test(`vendored ${file.name} matches pinned byte count and SHA-256 hash`, () => {
    const path = resolve(VENDOR_DIR, file.name);
    const contents = readFileSync(path);
    assert.equal(contents.length, file.bytes, `${file.name} byte length changed; re-vendoring must update the pinned constant`);
    assert.equal(sha256(contents), file.sha256, `${file.name} content changed; it must remain byte-identical to the pinned archive`);
  });
}

test('vendored chess.js ESM build has no runtime import/require statements', () => {
  const contents = readFileSync(resolve(VENDOR_DIR, 'chess.js'), 'utf8');
  assert.doesNotMatch(contents, /^\s*import\s/m, 'vendored chess.js must remain a dependency-free standalone build');
  assert.doesNotMatch(contents, /require\(/, 'vendored chess.js must remain a dependency-free standalone build');
});
