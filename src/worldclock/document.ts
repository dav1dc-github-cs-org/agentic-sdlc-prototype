import { CLOCK_HEIGHT, CLOCK_WIDTH, renderClock } from './render.ts';

/**
 * Renders one or more analog clock faces, one per requested IANA timezone,
 * as a single well-formed SVG document. Clocks are laid out left to right
 * in the order supplied; duplicate timezones render independently, once per
 * occurrence. An empty `timeZones` list returns a valid, empty SVG document
 * rather than throwing. Pure function: no `Date.now()`, `process.env`, or
 * file/network/console I/O; the instant is always an explicit parameter.
 */
export function renderClocks(instant: Date, timeZones: readonly string[]): string {
  const width = CLOCK_WIDTH * timeZones.length;
  const height = CLOCK_HEIGHT;

  const groups = timeZones.map((timeZone, index) => renderClock(instant, timeZone, index * CLOCK_WIDTH)).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    groups +
    `</svg>`
  );
}
