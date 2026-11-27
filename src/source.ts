import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { z } from 'zod';
import { isTestPath } from './changes.ts';
import { shaSchema, targetRefSchema, type Policy } from './contracts.ts';
import type { Lifecycle, TargetRef } from './lifecycle.ts';
import { loadRegistry, sameRepository } from './targets.ts';

// A foreign target's code reaches candidate jobs only as a digest-pinned bundle, never through a token-bearing checkout.
export const sourceDirectory = '.sdlc-source';
export const manifestFile = 'manifest.json';
export const bundleFile = 'source.bundle';
export const maxBundleBytes = 256 * 1024 * 1024;
const maxManifestBytes = 8 * 1024 * 1024;
const commitNames = ['source', 'base', 'scan'] as const;

const commitsSchema = z.object({ source: shaSchema, base: shaSchema, scan: shaSchema }).strict();
export type Commits = z.infer<typeof commitsSchema>;

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  target: targetRefSchema,
  issue: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  job: z.string().regex(/^\d+-\d+$/),
  controlSha: shaSchema,
  commits: commitsSchema,
  bundle: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(maxBundleBytes) }).strict().nullable(),
  baselineTests: z.array(z.string().min(1).max(4096)).max(100_000),
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;

export function sourceCommits(state: Lifecycle): Commits {
  const job = state.job;
  if (!job) throw new Error('No registered job');
  return commitsSchema.parse({ source: job.inputSha, base: state.baseSha, scan: job.probeSha ?? job.inputSha });
}

type Protocol = 'https' | 'file';

// Repository configuration, hooks, and credential helpers never apply; the token travels only as a per-URL header.
function gitEnv(protocol: Protocol, header?: { url: string; token: string }): NodeJS.ProcessEnv {
  const settings: [string, string][] = [
    ['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['transfer.fsckObjects', 'true'],
    ['protocol.allow', 'never'], [`protocol.${protocol}.allow`, 'always'], ['submodule.recurse', 'false'],
    ['init.defaultBranch', 'main'], ['advice.detachedHead', 'false'], ['credential.helper', ''],
  ];
  if (header) {
    const basic = Buffer.from(`x-access-token:${header.token}`).toString('base64');
    settings.push([`http.${header.url}.extraheader`, `AUTHORIZATION: basic ${basic}`]);
  }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_COUNT: String(settings.length) };
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

function git(args: string[], env: NodeJS.ProcessEnv, timeout = 600_000): string {
  return execFileSync('git', args, { encoding: 'utf8', env, timeout, maxBuffer: 1_000_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fileDigest(path: string, expectedBytes?: number): { sha256: string; bytes: number } {
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(handle);
    if (!info.isFile() || info.size > maxBundleBytes || expectedBytes !== undefined && info.size !== expectedBytes) {
      throw new Error('Source bundle size does not match its manifest');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (let read; (read = readSync(handle, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    return { sha256: hash.digest('hex'), bytes };
  } finally { closeSync(handle); }
}

export function createBundle(options: {
  remote: string; token?: string; commits: Commits; output: string; maxBytes?: number; protocol?: Protocol;
}): { sha256: string; bytes: number } {
  const maxBytes = options.maxBytes ?? maxBundleBytes;
  const protocol = options.protocol ?? 'https';
  if (protocol === 'https' && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(options.remote)) {
    throw new Error('Source bundles are fetched only from a GitHub repository URL');
  }
  const env = gitEnv(protocol, options.token ? { url: options.remote, token: options.token } : undefined);
  // A failed attempt must never leave an earlier bundle where the artifact upload would find it.
  rmSync(options.output, { force: true });
  const temp = mkdtempSync(join(tmpdir(), 'sdlc-source-'));
  try {
    git(['init', '--quiet', '--bare', temp], env);
    const repository = ['--git-dir', temp];
    git([...repository, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', options.remote,
      ...commitNames.map(name => `${options.commits[name]}:refs/sdlc/${name}`)], env);
    for (const name of commitNames) {
      if (git([...repository, 'rev-parse', '--verify', `refs/sdlc/${name}^{commit}`], env) !== options.commits[name]) {
        throw new Error(`Fetched ${name} commit does not match the registered job`);
      }
    }
    // Reject oversized history before writing the bundle; a shallow fallback would silently change what agents and tests see.
    const counts = Object.fromEntries(git([...repository, 'count-objects', '-v'], env).split('\n').map(line => line.split(': ')));
    if ((Number(counts['size-pack'] ?? 0) + Number(counts.size ?? 0)) * 1024 > maxBytes) throw new Error('Target repository exceeds the source bundle limit');
    git([...repository, 'bundle', 'create', '--quiet', options.output, ...commitNames.map(name => `refs/sdlc/${name}`)], env);
    git([...repository, 'bundle', 'verify', '--quiet', options.output], env);
    const result = fileDigest(options.output);
    if (result.bytes > maxBytes) {
      rmSync(options.output, { force: true });
      throw new Error('Target repository exceeds the source bundle limit');
    }
    return result;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function readManifest(directory: string): Manifest {
  const handle = openSync(join(directory, manifestFile), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(handle);
    if (!info.isFile() || info.size > maxManifestBytes) throw new Error('Invalid source manifest');
    return manifestSchema.parse(JSON.parse(readFileSync(handle, 'utf8')));
  } finally { closeSync(handle); }
}

export function verifyManifest(manifest: Manifest, expected: {
  target: TargetRef; issue: number; job: string; controlSha: string; commits: Commits;
}, policy: Policy): string[] {
  if (manifest.target.id !== expected.target.id || !sameRepository(manifest.target.repository, expected.target.repository) ||
      manifest.issue !== expected.issue || manifest.job !== expected.job || manifest.controlSha !== expected.controlSha ||
      commitNames.some(name => manifest.commits[name] !== expected.commits[name])) {
    throw new Error('Source manifest is not bound to this registered job');
  }
  const tests = manifest.baselineTests;
  if (tests.some((path, index) => !isTestPath(path, policy) || index > 0 && tests[index - 1]! >= path)) {
    throw new Error('Source manifest baseline tests are invalid');
  }
  return tests;
}

export function materialize(options: { directory: string; destination: string; sha: string; workspace: string }): void {
  const sha = shaSchema.parse(options.sha);
  const manifest = readManifest(options.directory);
  if (!commitNames.some(name => manifest.commits[name] === sha)) throw new Error('Commit is not part of the registered source bundle');
  if (!manifest.bundle) throw new Error('This stage carries no source bundle');
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(options.destination)) throw new Error('Unsafe materialization destination');
  const bundle = realpathSync(join(options.directory, bundleFile));
  const actual = fileDigest(bundle, manifest.bundle.bytes);
  if (actual.sha256 !== manifest.bundle.sha256) throw new Error('Source bundle digest does not match its manifest');
  const workspace = realpathSync(options.workspace);
  const destination = join(workspace, options.destination);
  if (!destination.startsWith(workspace + sep)) throw new Error('Unsafe materialization destination');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination);
  const env = gitEnv('file');
  git(['init', '--quiet', destination], env);
  const repository = ['-C', destination];
  git([...repository, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--', bundle, 'refs/sdlc/*:refs/sdlc/*'], env);
  git([...repository, 'checkout', '--quiet', '--detach', sha], env);
  if (git([...repository, 'rev-parse', 'HEAD'], env) !== sha) throw new Error('Materialized commit does not match');
  // gh-aw's credential setup requires an origin and re-points it; the agent workflow restores this URL before the agent runs.
  git([...repository, 'remote', 'add', 'origin', bundle], env);
}

export function workerTarget(env: NodeJS.ProcessEnv, registry: string): TargetRef | undefined {
  const id = env.SDLC_TARGET_ID ?? '';
  const owner = env.SDLC_TARGET_OWNER ?? '';
  const name = env.SDLC_TARGET_NAME ?? '';
  if (!id && !owner && !name) return undefined;
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new Error('Invalid target ID');
  const requested = targetRefSchema.parse({ id: Number(id), repository: `${owner}/${name}` });
  const control = targetRefSchema.parse({ id: Number(env.GITHUB_REPOSITORY_ID), repository: env.GITHUB_REPOSITORY });
  const entry = loadRegistry(control, registry).targets.find(item => item.id === requested.id);
  if (!entry?.enabled || !sameRepository(entry.repository, requested.repository)) {
    throw new Error('The dispatched target is not an enabled registered target');
  }
  return { id: entry.id, repository: entry.repository };
}
