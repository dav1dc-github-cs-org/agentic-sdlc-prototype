export interface LocalTime {
  hour: number;
  minute: number;
  second: number;
}

/**
 * Resolves the local hour (0-23), minute, and second for a UTC instant in the
 * given IANA timezone. Pure function: the instant is always an explicit
 * parameter and no wall-clock, environment, or I/O is consulted.
 */
export function resolveLocalTime(instant: Date, timeZone: string): LocalTime {
  let parts: Intl.DateTimeFormatPart[];
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    parts = formatter.formatToParts(instant);
  } catch {
    throw new Error(`Unrecognised timezone identifier: ${timeZone}`);
  }

  const byType = new Map(parts.map(part => [part.type, part.value]));
  const hour = Number(byType.get('hour'));
  const minute = Number(byType.get('minute'));
  const second = Number(byType.get('second'));
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)) {
    throw new Error(`Unrecognised timezone identifier: ${timeZone}`);
  }

  return { hour: hour % 24, minute, second };
}
