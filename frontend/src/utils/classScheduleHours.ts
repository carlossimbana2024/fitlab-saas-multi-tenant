export type OpeningRule = { weekday?: number; calendar_date?: string; day_mode: string; opens_at: string | null; closes_at: string | null };
export type ClassCalendar = { location: { timezone: string }; hours: OpeningRule[]; exceptions: OpeningRule[] };
const dayMs = 86400000;
export function shiftDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
}
// Interpret datetime-local in the branch timezone, not the owner's device timezone.
export function branchInstant(local: string, timezone: string): number {
  const target = Date.parse(`${local.length === 16 ? local + ':00' : local}Z`);
  if (!Number.isFinite(target)) throw new Error('Selecciona una fecha y hora válida.');
  const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const wall = (instant: number) => Date.parse(formatter.format(new Date(instant)).replace(' ', 'T') + 'Z');
  let instant = target;
  for (let i = 0; i < 4; i++) instant += target - wall(instant);
  if (wall(instant) !== target) throw new Error('Esa hora no existe en la zona horaria de la sucursal.');
  // Do not silently choose between two occurrences during a DST fallback.
  if (wall(instant - 3600000) === target || wall(instant + 3600000) === target) throw new Error('Hora ambigua por cambio horario. Selecciona otra hora.');
  return instant;
}
export function openingRule(calendar: ClassCalendar, date: string) {
  return calendar.exceptions.find(r => r.calendar_date === date)
    ?? calendar.hours.find(r => r.weekday === (new Date(date + 'T12:00:00Z').getUTCDay() || 7));
}
export function checkClassHours(calendar: ClassCalendar, local: string, minutes: number) {
  const start = branchInstant(local, calendar.location.timezone);
  const end = start + minutes * 60000;
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 7 * 1440) return { allowed: false, start };
  const date = local.slice(0, 10);
  const windows: Array<[number, number]> = [];
  for (let i = -1; i <= Math.ceil(minutes / 1440); i++) {
    const day = shiftDate(date, i), r = openingRule(calendar, day);
    if (!r || r.day_mode === 'closed' || !r.opens_at || !r.closes_at) continue;
    const overnight = r.closes_at <= r.opens_at;
    const next = shiftDate(day, 1);
    const clipped = overnight && calendar.exceptions.some(x => x.calendar_date === next);
    const a = branchInstant(`${day}T${r.opens_at}`, calendar.location.timezone);
    const b = branchInstant(`${overnight ? next : day}T${clipped ? '00:00:00' : r.closes_at}`, calendar.location.timezone);
    if (b > a) windows.push([a, b]);
  }
  windows.sort((a,b) => a[0]-b[0]);
  let covered = start;
  for (const [a,b] of windows) { if (a > covered) break; if (b > covered) covered = b; }
  return { allowed: covered >= end, start };
}
