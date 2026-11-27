import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { repositorySchema, shaSchema, targetRefSchema } from './contracts.ts';
import type { TargetRef } from './lifecycle.ts';

export const registryPath = '.github/sdlc/targets.json';
export const intakeWorkflow = '.github/workflows/sdlc-intake.yml';
export const receiptWorkflow = '.github/workflows/sdlc-intake-receipt.yml';
export const intakeTemplate = '.github/sdlc/templates/sdlc-intake.yml';

export const targetSchema = targetRefSchema.extend({
  enabled: z.boolean(),
  // Receipts from runs created before activation are never accepted, so re-enabling cannot replay old labels.
  activatedAt: z.iso.datetime(),
  intake: z.object({ workflow: z.literal(intakeWorkflow), receiptRef: shaSchema }).strict(),
}).strict();

export const registrySchema = z.object({
  schemaVersion: z.literal(1),
  targets: z.array(targetSchema).max(100),
}).strict().superRefine((registry, context) => {
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const target of registry.targets) {
    const name = target.repository.toLowerCase();
    if (ids.has(target.id) || names.has(name)) {
      context.addIssue({ code: 'custom', message: `Duplicate target ${target.repository}` });
    }
    ids.add(target.id);
    names.add(name);
  }
});

export type Target = z.infer<typeof targetSchema>;
export type Registry = z.infer<typeof registrySchema>;

export function sameRepository(first: string, second: string): boolean {
  return first.toLowerCase() === second.toLowerCase();
}

export function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repositorySchema.parse(repository).split('/') as [string, string];
  return { owner, repo };
}

const exposure = { private: 0, internal: 1, public: 2 } as const;

// Target issue text, plans, logs, and code bundles land in control-plane state and runs, so the control plane may never be more visible.
export function assertExposure(control: { visibility?: string }, target: { visibility?: string }): void {
  const rank = (repository: { visibility?: string }) => {
    const level = exposure[repository.visibility as keyof typeof exposure];
    if (level === undefined) throw new Error('Repository visibility is unavailable; refusing to mirror target content');
    return level;
  };
  if (rank(control) > rank(target)) {
    throw new Error(`A ${control.visibility} control repository cannot process a ${target.visibility} target`);
  }
}

export function parseRegistry(input: unknown, control?: TargetRef): Registry {
  const registry = registrySchema.parse(input);
  // The control repository is always the implicit self target; registering it would give one issue two state paths.
  if (control && registry.targets.some(target => target.id === control.id || sameRepository(target.repository, control.repository))) {
    throw new Error('The control repository cannot be registered as a foreign target');
  }
  return registry;
}

export function loadRegistry(control?: TargetRef, path = registryPath): Registry {
  let content: string;
  try { content = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { schemaVersion: 1, targets: [] };
    throw error;
  }
  return parseRegistry(JSON.parse(content), control);
}

// Only the binding that governs an active lifecycle matters; onboarding another target must not stall this one.
export function targetBindingChanged(before: unknown, after: unknown, target: TargetRef): boolean {
  const binding = (input: unknown) => {
    const parsed = registrySchema.safeParse(input);
    if (!parsed.success) return undefined;
    const entry = parsed.data.targets.find(item => item.id === target.id);
    return entry ? JSON.stringify({ id: entry.id, repository: entry.repository, enabled: entry.enabled }) : null;
  };
  const previous = binding(before);
  const next = binding(after);
  return previous === undefined || next === undefined || previous !== next;
}

export function runTitle(jobId: string, target?: TargetRef): string {
  return target ? `SDLC ${target.id}/${jobId}` : `SDLC ${jobId}`;
}

export function parseRunTitle(title: string): { targetId?: number; issue: number } | undefined {
  const match = /^SDLC (?:([1-9]\d{0,15})\/)?([1-9]\d{0,15})-\d+$/.exec(title);
  if (!match) return undefined;
  const issue = Number(match[2]);
  const targetId = match[1] === undefined ? undefined : Number(match[1]);
  if (!Number.isSafeInteger(issue) || targetId !== undefined && !Number.isSafeInteger(targetId)) return undefined;
  return targetId === undefined ? { issue } : { targetId, issue };
}
