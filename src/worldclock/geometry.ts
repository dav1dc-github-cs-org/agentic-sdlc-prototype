/**
 * Normalises a degree value into the range [0, 360).
 */
function normaliseDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * Angle of the second hand, in degrees clockwise from twelve, normalised to
 * [0, 360). Pure function: no I/O or side effects.
 */
export function secondHandAngle(second: number): number {
  return normaliseDegrees(second * 6);
}

/**
 * Angle of the minute hand, in degrees clockwise from twelve, normalised to
 * [0, 360). Advances smoothly within the minute using the seconds component.
 */
export function minuteHandAngle(minute: number, second: number): number {
  return normaliseDegrees(minute * 6 + second * 0.1);
}

/**
 * Angle of the hour hand, in degrees clockwise from twelve, normalised to
 * [0, 360). Advances smoothly within the hour using the minutes component.
 */
export function hourHandAngle(hour: number, minute: number): number {
  return normaliseDegrees((hour % 12) * 30 + minute * 0.5);
}
