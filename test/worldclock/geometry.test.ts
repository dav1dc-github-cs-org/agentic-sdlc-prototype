import assert from 'node:assert/strict';
import test from 'node:test';
import { hourHandAngle, minuteHandAngle, secondHandAngle } from '../../src/worldclock/geometry.ts';

test('secondHandAngle equals second * 6 degrees', () => {
  assert.equal(secondHandAngle(0), 0);
  assert.equal(secondHandAngle(15), 90);
  assert.equal(secondHandAngle(30), 180);
  assert.equal(secondHandAngle(45), 270);
  assert.equal(secondHandAngle(59), 354);
});

test('secondHandAngle normalises wrap-around and negative inputs to [0, 360)', () => {
  assert.equal(secondHandAngle(60), 0);
  assert.equal(secondHandAngle(61), 6);
  assert.equal(secondHandAngle(-1), 354);
});

test('minuteHandAngle equals minute * 6 + second * 0.1 degrees', () => {
  assert.equal(minuteHandAngle(0, 0), 0);
  assert.equal(minuteHandAngle(15, 0), 90);
  assert.equal(minuteHandAngle(30, 0), 180);
  assert.equal(minuteHandAngle(30, 30), 183);
});

test('minuteHandAngle advances smoothly within the minute via seconds', () => {
  assert.equal(minuteHandAngle(10, 30), 63);
  assert.ok(minuteHandAngle(10, 0) < minuteHandAngle(10, 30));
  assert.ok(minuteHandAngle(10, 30) < minuteHandAngle(10, 59));
});

test('minuteHandAngle normalises wrap-around and negative inputs to [0, 360)', () => {
  assert.equal(minuteHandAngle(60, 0), 0);
  assert.equal(minuteHandAngle(0, -10), 359);
});

test('hourHandAngle equals (hour % 12) * 30 + minute * 0.5 degrees', () => {
  assert.equal(hourHandAngle(3, 0), 90);
  assert.equal(hourHandAngle(6, 30), 195);
  assert.equal(hourHandAngle(9, 0), 270);
});

test('6:30 local time places the hour hand midway between 6 and 7', () => {
  const angle = hourHandAngle(6, 30);
  assert.equal(angle, (180 + 210) / 2);
});

test('local midnight and local noon both place the hour hand at 0 degrees', () => {
  assert.equal(hourHandAngle(0, 0), 0);
  assert.equal(hourHandAngle(12, 0), 0);
});

test('hourHandAngle normalises wrap-around and negative inputs to [0, 360)', () => {
  assert.equal(hourHandAngle(24, 0), 0);
  assert.equal(hourHandAngle(0, -30), 345);
});

test('all three functions return angles strictly within [0, 360)', () => {
  for (const value of [-100, -1, 0, 59, 60, 61, 359, 360, 361, 1000]) {
    const s = secondHandAngle(value);
    const m = minuteHandAngle(value, 0);
    const h = hourHandAngle(value, 0);
    assert.ok(s >= 0 && s < 360, `secondHandAngle(${value}) = ${s}`);
    assert.ok(m >= 0 && m < 360, `minuteHandAngle(${value}, 0) = ${m}`);
    assert.ok(h >= 0 && h < 360, `hourHandAngle(${value}, 0) = ${h}`);
  }
});
