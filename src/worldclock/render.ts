import { hourHandAngle, minuteHandAngle, secondHandAngle } from './geometry.ts';
import { resolveLocalTime } from './time.ts';

/** Radius of the clock face, in SVG user units. */
const FACE_RADIUS = 90;
/** Width of a single clock cell, including margin, in SVG user units. */
export const CLOCK_WIDTH = 200;
/** Height of a single clock cell, in SVG user units. */
export const CLOCK_HEIGHT = 220;

const CENTER_X = CLOCK_WIDTH / 2;
const CENTER_Y = CLOCK_HEIGHT / 2 - 10;

const HOUR_HAND_LENGTH = FACE_RADIUS * 0.5;
const MINUTE_HAND_LENGTH = FACE_RADIUS * 0.75;
const SECOND_HAND_LENGTH = FACE_RADIUS * 0.85;

const TICK_OUTER_RADIUS = FACE_RADIUS;
const TICK_INNER_RADIUS = FACE_RADIUS * 0.85;

/**
 * Rounds a number to a fixed precision so repeated renders of the same input
 * are byte-identical regardless of floating point noise.
 */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Escapes `&`, `<`, `>`, `"`, and `'` so untrusted text cannot break out of an
 * SVG text element or attribute.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Converts a clock-face angle (degrees clockwise from twelve) and a hand
 * length into an endpoint relative to a center point.
 */
function handEndpoint(centerX: number, centerY: number, angleDegrees: number, length: number): { x: number; y: number } {
  const radians = (angleDegrees * Math.PI) / 180;
  return {
    x: round(centerX + length * Math.sin(radians)),
    y: round(centerY - length * Math.cos(radians)),
  };
}

function renderTicks(centerX: number, centerY: number): string {
  const ticks: string[] = [];
  for (let i = 0; i < 12; i++) {
    const angleDegrees = i * 30;
    const outer = handEndpoint(centerX, centerY, angleDegrees, TICK_OUTER_RADIUS);
    const inner = handEndpoint(centerX, centerY, angleDegrees, TICK_INNER_RADIUS);
    ticks.push(
      `<line x1="${inner.x}" y1="${inner.y}" x2="${outer.x}" y2="${outer.y}" stroke="#333" stroke-width="2" />`,
    );
  }
  return ticks.join('');
}

/**
 * Renders a single analog clock face as an SVG `<g>` group showing the local
 * time in the given IANA timezone for the given UTC instant. Positioned via
 * a translation by `x` along the horizontal axis. Pure function: no
 * `Date.now()`, `process.env`, or file/network/console I/O.
 */
export function renderClock(instant: Date, timeZone: string, x: number): string {
  const { hour, minute, second } = resolveLocalTime(instant, timeZone);

  const hourAngle = hourHandAngle(hour, minute);
  const minuteAngle = minuteHandAngle(minute, second);
  const secondAngle = secondHandAngle(second);

  const hourEnd = handEndpoint(CENTER_X, CENTER_Y, hourAngle, HOUR_HAND_LENGTH);
  const minuteEnd = handEndpoint(CENTER_X, CENTER_Y, minuteAngle, MINUTE_HAND_LENGTH);
  const secondEnd = handEndpoint(CENTER_X, CENTER_Y, secondAngle, SECOND_HAND_LENGTH);

  const label = escapeXml(timeZone);

  return (
    `<g transform="translate(${round(x)},0)">` +
    `<circle cx="${CENTER_X}" cy="${CENTER_Y}" r="${FACE_RADIUS}" fill="#fff" stroke="#000" stroke-width="2" />` +
    renderTicks(CENTER_X, CENTER_Y) +
    `<line x1="${CENTER_X}" y1="${CENTER_Y}" x2="${hourEnd.x}" y2="${hourEnd.y}" stroke="#000" stroke-width="4" />` +
    `<line x1="${CENTER_X}" y1="${CENTER_Y}" x2="${minuteEnd.x}" y2="${minuteEnd.y}" stroke="#000" stroke-width="3" />` +
    `<line x1="${CENTER_X}" y1="${CENTER_Y}" x2="${secondEnd.x}" y2="${secondEnd.y}" stroke="#c00" stroke-width="1" />` +
    `<text x="${CENTER_X}" y="${CLOCK_HEIGHT - 10}" text-anchor="middle" font-size="14" font-family="sans-serif">${label}</text>` +
    `</g>`
  );
}
