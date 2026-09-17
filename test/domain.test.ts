import assert from 'node:assert/strict';
import test from 'node:test';
import { approvePlan, makePlan, parseCommand } from '../src/domain.ts';

const approvalInput = {
  phase: 'awaiting_approval' as const,
  plan: makePlan('Implement the accepted feature and regression tests.', 0),
  version: 1,
  authorized: true,
  actor: 'requester',
  commentId: 42,
  at: '2026-09-08T12:00:00Z',
};

test('an authorized approval binds to the exact plan hash', () => {
  assert.equal(approvePlan(approvalInput).planHash, approvalInput.plan.hash);
});

test('approved repair flexibility is hashed independently of object key order', () => {
  const policy = { allowTaskSplits: true, vendorSecurityPatches: [], dependencies: [] };
  const plan = makePlan('Keep the accepted requirements', 0, policy);
  const reordered = makePlan(plan.body, 0, { dependencies: [], vendorSecurityPatches: [], allowTaskSplits: true });
  assert.equal(plan.hash, reordered.hash);
  assert.equal(approvePlan({ ...approvalInput, plan }).planHash, plan.hash);
  assert.throws(() => approvePlan({ ...approvalInput, plan: { ...plan, policy: { ...policy, allowTaskSplits: false } } }), /integrity/);
  policy.allowTaskSplits = false;
  assert.equal(plan.policy!.allowTaskSplits, true);
});

test('an unauthorized requester cannot start implementation', () => {
  assert.throws(() => approvePlan({ ...approvalInput, authorized: false }), /not authorized/);
});

test('approval of an older plan cannot authorize its replacement', () => {
  const plan = makePlan('A different implementation direction.', 1);
  assert.throws(() => approvePlan({ ...approvalInput, plan }), /stale plan/);
});

test('plan tampering and approval outside the approval phase fail closed', () => {
  assert.throws(() => approvePlan({
    ...approvalInput, plan: { ...approvalInput.plan, body: 'Changed without versioning.' },
  }), /integrity/);
  assert.throws(() => approvePlan({ ...approvalInput, phase: 'coding' }), /no plan awaiting/);
});

test('only standalone, exact approval commands are accepted', () => {
  assert.deepEqual(parseCommand('/sdlc approve v1'), { kind: 'approve', version: 1 });
  for (const text of [
    'Please /sdlc approve v1', '/sdlc approve v0', '/sdlc approve v1\nextra',
    '```\n/sdlc approve v1\n```', '/sdlc approve v99999999999999999999',
    '/sdlc approve v1 && whoami', '/sdlc APPROVE v1',
  ]) assert.equal(parseCommand(text), undefined);
});

test('revision feedback and lifecycle controls are explicit', () => {
  assert.deepEqual(parseCommand('/sdlc revise Use a smaller scope.\nKeep the public API.'), {
    kind: 'revise', feedback: 'Use a smaller scope.\nKeep the public API.',
  });
  for (const kind of ['pause', 'resume', 'cancel', 'retry']) {
    assert.deepEqual(parseCommand(`/sdlc ${kind}`), { kind });
  }
  assert.equal(parseCommand('/sdlc revise   '), undefined);
});