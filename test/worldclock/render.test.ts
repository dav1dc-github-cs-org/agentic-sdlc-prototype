import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeXml, renderClock } from '../../src/worldclock/render.ts';

test('renders one clock group containing a face, twelve ticks, three hands, and a label', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const svg = renderClock(instant, 'UTC', 0);

  assert.match(svg, /^<g transform="translate\(0,0\)">/);
  assert.match(svg, /<\/g>$/);
  assert.equal((svg.match(/<circle/g) ?? []).length, 1);
  assert.equal((svg.match(/<line/g) ?? []).length, 12 + 3);
  assert.match(svg, /<text[^>]*>UTC<\/text>/);
});

test('positions the clock group by translating along x', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const svg = renderClock(instant, 'UTC', 250);
  assert.match(svg, /^<g transform="translate\(250,0\)">/);
});

test('renders the escaped timezone label as the SVG text content', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const svg = renderClock(instant, 'Europe/London', 0);
  assert.match(svg, /<text[^>]*>Europe\/London<\/text>/);
});

test('escapeXml escapes all five reserved characters', () => {
  assert.equal(escapeXml('&'), '&amp;');
  assert.equal(escapeXml('<'), '&lt;');
  assert.equal(escapeXml('>'), '&gt;');
  assert.equal(escapeXml('"'), '&quot;');
  assert.equal(escapeXml("'"), '&apos;');
  assert.equal(escapeXml('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
});

test('renderClock is a pure function: identical inputs produce identical output', () => {
  const instant = new Date('2026-06-01T00:00:00Z');
  const first = renderClock(instant, 'Asia/Kolkata', 100);
  const second = renderClock(instant, 'Asia/Kolkata', 100);
  assert.equal(first, second);
});

test('renderClock propagates an unrecognised timezone error', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  assert.throws(() => renderClock(instant, 'Not/AZone', 0), /Not\/AZone/);
});
