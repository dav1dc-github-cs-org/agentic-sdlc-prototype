import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOCK_HEIGHT, CLOCK_WIDTH } from '../../src/worldclock/render.ts';
import { renderClocks } from '../../src/worldclock/document.ts';

test('renders one complete SVG document with one clock group per timezone, left to right', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const svg = renderClocks(instant, ['UTC', 'Europe/London', 'Asia/Kolkata']);

  assert.match(svg, /^<svg[^>]*>/);
  assert.match(svg, /<\/svg>$/);
  assert.equal((svg.match(/<g transform=/g) ?? []).length, 3);

  const utcIndex = svg.indexOf('translate(0,0)');
  const londonIndex = svg.indexOf(`translate(${CLOCK_WIDTH},0)`);
  const kolkataIndex = svg.indexOf(`translate(${CLOCK_WIDTH * 2},0)`);
  assert.ok(utcIndex >= 0 && londonIndex > utcIndex && kolkataIndex > londonIndex);

  assert.match(svg, /<text[^>]*>UTC<\/text>/);
  assert.match(svg, /<text[^>]*>Europe\/London<\/text>/);
  assert.match(svg, /<text[^>]*>Asia\/Kolkata<\/text>/);
});

test('sizes the document width to the number of clocks and a fixed height', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const svg = renderClocks(instant, ['UTC', 'UTC']);
  assert.match(svg, new RegExp(`width="${CLOCK_WIDTH * 2}"`));
  assert.match(svg, new RegExp(`height="${CLOCK_HEIGHT}"`));
});

test('returns a valid empty SVG document for an empty timezone list', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const svg = renderClocks(instant, []);
  assert.match(svg, /^<svg[^>]*><\/svg>$/);
  assert.equal((svg.match(/<g transform=/g) ?? []).length, 0);
});

test('renders a duplicated timezone once per occurrence', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const svg = renderClocks(instant, ['UTC', 'UTC', 'UTC']);
  assert.equal((svg.match(/<g transform=/g) ?? []).length, 3);
  assert.equal((svg.match(/<text[^>]*>UTC<\/text>/g) ?? []).length, 3);
});

test('renderClocks is deterministic: identical inputs produce byte-identical output', () => {
  const instant = new Date('2026-06-01T00:00:00Z');
  const first = renderClocks(instant, ['Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Eucla']);
  const second = renderClocks(instant, ['Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Eucla']);
  assert.equal(first, second);
});

test('propagates an unrecognised timezone error from within a document', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  assert.throws(() => renderClocks(instant, ['UTC', 'Not/AZone']), /Not\/AZone/);
});
