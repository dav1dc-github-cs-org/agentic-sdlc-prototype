import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { validateChanges } from './changes.ts';
import type { Change, PlanPolicy, Policy } from './contracts.ts';
import type { Job, Lifecycle } from './lifecycle.ts';

export function validatePlanPolicy(plan: PlanPolicy | undefined, policy: Policy): void {
  if (!plan) return;
  validateChanges(plan.integrationResolutions?.map(item => ({ path: item.path, content: item.content })) ?? [], 'code', policy);
  const identifiers = new Set<string>();
  const ownedPaths = new Set<string>();
  const patchable = new Set<string>();
  for (const dependency of plan.dependencies) {
    if (identifiers.has(dependency.id)) throw new Error('Duplicate dependency identifier');
    identifiers.add(dependency.id);
    const expected = dependency.variants[0]!.files.map(file => `${file.path}:${file.role}`).sort().join('\n');
    for (const variant of dependency.variants) {
      if (variant.files.map(file => `${file.path}:${file.role}`).sort().join('\n') !== expected) {
        throw new Error('Dependency alternatives must preserve installed paths and license roles');
      }
      if (!variant.files.some(file => file.role === 'license')) throw new Error('Pinned dependencies require a license file');
      validateChanges(variant.files.map(file => ({ path: file.path, content: '' })), 'code', policy);
      for (const file of variant.files) {
        if (!/^package\/[a-zA-Z0-9_./-]+$/.test(file.archivePath) ||
            file.archivePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe archive member');
        if (file.role !== 'license') patchable.add(file.path);
      }
    }
    for (const file of dependency.variants[0]!.files) {
      if (ownedPaths.has(file.path)) throw new Error('Dependency paths overlap');
      ownedPaths.add(file.path);
    }
  }
  if (plan.vendorSecurityPatches.some(path => !patchable.has(path))) throw new Error('Vendor patch permission must name a pinned non-license file');
}

export function dependencyPlan(state: Lifecycle): PlanPolicy | undefined {
  if (state.job?.purpose === 'baseline_preflight') return undefined;
  return state.job?.purpose === 'dependency_preflight' && state.amendment?.plan ? state.amendment.plan.policy : state.plan?.policy;
}

export function selectedDependencies(state: Lifecycle) {
  if (state.job?.purpose === 'baseline_preflight') return [];
  const dependencies = dependencyPlan(state)?.dependencies ?? [];
  if (Object.keys(state.dependencyChoices ?? {}).some(id => !dependencies.some(dependency => dependency.id === id))) {
    throw new Error('Unapproved dependency selection');
  }
  return dependencies.map(dependency => {
    const variant = dependency.variants[state.dependencyChoices?.[dependency.id] ?? 0];
    if (!variant) throw new Error('Unapproved dependency alternative');
    return { dependency, variant };
  });
}

export function fileDigest(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

type PackageRunner = (command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; input?: Uint8Array;
}) => Buffer;

export function fetchPackageFiles(name: string, version: string, paths: string[], run: PackageRunner = execFileSync): Map<string, Uint8Array> {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-dependency-'));
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  try {
    const options = { cwd: directory, env, timeout: 120_000, maxBuffer: 1_000_000 };
    const packed = JSON.parse(run('npm', ['pack', `${name}@${version}`, '--ignore-scripts',
      '--registry=https://registry.npmjs.org', `--userconfig=${join(directory, 'user.npmrc')}`,
      `--globalconfig=${join(directory, 'global.npmrc')}`,
      '--json', '--pack-destination', directory], options).toString('utf8'));
    const filename: unknown = packed[0]?.filename;
    if (typeof filename !== 'string' || basename(filename) !== filename || !filename.endsWith('.tgz')) throw new Error('Invalid package archive name');
    const handle = openSync(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    let archive: Buffer;
    try {
      const info = fstatSync(handle);
      if (!info.isFile() || info.size > 20_000_000) throw new Error('Package archive exceeds the preflight budget');
      archive = readFileSync(handle);
    } finally { closeSync(handle); }
    return new Map(paths.map(path => [path, run('tar', ['-xOf', '-', '--', path], {
      ...options, input: archive, timeout: 30_000, maxBuffer: 512_000,
    })]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function dependencyChanges(state: Lifecycle, policy: Policy,
  fetcher: typeof fetchPackageFiles = fetchPackageFiles): Change[] {
  validatePlanPolicy(dependencyPlan(state), policy);
  const changes = selectedDependencies(state).flatMap(({ dependency, variant }) => {
    const files = fetcher(dependency.package, variant.version, variant.files.map(file => file.archivePath));
    return variant.files.map(file => {
      const bytes = files.get(file.archivePath);
      if (!bytes || fileDigest(bytes) !== file.sha256) throw new Error(`Dependency integrity mismatch: ${file.path}`);
      return { path: file.path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    });
  });
  validateChanges(changes, 'code', policy);
  return changes;
}

export interface DependencyPatch {
  dependencyId: string; path: string; upstreamSha256: string; patchedSha256: string;
  planHash: string; jobId: string; inputSha: string; outputSha: string;
}

export function validateDependencyChanges(state: Lifecycle, job: Job, changes: Change[]): Omit<DependencyPatch, 'outputSha'>[] {
  const patches: Omit<DependencyPatch, 'outputSha'>[] = [];
  if (job.purpose === 'dependency_repair') {
    const paths = new Set(selectedDependencies(state).flatMap(({ variant }) => variant.files.map(file => file.path)));
    if (changes.some(change => !paths.has(change.path))) throw new Error('Dependency repair may only change approved dependency files');
  }
  for (const { dependency, variant } of selectedDependencies(state)) for (const file of variant.files) {
    const change = changes.find(item => item.path === file.path);
    if (!change) continue;
    if (change.content === null) throw new Error(`Pinned dependency cannot be deleted: ${file.path}`);
    const sha256 = fileDigest(change.content);
    if (sha256 === file.sha256) continue;
    const finding = state.recoveries?.some(recovery => recovery.job.stage === 'scan' && recovery.job.planHash === job.planHash &&
      recovery.blocker.diagnostics.some(diagnostic => diagnostic.tool === 'codeql' && diagnostic.path === file.path));
    if (file.role === 'license' || !state.plan?.policy?.vendorSecurityPatches.includes(file.path) || !finding) {
      throw new Error(`Pinned dependency changes require approved security-patch authority: ${file.path}`);
    }
    patches.push({ dependencyId: dependency.id, path: file.path, upstreamSha256: file.sha256, patchedSha256: sha256,
      planHash: state.plan.hash, jobId: job.id, inputSha: job.inputSha });
  }
  return patches;
}

export function verifyDependencyFiles(state: Lifecycle, source: string): void {
  for (const { variant } of selectedDependencies(state)) for (const file of variant.files) {
    const handle = openSync(join(source, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(handle);
      if (!info.isFile() || info.size > 512_000) throw new Error('Invalid installed dependency file');
      const actual = fileDigest(readFileSync(handle));
      const patch = state.dependencyPatches?.find(item => item.path === file.path && item.planHash === state.plan?.hash &&
        item.upstreamSha256 === file.sha256 && item.patchedSha256 === actual);
      if (actual !== file.sha256 && !patch) throw new Error(`Installed dependency integrity mismatch: ${file.path}`);
    } finally { closeSync(handle); }
  }
}

export function advanceDependency(state: Lifecycle, paths: string[]): boolean {
  const matching = selectedDependencies(state).find(({ variant }) => paths.length > 0 &&
    paths.every(path => variant.files.some(file => file.path === path)));
  if (!matching) return false;
  const next = (state.dependencyChoices?.[matching.dependency.id] ?? 0) + 1;
  if (!matching.dependency.variants[next]) return false;
  state.dependencyChoices ??= {};
  state.dependencyChoices[matching.dependency.id] = next;
  return true;
}