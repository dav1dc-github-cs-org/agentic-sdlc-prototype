import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import type { Change, IntegrationResolution, Policy } from './contracts.ts';
import type { Stage } from './lifecycle.ts';

export function isTestPath(path: string, policy: Policy): boolean {
  return policy.testPaths.some(pattern => posix.matchesGlob(path, pattern));
}

export function isDocsPath(path: string, policy: Policy): boolean {
  return policy.docsPaths.some(pattern => posix.matchesGlob(path, pattern));
}

export function isProtectedPath(path: string, policy: Policy): boolean {
  const normalized = path.toLowerCase();
  return normalized.startsWith('.github/') || normalized.startsWith('.sdlc') ||
    /(^|\/)agents\.md$/.test(normalized) ||
    policy.protectedPaths.some(pattern => posix.matchesGlob(normalized, pattern.toLowerCase()));
}

export interface Capabilities {
  stage: Stage;
  canProposeChanges: boolean;
  protectedPaths: string[];
  immutableTests: string[];
  testPaths: string[];
  docsPaths: string[];
  maxFiles: number;
  maxChangeBytes: number;
}

export function describeCapabilities(stage: Stage, policy: Policy, baselineTests: readonly string[]): Capabilities {
  return {
    stage, canProposeChanges: ['code', 'test', 'document'].includes(stage),
    protectedPaths: [...new Set(['.github/**', '.sdlc*', '**/AGENTS.md', ...policy.protectedPaths])],
    immutableTests: [...new Set(baselineTests)].sort(), testPaths: policy.testPaths, docsPaths: policy.docsPaths,
    maxFiles: policy.maxFiles, maxChangeBytes: policy.maxChangeBytes,
  };
}

export function assessChanges(changes: Change[], stage: Stage, policy: Policy, baselineTests: readonly string[]) {
  try {
    validateChanges(changes, stage, policy, baselineTests);
    return { allowed: true as const, reason: 'permitted' as const };
  } catch (error) {
    return { allowed: false as const, reason: error instanceof Error ? error.message : 'Changes are not permitted' };
  }
}

export interface SnapshotEntry { sha?: string; mode?: string; type?: string }

export function mergeSnapshots(base: Map<string, SnapshotEntry>, source: Map<string, SnapshotEntry>, target: Map<string, SnapshotEntry>,
  resolutions: IntegrationResolution[] = []) {
  const result: { path: string; sha: string; mode: string; type: string }[] = [];
  const used = new Set<string>();
  const same = (first?: SnapshotEntry, second?: SnapshotEntry) => first?.sha === second?.sha &&
    first?.mode === second?.mode && first?.type === second?.type;
  const paths = [...new Set([...base.keys(), ...source.keys(), ...target.keys()])].sort();
  for (const path of paths) {
    const leaf = (snapshot: Map<string, SnapshotEntry>) => snapshot.get(path)?.type === 'tree' ? undefined : snapshot.get(path);
    const before = leaf(base), feature = leaf(source), baseline = leaf(target);
    let selected: SnapshotEntry | undefined;
    if (same(feature, before)) selected = baseline;
    else if (same(baseline, before) || same(feature, baseline)) selected = feature;
    else {
      const resolution = resolutions.find(item => item.path === path);
      if (!resolution) throw new Error(`Integration conflict at ${path}`);
      if (resolution.baseSha !== (before?.sha ?? null) || resolution.sourceSha !== (feature?.sha ?? null) ||
          resolution.targetSha !== (baseline?.sha ?? null) || [before, feature, baseline].some(entry => entry &&
            (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode ?? '')))) {
        throw new Error(`Stale or unsupported integration resolution at ${path}`);
      }
      used.add(path);
      if (resolution.content !== null) selected = { mode: feature?.mode ?? baseline?.mode ?? '100644', type: 'blob',
        sha: createHash('sha1').update(`blob ${Buffer.byteLength(resolution.content)}\0${resolution.content}`).digest('hex') };
    }
    if (selected) {
      if (!selected.sha || !selected.mode || !selected.type) throw new Error('Incomplete integration tree entry');
      result.push({ path, sha: selected.sha, mode: selected.mode, type: selected.type });
    }
  }
  if (used.size !== resolutions.length) throw new Error('Integration resolutions must target distinct current conflicts');
  if (result.some(entry => result.some(other => other !== entry && entry.path.startsWith(`${other.path}/`)))) {
    throw new Error('Integration conflict between a file and directory');
  }
  return result;
}

export function validateChanges(changes: Change[], stage: Stage, policy: Policy, baselineTests: readonly string[] = []): void {
  if (!['code', 'test', 'document'].includes(stage) && changes.length) throw new Error('Read-only stage proposed changes');
  if (changes.length > policy.maxFiles) throw new Error('Changed-file budget exceeded');
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  let bytes = 0;
  for (const change of changes) {
    const path = change.path;
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith('/') ||
        path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new Error(`Unsafe file path: ${path}`);
    }
    const normalized = path.toLowerCase();
    if (seen.has(normalized)) throw new Error('Duplicate or case-colliding file paths');
    if ([...seen].some(previous => normalized.startsWith(`${previous}/`) || previous.startsWith(`${normalized}/`))) {
      throw new Error('Conflicting file and directory changes');
    }
    seen.add(normalized);
    const segments = path.split('/');
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const prefix = segments.slice(0, depth).join('/');
      const folded = prefix.toLowerCase();
      const previous = prefixes.get(folded);
      if (previous && previous !== prefix) throw new Error('Case-colliding directory paths');
      prefixes.set(folded, prefix);
    }
    if (isProtectedPath(path, policy)) throw new Error(`Protected file: ${path}`);
    if (isTestPath(path, policy) && baselineTests.includes(path)) throw new Error('Existing baseline tests are immutable');
    if (stage === 'test' && !isTestPath(path, policy)) throw new Error('Testing agent may only change tests');
    if (stage === 'document' && !isDocsPath(path, policy)) {
      throw new Error('Documentation agent may only change documentation');
    }
    if (change.content?.includes('\0')) throw new Error('Binary files are not supported');
    bytes += Buffer.byteLength(change.content ?? '', 'utf8');
    if (bytes > policy.maxChangeBytes) throw new Error('Change-size budget exceeded');
  }
}