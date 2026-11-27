import { Octokit } from '@octokit/rest';
import { readFileSync } from 'node:fs';
import { resolvePolicy } from './contracts.ts';
import { targetToken } from './installation.ts';
import { reconcile } from './reconcile.ts';
import { intakeTemplate, loadRegistry } from './targets.ts';

const policy = resolvePolicy(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')), process.env.SDLC_AIC_CREDIT_LIMIT);
if (!process.env.GH_TOKEN) throw new Error('A scoped GitHub App token is required');
const repository = process.env.GITHUB_REPOSITORY ?? '';
const client = (auth: string) => new Octokit({ auth, request: { timeout: 30_000 } });
const repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
// The registry is read from the checked-out controller revision, which reconcile() proves is the current default branch.
const registry = loadRegistry(Number.isSafeInteger(repositoryId) && repositoryId > 0 ? { id: repositoryId, repository } : undefined);
const ok = await reconcile({
  repository, sha: process.env.GITHUB_SHA, policy, botLogin: process.env.SDLC_BOT_LOGIN ?? '', model: process.env.SDLC_MODEL,
  controlApi: client(process.env.GH_TOKEN), registry,
  event: process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {},
  issue: process.env.SDLC_ISSUE, target: process.env.SDLC_TARGET,
  targetApi: async target => client(await targetToken(
    { appId: process.env.SDLC_APP_ID ?? '', privateKey: process.env.SDLC_APP_PRIVATE_KEY ?? '' }, target, client)),
  template: () => readFileSync(intakeTemplate, 'utf8'),
});
if (!ok) process.exitCode = 1;
