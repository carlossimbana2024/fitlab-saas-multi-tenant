export const DEFAULT_TIMEZONE = 'America/Guayaquil';
export const gymTimezone = (value?: string | null) => value ?? DEFAULT_TIMEZONE;
export function civilDate(timestamp: number, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(timestamp);
}
export function nextMidnight(now: number, timezone: string) {
  const today = civilDate(now, timezone);
  let lo = now, hi = now + 26 * 3_600_000;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (civilDate(mid, timezone) === today) lo = mid;
    else hi = mid;
  }
  return hi;
}
export function formatBranchInstant(value: string, timezone: string | null | undefined, options: Intl.DateTimeFormatOptions) {
  // SQL 0053 rejects missing location zones. Do not silently substitute the gym.
  if (!timezone) return 'Zona horaria de sucursal no disponible';
  return new Intl.DateTimeFormat('es-EC', { ...options, timeZone: timezone }).format(new Date(value));
}
export function monthInstants(month: string, timezone: string) {
  const [year, number] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year!, number!, 1)).toISOString().slice(0, 7);
  return {
    from: new Date(civilDayStart(month + '-01', timezone)).toISOString(),
    to: new Date(civilDayStart(next + '-01', timezone) - 1).toISOString(),
  };
}

function civilDayStart(day: string, timezone: string) {
  const anchor = Date.parse(day + 'T00:00:00Z');
  let lo = anchor - 48 * 3_600_000, hi = anchor + 48 * 3_600_000;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (civilDate(mid, timezone) < day) lo = mid;
    else hi = mid;
  }
  return hi;
}
