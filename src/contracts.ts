import { z } from 'zod';
import type { Lifecycle } from './lifecycle.ts';

export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const numberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const modelSelectorSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/)
  .refine(model => model.trim() === model);
const modelSchema = modelSelectorSchema.refine(model => !['auto', 'unknown'].includes(model.toLowerCase()));
// Validation must never rewrite stored text: persisted plan hashes are computed over the exact body.
const text = z.string().min(1).regex(/\S/);
export const stageSchema = z.enum(['research', 'decompose', 'code', 'scan', 'security', 'test', 'validate', 'document', 'review']);
export const phaseSchema = z.enum([
  'researching', 'awaiting_approval', 'decomposing', 'coding', 'scanning', 'security',
  'testing', 'validating', 'documenting', 'reviewing', 'publishing', 'pr_open', 'merged', 'blocked', 'paused', 'cancelled',
]);

export const taskSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  title: text.max(160), description: text.max(6000),
  acceptance: z.array(text.max(1000)).min(1).max(12),
  dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(12),
}).strict();

export const changeSchema = z.object({
  path: text.max(240), content: z.string().max(512_000).nullable(),
}).strict();
export type Change = z.infer<typeof changeSchema>;

const tokenCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const modelUsageSchema = z.object({
  model: modelSchema, requests: numberSchema.max(1_000_000),
  inputTokens: tokenCountSchema, outputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema, cacheWriteTokens: tokenCountSchema,
}).strict();
const tokenUsageSchema = z.object({
  status: z.enum(['available', 'partial', 'unavailable']),
  models: z.array(modelUsageSchema).max(20),
}).strict().refine(usage => new Set(usage.models.map(item => item.model)).size === usage.models.length,
  'Duplicate model token usage').refine(usage => usage.status === 'unavailable' ? usage.models.length === 0 : usage.models.length > 0,
  'Token availability does not match observations').refine(usage => usage.status !== 'available' || usage.models.every(model =>
    [model.inputTokens, model.outputTokens, model.cacheReadTokens, model.cacheWriteTokens].every(value => value !== null)),
  'Available token usage contains unknown counts');

// Written by a workflow post-step, not by the agent, so the agent cannot forge its own cost.
export const costSchema = z.object({
  credits: z.number().min(0).max(100_000).finite().nullable(),
  preempted: z.boolean().nullable(),
  creditLimit: numberSchema.max(10_000).optional(),
  models: z.array(modelSchema).max(20).optional(),
  requestedModel: modelSelectorSchema.optional(),
  tokenUsage: tokenUsageSchema.optional(),
}).strict();
export type Cost = z.infer<typeof costSchema>;

export const reportSchema = z.object({
  jobId: z.string().regex(/^\d+-\d+$/),
  inputSha: shaSchema,
  outcome: z.enum(['pass', 'changes_requested', 'blocked']),
  summary: text.max(12000),
  plan: text.max(24000).optional(),
  tasks: z.array(taskSchema).max(12).optional(),
  changes: z.array(changeSchema).max(60).default([]),
}).strict();
export type Report = z.infer<typeof reportSchema>;

export const policySchema = z.object({
  label: z.literal('agentic-SDLC'),
  stateBranch: z.literal('sdlc-state'),
  maxTasks: numberSchema.max(12), maxRepairs: z.number().int().min(0).max(5),
  maxJobAttempts: numberSchema.max(3), maxJobs: numberSchema.max(100),
  jobTimeoutMinutes: numberSchema.max(180), dispatchGraceMinutes: numberSchema.max(30),
  maxFiles: numberSchema.max(60), maxChangeBytes: numberSchema.max(1_000_000),
  maxJobCredits: numberSchema.max(10_000),
  protectedPaths: z.array(text).min(1), testPaths: z.array(text).min(1),
  sourcePaths: z.array(text).min(1), docsPaths: z.array(text).min(1),
  coverage: z.object({
    lines: z.number().min(1).max(100), branches: z.number().min(1).max(100),
    maxDrop: z.number().min(0).max(5),
  }).strict(),
}).strict();
export type Policy = z.infer<typeof policySchema>;

export function resolvePolicy(input: unknown, creditLimit?: string): Policy {
  const policy = policySchema.parse(input);
  if (creditLimit === undefined || creditLimit === '') return policy;
  const maxJobCredits = policySchema.shape.maxJobCredits.safeParse(Number(creditLimit));
  if (!maxJobCredits.success || String(maxJobCredits.data) !== creditLimit) {
    throw new Error('SDLC_AIC_CREDIT_LIMIT must be a whole number between 1 and 10000');
  }
  return { ...policy, maxJobCredits: maxJobCredits.data };
}

const intakeEventSchema = z.object({
  action: z.literal('labeled'),
  label: z.object({ name: z.string() }).passthrough(),
  sender: z.object({ login: text.max(100), type: z.literal('User') }).passthrough(),
  issue: z.object({
    number: numberSchema, title: text.max(256), body: z.string().max(65536).nullable(),
    user: z.object({ login: text.max(100) }).passthrough(),
  }).passthrough(),
}).passthrough();

export interface Intake {
  issueNumber: number;
  actor: string;
  requester: string;
  title: string;
  body: string;
}

export function parseIntakeEvent(input: unknown, label: string): Intake | undefined {
  const parsed = intakeEventSchema.safeParse(input);
  if (!parsed.success || parsed.data.label.name !== label) return undefined;
  return {
    issueNumber: parsed.data.issue.number,
    actor: parsed.data.sender.login,
    requester: parsed.data.issue.user.login,
    title: parsed.data.issue.title,
    body: parsed.data.issue.body ?? '',
  };
}

const jobSchema = z.object({
  id: z.string().regex(/^\d+-\d+$/), stage: stageSchema,
  inputSha: shaSchema, controlSha: shaSchema, planHash: hashSchema.nullable(),
  taskId: z.string().nullable(), feedback: z.string().max(24000),
  attempt: numberSchema.max(3), createdAt: z.iso.datetime(),
  dispatchedAt: z.iso.datetime().optional(), runId: numberSchema.optional(),
  costedRun: numberSchema.optional(),
}).strict();

const jobIdentitySchema = jobSchema.pick({ id: true, stage: true, inputSha: true, controlSha: true,
  planHash: true, createdAt: true, runId: true }).extend({
  taskId: jobSchema.shape.taskId.optional(), attempt: jobSchema.shape.attempt.optional(),
});
const observedCostSchema = costSchema.extend({ runnerMs: z.number().min(0).finite() });
const acceptedUsageResultSchema = z.object({ outcome: reportSchema.shape.outcome, outputSha: shaSchema }).strict();

const spendSchema = z.object({
  runs: z.number().int().min(0), runnerMs: z.number().min(0).finite(),
  credits: z.number().min(0).finite(), nearLimit: z.number().int().min(0),
  preempted: z.number().int().min(0),
  models: z.array(modelSchema).max(2000).optional(),
}).strict();

export const lifecycleSchema = z.object({
  schemaVersion: z.literal(2), issueNumber: numberSchema,
  requester: text.max(100), request: text.max(60000), phase: phaseSchema,
  baseSha: shaSchema, headSha: shaSchema, controlSha: shaSchema,
  baseBranch: text.max(200), branch: z.string().regex(/^agentic\/epic-\d+-v\d+$/),
  plan: z.object({ version: numberSchema, body: text.max(24000), hash: hashSchema }).strict().optional(),
  approval: z.object({
    actor: text.max(100), commentId: numberSchema, planHash: hashSchema, at: z.iso.datetime(),
  }).strict().optional(),
  tasks: z.array(taskSchema.extend({ issueNumber: numberSchema.optional(), completed: z.boolean() })).max(12),
  tasksLinked: z.boolean().optional(),
  retiredTasks: z.array(numberSchema).max(120),
  job: jobSchema.optional(),
  evidence: z.array(z.object({
    stage: stageSchema, sha: shaSchema, jobId: text, runId: numberSchema, summary: text.max(12000),
  }).strict()).max(100),
  processedEvents: z.array(z.string()).max(10000),
  sequence: z.number().int().min(0), repairs: z.number().int().min(0), failures: z.number().int().min(0),
  spend: spendSchema.extend({ historyComplete: z.boolean() }),
  pendingCosts: z.array(z.object({
    job: jobIdentitySchema,
    expiresAt: z.iso.datetime(),
    observed: observedCostSchema.optional(),
    acceptedResult: acceptedUsageResultSchema.optional(),
  }).strict()).max(100).refine(items => new Set(items.map(item => item.job.id)).size === items.length,
    'Duplicate pending cost job').optional(),
  usageHistory: z.array(z.object({
    job: jobIdentitySchema,
    persona: z.string().nullable(),
    observed: observedCostSchema.optional(),
    acceptedResult: acceptedUsageResultSchema.optional(),
  }).strict().refine(record => record.persona ===
    (['scan', 'validate'].includes(record.job.stage) ? null : `sdlc-${record.job.stage}`),
  'Usage persona does not match registered stage')).max(100)
    .refine(items => new Set(items.map(item => item.job.id)).size === items.length, 'Duplicate usage job')
    .refine(items => {
      const runs = items.flatMap(item => item.job.runId === undefined ? [] : [item.job.runId]);
      return new Set(runs).size === runs.length;
    }, 'Duplicate usage run').optional(),
  feedback: z.string().max(24000), resumePhase: phaseSchema.optional(), error: z.string().max(12000).optional(),
  prNumber: numberSchema.optional(),
}).strict() satisfies z.ZodType<Lifecycle>;

const storedLifecycleSchema = z.discriminatedUnion('schemaVersion', [
  lifecycleSchema,
  lifecycleSchema.extend({ schemaVersion: z.literal(1), spend: spendSchema.optional(), pendingCosts: z.never().optional(),
    usageHistory: z.never().optional() }),
]);

export function migrateLifecycle(input: unknown): Lifecycle {
  const state = storedLifecycleSchema.parse(input);
  if (state.schemaVersion === 2) return state;
  return {
    ...state,
    schemaVersion: 2,
    spend: state.spend ? { ...state.spend, historyComplete: true } : {
      runs: 0, runnerMs: 0, credits: 0, nearLimit: 0, preempted: 0, historyComplete: false,
    },
  };
}