#!/usr/bin/env node
// Packaging script for the Portable Chess Practice app (REQ-013).
//
// Node-standard-library only: uses only `node:fs`, `node:path`, and
// `node:url`. It fetches no packages, invokes no bundler, and copies no
// controller/test files. Run after `npm run build` (which compiles
// `src/**/*.ts`, including `src/chess/**`, to `dist/src/**` via `tsc`):
//
//   npm run build
//   node apps/chess/build.mjs [outDir]
//
// `outDir` defaults to `<repoRoot>/dist/chess`. The produced folder is
// self-contained and relocatable: every reference inside it (HTML script
// tag, JS imports, vendor import) is a relative path, so the folder works
// unmodified when served from `/` or from a nested path such as
// `/demo/chess/` on an ordinary static host.
//
// Preserved directory shape (mirrors the compiled modules' own relative
// import paths, which this script does not rewrite):
//   <outDir>/index.html                       app.js's HTML host
//   <outDir>/app.js, app.css                   static app layer
//   <outDir>/board-geometry.mjs, pieces.mjs    pure DOM helper modules
//   <outDir>/src/chess/{game,computer,session}.js   compiled chess logic
//   <outDir>/apps/chess/vendor/{chess.js,chess.d.ts,LICENSE.txt}
//
// The compiled `src/chess/game.js` imports the vendor library via
// `../../apps/chess/vendor/chess.js` (relative to its own location, i.e.
// from a compiler `rootDir` of the repository root). This script therefore
// nests the vendor copy under `<outDir>/apps/chess/vendor/` - two directory
// levels up from `<outDir>/src/chess/` - so that same unmodified relative
// import resolves correctly in the packaged output without any rewriting.
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

const distSrcChess = join(repoRoot, 'dist', 'src', 'chess');
const appsChessDir = __dirname; // repoRoot/apps/chess
const vendorDir = join(appsChessDir, 'vendor');

const STATIC_APP_FILES = ['index.html', 'app.js', 'app.css', 'board-geometry.mjs', 'pieces.mjs'];
const COMPILED_CHESS_FILES = ['game.js', 'computer.js', 'session.js'];
const VENDOR_FILES = ['chess.js', 'chess.d.ts', 'LICENSE.txt'];

function copyFile(src, destDir, name) {
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, join(destDir, name));
}

/** Recursively lists every file under `dir` as paths relative to `dir`. */
function listFilesRecursive(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else {
      out.push(full.slice(base.length + 1));
    }
  }
  return out;
}

export function buildChessApp(outDir) {
  if (!existsSync(distSrcChess)) {
    throw new Error(
      `Compiled chess modules not found at ${distSrcChess}. Run "npm run build" (tsc) before packaging.`,
    );
  }
  for (const file of COMPILED_CHESS_FILES) {
    const src = join(distSrcChess, file);
    if (!existsSync(src)) {
      throw new Error(`Missing compiled chess module: ${src}. Run "npm run build" first.`);
    }
  }
  for (const file of VENDOR_FILES) {
    const src = join(vendorDir, file);
    if (!existsSync(src)) throw new Error(`Missing vendor file: ${src}`);
  }
  for (const file of STATIC_APP_FILES) {
    const src = join(appsChessDir, file);
    if (!existsSync(src)) throw new Error(`Missing static app file: ${src}`);
  }

  mkdirSync(outDir, { recursive: true });

  for (const file of STATIC_APP_FILES) {
    copyFile(join(appsChessDir, file), outDir, file);
  }
  for (const file of COMPILED_CHESS_FILES) {
    copyFile(join(distSrcChess, file), join(outDir, 'src', 'chess'), file);
  }
  for (const file of VENDOR_FILES) {
    copyFile(join(vendorDir, file), join(outDir, 'apps', 'chess', 'vendor'), file);
  }

  return listFilesRecursive(outDir);
}

// Only run when invoked directly (`node apps/chess/build.mjs`), not when
// imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, 'dist', 'chess');
  const files = buildChessApp(outDir);
  console.log(`Packaged ${files.length} files into ${outDir}`);
  for (const file of files.sort()) console.log(`  ${file}`);
}
