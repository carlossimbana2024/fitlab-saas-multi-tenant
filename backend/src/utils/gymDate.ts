export function dateInTimezone(timezone: string, date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function timeZoneOffsetMilliseconds(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localClockAsUtc = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  );
  return localClockAsUtc - date.getTime();
}

export function localMidnightAsUtc(value: string, timezone: string): string {
  const wallClock = Date.parse(`${value}T00:00:00Z`);
  let instant = wallClock;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    instant = wallClock - timeZoneOffsetMilliseconds(new Date(instant), timezone);
  }
  return new Date(instant).toISOString();
}
