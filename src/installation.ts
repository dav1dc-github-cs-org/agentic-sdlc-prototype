import type { Octokit } from '@octokit/rest';
import { createPrivateKey, sign } from 'node:crypto';
import type { TargetRef } from './lifecycle.ts';
import { splitRepository } from './targets.ts';

// Administration is deliberately absent: the controller never changes target settings, rulesets, or branch protection.
export const targetPermissions = {
  actions: 'read', checks: 'write', contents: 'write', issues: 'write', pull_requests: 'write',
} as const;

export interface AppCredentials { appId: string; privateKey: string }

export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  if (!/^[1-9]\d{0,15}$/.test(appId)) throw new Error('Invalid GitHub App ID');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // Backdating absorbs runner clock skew; GitHub rejects tokens that expire more than ten minutes after issue.
  const issued = Math.floor(now / 1000) - 60;
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: issued, exp: issued + 600, iss: appId })}`;
  const key = createPrivateKey(privateKey.includes('\\n') ? privateKey.replaceAll('\\n', '\n') : privateKey);
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), key).toString('base64url')}`;
}

// Each target gets its own token scoped by repository ID, so one target's credential can never write to another.
export async function targetToken(app: AppCredentials, target: TargetRef, client: (auth: string) => Octokit,
  now = Date.now()): Promise<string> {
  if (!app.appId || !app.privateKey) {
    throw new Error('Foreign targets require SDLC_APP_ID and SDLC_APP_PRIVATE_KEY in the controller environment');
  }
  const api = client(appJwt(app.appId, app.privateKey, now));
  const { data: installation } = await api.apps.getRepoInstallation(splitRepository(target.repository));
  const { data } = await api.apps.createInstallationAccessToken({ installation_id: installation.id,
    repository_ids: [target.id], permissions: { ...targetPermissions } });
  if (data.repositories?.length !== 1 || data.repositories[0]!.id !== target.id) {
    throw new Error('The installation token is not scoped to exactly the registered target');
  }
  const granted: Record<string, string | undefined> = { ...data.permissions };
  for (const [name, level] of Object.entries(targetPermissions)) {
    if (granted[name] !== level) throw new Error(`The target installation did not grant ${name}: ${level}`);
  }
  if (Object.keys(granted).some(name => !(name in targetPermissions) && name !== 'metadata')) {
    throw new Error('The target installation token carries permissions beyond the controller request');
  }
  return data.token;
}
