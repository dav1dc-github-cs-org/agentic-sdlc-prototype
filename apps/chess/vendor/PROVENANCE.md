# Vendored dependency provenance: chess.js

This directory contains unmodified files extracted from the official
`chess.js` npm package archive. They are vendored as raw source (not
installed via `npm`/`package.json`/lockfile) per the approved plan for
issue #28, task `vendor-chessjs` (issue #29).

- **Package**: `chess.js`
- **Version**: `1.4.0`
- **Source URL**: `https://registry.npmjs.org/chess.js/-/chess.js-1.4.0.tgz`
- **Retrieval date**: 2026-09-17
- **License**: BSD-2-Clause (see `LICENSE.txt`, copied unmodified from the
  archive's top-level `LICENSE` file)

## Vendored files

| Vendored path | Archive path             | Bytes   | SHA-256                                                           |
| -------------- | ------------------------- | ------- | ------------------------------------------------------------------ |
| `chess.js`     | `package/dist/esm/chess.js`  | 107,052 | `76c7c34f0e2e9ab076521a5d6fe786a9cce537bb1b6f29d32a9c9970b5b232d2` |
| `chess.d.ts`   | `package/dist/types/chess.d.ts` | 9,163   | `29f09463bf7aedb31c93b4f692b9001eb5529b9dcc52829a1c0d5895e2f2e8f8` |
| `LICENSE.txt`  | `package/LICENSE`          | 1,315   | `0b3a3c2b4432a26bb18f9d06f5bba4de015bcc980306b7db28b06025495e2186` |

All byte counts and hashes were independently verified against the pinned
values in the approved plan by downloading the archive above and computing
`sha256sum` over the extracted files. `dist/esm/chess.js` is a self-contained
ESM build with no runtime `import`/`require` statements, so it can be
imported directly by `tsc`/Node without a bundler or additional dependency.

## Re-vendoring

If `chess.js` is ever upgraded, replace all three files together, update the
byte counts/hashes above, and update the pinned constants asserted by
`test/chess/vendor.test.ts` in the same change.
