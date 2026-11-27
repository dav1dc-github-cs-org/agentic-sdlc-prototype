import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { Octokit } from '@octokit/rest';
import { appJwt, targetPermissions, targetToken } from '../src/installation.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const now = Date.parse('2026-09-10T12:00:00Z');
const target = { id: 42, repository: 'octo/app' };

function decode(token: string) {
  const [header, claims, signature] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header!, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(claims!, 'base64url').toString()),
    valid: verify('sha256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, 'base64url')),
  };
}

test('the App JWT is RS256-signed, backdated for clock skew, and inside the ten-minute limit', () => {
  const token = decode(appJwt('12345', pem, now));
  assert.deepEqual(token.header, { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(token.claims, { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '12345' });
  assert.equal(token.valid, true);
  // Secrets pasted as a single line keep escaped newlines.
  assert.equal(decode(appJwt('12345', pem.replaceAll('\n', '\\n'), now)).valid, true);
  for (const id of ['', '0', '12a', '-1', '1'.repeat(17)]) assert.throws(() => appJwt(id, pem, now), /Invalid GitHub App ID/);
  assert.throws(() => appJwt('12345', 'not a key', now));
});

interface Grant { repositories?: { id: number }[]; permissions?: Record<string, string> }

function fixture(grant: Grant) {
  const requests: { method: string; path: string; auth: string; body: Record<string, unknown> }[] = [];
  const auths: string[] = [];
  const client = (auth: string) => {
    auths.push(auth);
    return new Octokit({ auth, request: { fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ method: init?.method ?? 'GET', path: url.pathname, auth: headers.get('authorization') ?? '', body });
      const result = url.pathname === '/repos/octo/app/installation' ? { id: 77 } :
        url.pathname === '/app/installations/77/access_tokens' ? { token: 'ghs_target', expires_at: '2026-09-10T13:00:00Z', ...grant } :
          undefined;
      if (!result) throw new Error(`Unexpected request: ${url.pathname}`);
      const response = new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(response, 'url', { value: url.href });
      return response;
    } } });
  };
  return { client, requests, auths };
}

const exact: Grant = { repositories: [{ id: 42 }], permissions: { ...targetPermissions, metadata: 'read' } };

test('target tokens are minted per repository ID with exactly the controller permissions', async () => {
  const context = fixture(exact);
  assert.equal(await targetToken({ appId: '12345', privateKey: pem }, target, context.client, now), 'ghs_target');
  assert.equal(context.auths.length, 1);
  assert.equal(decode(context.auths[0]!).valid, true);
  assert.deepEqual(context.requests.map(request => `${request.method} ${request.path}`),
    ['GET /repos/octo/app/installation', 'POST /app/installations/77/access_tokens']);
  assert.ok(context.requests.every(request => request.auth === `bearer ${context.auths[0]}`));
  assert.deepEqual(context.requests[1]!.body, { repository_ids: [42], permissions: targetPermissions });
  assert.equal('administration' in targetPermissions, false);
});

test('a token wider or narrower than the registered target is refused', async () => {
  const app = { appId: '12345', privateKey: pem };
  const cases: [Grant, RegExp][] = [
    [{ ...exact, repositories: [{ id: 42 }, { id: 43 }] }, /exactly the registered target/],
    [{ ...exact, repositories: [{ id: 43 }] }, /exactly the registered target/],
    [{ ...exact, repositories: undefined }, /exactly the registered target/],
    [{ ...exact, permissions: { ...targetPermissions, contents: 'read' } }, /contents: write/],
    [{ ...exact, permissions: { ...targetPermissions, pull_requests: undefined as unknown as string } }, /pull_requests: write/],
    [{ ...exact, permissions: { ...targetPermissions, administration: 'write' } }, /beyond the controller request/],
  ];
  for (const [grant, error] of cases) {
    await assert.rejects(targetToken(app, target, fixture(grant).client, now), error);
  }
  for (const missing of [{ appId: '', privateKey: pem }, { appId: '12345', privateKey: '' }]) {
    const context = fixture(exact);
    await assert.rejects(targetToken(missing, target, context.client, now), /SDLC_APP_ID and SDLC_APP_PRIVATE_KEY/);
    assert.deepEqual(context.requests, []);
  }
});
