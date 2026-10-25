import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLocalTime } from '../../src/worldclock/time.ts';

test('resolves local hour, minute, and second for a UTC instant', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const result = resolveLocalTime(instant, 'UTC');
  assert.deepEqual(result, { hour: 12, minute: 34, second: 56 });
});

test('resolves fractional UTC-offset zones correctly', () => {
  const instant = new Date('2026-01-15T00:00:00Z');
  assert.deepEqual(resolveLocalTime(instant, 'Asia/Kolkata'), { hour: 5, minute: 30, second: 0 });
  assert.deepEqual(resolveLocalTime(instant, 'Asia/Kathmandu'), { hour: 5, minute: 45, second: 0 });
  assert.deepEqual(resolveLocalTime(instant, 'Australia/Eucla'), { hour: 8, minute: 45, second: 0 });
});

test('resolves daylight saving transitions on either side of the change', () => {
  const beforeDst = new Date('2026-03-08T06:30:00Z');
  const afterDst = new Date('2026-03-08T08:30:00Z');

  assert.deepEqual(resolveLocalTime(beforeDst, 'America/New_York'), { hour: 1, minute: 30, second: 0 });
  assert.deepEqual(resolveLocalTime(afterDst, 'America/New_York'), { hour: 4, minute: 30, second: 0 });

  const beforeUkDst = new Date('2026-03-29T00:30:00Z');
  const afterUkDst = new Date('2026-03-29T01:30:00Z');
  assert.deepEqual(resolveLocalTime(beforeUkDst, 'Europe/London'), { hour: 0, minute: 30, second: 0 });
  assert.deepEqual(resolveLocalTime(afterUkDst, 'Europe/London'), { hour: 2, minute: 30, second: 0 });
});

test('local midnight resolves to hour 0, not 24', () => {
  const instant = new Date('2026-01-15T00:00:00Z');
  assert.deepEqual(resolveLocalTime(instant, 'UTC'), { hour: 0, minute: 0, second: 0 });
});

test('an unrecognised timezone identifier throws naming the identifier', () => {
  assert.throws(() => resolveLocalTime(new Date(), 'Not/AZone'), /Not\/AZone/);
});
