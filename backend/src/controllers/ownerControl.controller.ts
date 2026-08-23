import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/AppError.js';
import { dateInTimezone } from '../utils/gymDate.js';
import { fromSupabaseError } from '../utils/supabaseError.js';

const PAGE_SIZE = 1000;
const MAX_REPORT_ROWS = 100_000;

type DatabaseError = { code?: string; message: string; details?: string | null };
type PaymentRow = {
  member_user_id: string | null;
  location_id: string;
  membership_id: string | null;
  amount: number | string;
  currency: string;
  status: 'confirmed' | 'voided' | 'refunded';
  paid_at: string;
  voided_at: string | null;
  refunded_at: string | null;
};
type MemberRow = { id: string; status: 'invited' | 'active' | 'suspended' | 'inactive'; default_location_id: string | null };
type PeriodRow = { starts_on: string; ends_on: string; status: string; charged_amount: number | string; currency: string };
type MembershipRow = { member_user_id: string; status: string; membership_periods: PeriodRow[] | null };
type MemberReportRow = MemberRow & {
  managed_full_name: string | null;
  profiles: { full_name?: string | null } | Array<{ full_name?: string | null }> | null;
};
type AttendanceRow = { attendance_date: string; location_id: string; checked_in_at: string; member_user_id: string };
type LocationRow = { id: string; name: string; is_main: boolean; is_active: boolean };
type MoneyRow = { amount: number; currency: string };
type MoneySummary = { count: number; byCurrency: Array<{ currency: string; amount: number }> };
type ActorRow = {
  id: string;
  role: string;
  managed_full_name: string | null;
  profiles: { full_name?: string | null } | Array<{ full_name?: string | null }> | null;
};
type AuditSummaryRow = { actor_gym_user_id: string | null; action: string; used_pin_elevation: boolean };
type ReportView = 'week' | 'month' | 'quarter' | 'year' | 'custom';
type DateBucket = { key: string; label: string; from: string; to: string };
type PermissionMode = 'allowed' | 'requires_pin' | 'denied';

const reportQuerySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  locationId: z.string().uuid().optional(),
  view: z.enum(['week', 'month', 'quarter', 'year', 'custom']).default('custom'),
}).superRefine((value, context) => {
  if (value.from > value.to) context.addIssue({ code: 'custom', path: ['to'], message: 'La fecha final debe ser posterior a la inicial.' });
  const days = Math.floor((Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000);
  if (days > 366) context.addIssue({ code: 'custom', path: ['to'], message: 'El reporte permite un máximo de 366 días.' });
});

const auditQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(100).optional(),
  usedPin: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(20),
}).superRefine((value, context) => {
  if (value.from && value.to && value.from > value.to) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'La fecha final debe ser posterior a la inicial.' });
  }
});

async function collectRows<T>(
  load: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: DatabaseError | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await load(offset, offset + PAGE_SIZE - 1);
    if (result.error) throw fromSupabaseError(result.error);
    const batch = (result.data ?? []) as T[];
    rows.push(...batch);
    if (rows.length > MAX_REPORT_ROWS) throw new AppError(413, 'REPORT_TOO_LARGE', 'El reporte contiene demasiados registros. Reduce el rango de fechas.');
    if (batch.length < PAGE_SIZE) return rows;
  }
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function inclusiveDays(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function shortDate(value: string): string {
  const [, month, day] = value.split('-');
  return `${day}/${month}`;
}

function buildDateBuckets(from: string, to: string, view: ReportView): DateBucket[] {
  const span = inclusiveDays(from, to);
  const mode = view === 'week' || (view === 'custom' && span <= 14)
    ? 'day'
    : view === 'month' || (view === 'custom' && span <= 62)
      ? 'week'
      : 'month';
  const buckets: DateBucket[] = [];

  if (mode === 'day') {
    for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
      buckets.push({ key: cursor, label: shortDate(cursor), from: cursor, to: cursor });
    }
    return buckets;
  }

  if (mode === 'week') {
    for (let cursor = from; cursor <= to; cursor = addDays(cursor, 7)) {
      const end = addDays(cursor, 6) < to ? addDays(cursor, 6) : to;
      buckets.push({ key: cursor, label: `${shortDate(cursor)}–${shortDate(end)}`, from: cursor, to: end });
    }
    return buckets;
  }

  let cursor = from;
  while (cursor <= to) {
    const year = Number(cursor.slice(0, 4));
    const month = Number(cursor.slice(5, 7));
    const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const monthEnd = addDays(nextMonth, -1);
    const end = monthEnd < to ? monthEnd : to;
    const label = new Intl.DateTimeFormat('es-EC', { month: 'short', timeZone: 'UTC' })
      .format(new Date(`${cursor}T00:00:00Z`)).replace('.', '');
    buckets.push({ key: cursor.slice(0, 7), label, from: cursor, to: end });
    cursor = nextMonth;
  }
  return buckets;
}

function bucketForDate(buckets: DateBucket[], value: string): DateBucket | undefined {
  return buckets.find((bucket) => value >= bucket.from && value <= bucket.to);
}

function timestampDate(value: string, timezone: string): string {
  return dateInTimezone(timezone, new Date(value));
}

function localAttendanceParts(value: string, timezone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { weekday: weekdays[values.weekday ?? ''] ?? 0, hour: Number(values.hour) };
}

function memberName(member: MemberReportRow): string {
  return relationOne(member.profiles)?.full_name ?? member.managed_full_name ?? 'Miembro sin nombre';
}

function timeZoneOffsetMilliseconds(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localClockAsUtc = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  );
  return localClockAsUtc - date.getTime();
}

function localMidnightAsUtc(value: string, timezone: string): string {
  const wallClock = Date.parse(`${value}T00:00:00Z`);
  let instant = wallClock;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    instant = wallClock - timeZoneOffsetMilliseconds(new Date(instant), timezone);
  }
  return new Date(instant).toISOString();
}

function summarizeMoney(rows: MoneyRow[]): MoneySummary {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!Number.isFinite(row.amount)) continue;
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount);
  }
  return {
    count: rows.length,
    byCurrency: [...totals.entries()]
      .map(([currency, amount]) => ({ currency, amount: Number(amount.toFixed(2)) }))
      .sort((left, right) => left.currency.localeCompare(right.currency)),
  };
}

function relationOne<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

function actorName(actor: ActorRow | undefined): string {
  return relationOne(actor?.profiles)?.full_name ?? actor?.managed_full_name ?? 'Sistema';
}

function moneyByCurrency(rows: PaymentRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + Number(row.amount));
  return totals;
}

function buildIncomeEvolution(
  confirmed: PaymentRow[], refunded: PaymentRow[], previousConfirmed: PaymentRow[],
  previousRefunded: PaymentRow[], buckets: DateBucket[], timezone: string,
) {
  const currencies = new Set([
    ...confirmed.map((row) => row.currency), ...refunded.map((row) => row.currency),
    ...previousConfirmed.map((row) => row.currency), ...previousRefunded.map((row) => row.currency),
  ]);
  return [...currencies].sort().map((currency) => {
    const points = buckets.map((bucket) => ({
      key: bucket.key, label: bucket.label, confirmed: 0, refunded: 0, net: 0,
    }));
    const pointByKey = new Map(points.map((point) => [point.key, point]));
    for (const payment of confirmed.filter((row) => row.currency === currency)) {
      const bucket = bucketForDate(buckets, timestampDate(payment.paid_at, timezone));
      if (bucket) pointByKey.get(bucket.key)!.confirmed += Number(payment.amount);
    }
    for (const payment of refunded.filter((row) => row.currency === currency && row.refunded_at)) {
      const bucket = bucketForDate(buckets, timestampDate(payment.refunded_at!, timezone));
      if (bucket) pointByKey.get(bucket.key)!.refunded += Number(payment.amount);
    }
    for (const point of points) {
      point.confirmed = Number(point.confirmed.toFixed(2));
      point.refunded = Number(point.refunded.toFixed(2));
      point.net = Number((point.confirmed - point.refunded).toFixed(2));
    }
    const currentNet = points.reduce((sum, point) => sum + point.net, 0);
    const previousConfirmedTotal = moneyByCurrency(previousConfirmed).get(currency) ?? 0;
    const previousRefundedTotal = moneyByCurrency(previousRefunded).get(currency) ?? 0;
    const previousNet = previousConfirmedTotal - previousRefundedTotal;
    return {
      currency, points, currentNet: Number(currentNet.toFixed(2)), previousNet: Number(previousNet.toFixed(2)),
      changePercentage: Math.abs(previousNet) < 0.005
        ? null
        : Number((((currentNet - previousNet) / Math.abs(previousNet)) * 100).toFixed(1)),
    };
  });
}

const AUDIT_FIELD_LABELS: Record<string, string> = {
  status: 'Estado', full_name: 'Nombre', phone: 'Teléfono', birth_date: 'Nacimiento',
  guardian_name: 'Representante', guardian_phone: 'Teléfono del representante', notes: 'Notas',
  account_mode: 'Tipo de acceso', email: 'Correo', starts_on: 'Inicio de cobertura', ends_on: 'Fin de cobertura',
  amount: 'Valor', currency: 'Moneda', reason: 'Motivo', failed_attempts: 'Intentos fallidos',
  locked_until: 'Bloqueo hasta', expires_at: 'Autorización válida hasta', permissions: 'Permisos',
  logo_url: 'Logotipo', history_preserved: 'Historial conservado', payments_unchanged: 'Pagos conservados',
};

const AUDIT_VALUE_LABELS: Record<string, string> = {
  active: 'Activo', suspended: 'Suspendido', inactive: 'Retirado', invited: 'Invitado', cancelled: 'Cancelado',
  confirmed: 'Confirmado', voided: 'Anulado', refunded: 'Reembolsado', managed: 'Sin cuenta', portal: 'Con portal',
  denied: 'Denegados', revoked: 'Retirados', true: 'Sí', false: 'No',
};

function auditRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function permissionMatrix(value: unknown): Record<string, PermissionMode> | null {
  const record = auditRecord(value);
  if (!record) return null;
  const entries = Object.entries(record).filter((entry): entry is [string, PermissionMode] =>
    entry[1] === 'allowed' || entry[1] === 'requires_pin' || entry[1] === 'denied');
  return entries.length ? Object.fromEntries(entries) : null;
}

function readableAuditValue(key: string, value: unknown): string | null {
  if (value == null || !AUDIT_FIELD_LABELS[key]) return value == null && AUDIT_FIELD_LABELS[key] ? 'Sin registrar' : null;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  if (key === 'logo_url') return value ? 'Configurado' : 'Sin configurar';
  return AUDIT_VALUE_LABELS[value] ?? value;
}

function readableAuditDetails(beforeValue: unknown, afterValue: unknown) {
  const before = auditRecord(beforeValue) ?? {};
  const after = auditRecord(afterValue) ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => Boolean(AUDIT_FIELD_LABELS[key]));
  const changes: Array<{ label: string; before: string; after: string }> = [];
  const details: Array<{ label: string; value: string }> = [];
  for (const key of keys) {
    const beforeReadable = readableAuditValue(key, before[key]);
    const afterReadable = readableAuditValue(key, after[key]);
    if (beforeValue != null && afterValue != null && beforeReadable !== afterReadable) {
      changes.push({ label: AUDIT_FIELD_LABELS[key] ?? key, before: beforeReadable ?? 'Sin registrar', after: afterReadable ?? 'Sin registrar' });
    } else if (afterReadable != null) {
      details.push({ label: AUDIT_FIELD_LABELS[key] ?? key, value: afterReadable });
    }
  }
  return { changes, details };
}

export async function getOwnerReport(request: Request, response: Response) {
  const input = reportQuerySchema.safeParse(request.query);
  if (!input.success) throw new AppError(400, 'INVALID_OWNER_REPORT_FILTERS', 'Revisa las fechas y la sucursal del reporte.', input.error.flatten());

  const { from, to, locationId, view } = input.data;
  const client = request.supabase!;
  const gymId = request.tenant!.gymId;
  const timezone = request.tenant!.timezone;
  const eventFrom = localMidnightAsUtc(from, timezone);
  const eventTo = localMidnightAsUtc(addDays(to, 1), timezone);
  const periodDays = inclusiveDays(from, to);
  const previousToDate = addDays(from, -1);
  const previousFromDate = addDays(previousToDate, -(periodDays - 1));
  const previousEventFrom = localMidnightAsUtc(previousFromDate, timezone);
  const previousEventTo = localMidnightAsUtc(addDays(previousToDate, 1), timezone);
  const today = dateInTimezone(timezone);
  const buckets = buildDateBuckets(from, to, view);

  const locations = await collectRows<LocationRow>((rangeFrom, rangeTo) => client
    .from('gym_locations').select('id,name,is_main,is_active').eq('gym_id', gymId)
    .order('is_main', { ascending: false }).order('name').range(rangeFrom, rangeTo));

  if (locationId && !locations.some((location) => location.id === locationId)) {
    throw new AppError(400, 'INVALID_REPORT_LOCATION', 'La sucursal seleccionada no pertenece al gimnasio.');
  }

  const readPayments = (
    status: PaymentRow['status'], timestampField: 'paid_at' | 'voided_at' | 'refunded_at',
    rangeStart = eventFrom, rangeEnd = eventTo,
  ) =>
    collectRows<PaymentRow>((rangeFrom, rangeTo) => {
      let query = client.from('member_payments')
        .select('member_user_id,location_id,membership_id,amount,currency,status,paid_at,voided_at,refunded_at')
        .eq('gym_id', gymId).not('membership_id', 'is', null).eq('status', status)
        .gte(timestampField, rangeStart).lt(timestampField, rangeEnd).order(timestampField, { ascending: false });
      if (locationId) query = query.eq('location_id', locationId);
      return query.range(rangeFrom, rangeTo);
    });

  const membersPromise = collectRows<MemberReportRow>((rangeFrom, rangeTo) => {
    let query = client.from('gym_users').select('id,status,default_location_id,managed_full_name,profiles(full_name)')
      .eq('gym_id', gymId).eq('role', 'member').order('created_at', { ascending: false });
    if (locationId) query = query.eq('default_location_id', locationId);
    return query.range(rangeFrom, rangeTo);
  });

  const staffPromise = collectRows<ActorRow>((rangeFrom, rangeTo) => client.from('gym_users')
    .select('id,role,managed_full_name,profiles(full_name)').eq('gym_id', gymId).eq('role', 'staff')
    .range(rangeFrom, rangeTo));

  const membershipsPromise = collectRows<MembershipRow>((rangeFrom, rangeTo) => client
    .from('memberships')
    .select('member_user_id,status,membership_periods(starts_on,ends_on,status,charged_amount,currency)')
    .eq('gym_id', gymId).range(rangeFrom, rangeTo));

  const debtPaymentsPromise = collectRows<PaymentRow>((rangeFrom, rangeTo) => client
    .from('member_payments')
    .select('member_user_id,location_id,membership_id,amount,currency,status,paid_at,voided_at,refunded_at')
    .eq('gym_id', gymId).not('membership_id', 'is', null).eq('status', 'confirmed')
    .range(rangeFrom, rangeTo));

  const attendancesPromise = collectRows<AttendanceRow>((rangeFrom, rangeTo) => {
    let query = client.from('attendances').select('attendance_date,location_id,checked_in_at,member_user_id')
      .eq('gym_id', gymId).eq('status', 'valid').gte('attendance_date', from)
      .lte('attendance_date', to).order('attendance_date');
    if (locationId) query = query.eq('location_id', locationId);
    return query.range(rangeFrom, rangeTo);
  });

  const recentAttendancesPromise = collectRows<AttendanceRow>((rangeFrom, rangeTo) => {
    let query = client.from('attendances').select('attendance_date,location_id,checked_in_at,member_user_id')
      .eq('gym_id', gymId).eq('status', 'valid').gte('attendance_date', addDays(today, -30))
      .lte('attendance_date', today).order('attendance_date', { ascending: false });
    if (locationId) query = query.eq('location_id', locationId);
    return query.range(rangeFrom, rangeTo);
  });

  const auditSummaryPromise = collectRows<AuditSummaryRow>((rangeFrom, rangeTo) => client.from('audit_logs')
    .select('actor_gym_user_id,action,used_pin_elevation').eq('gym_id', gymId)
    .gte('created_at', eventFrom).lt('created_at', eventTo).order('created_at', { ascending: false })
    .range(rangeFrom, rangeTo));

  const [
    confirmedPayments, voidedPayments, refundedPayments, previousConfirmedPayments, previousRefundedPayments,
    members, staff, memberships, debtPayments, attendances, recentAttendances, auditSummary,
  ] = await Promise.all([
    readPayments('confirmed', 'paid_at'), readPayments('voided', 'voided_at'),
    readPayments('refunded', 'refunded_at'),
    readPayments('confirmed', 'paid_at', previousEventFrom, previousEventTo),
    readPayments('refunded', 'refunded_at', previousEventFrom, previousEventTo),
    membersPromise, staffPromise, membershipsPromise, debtPaymentsPromise,
    attendancesPromise, recentAttendancesPromise, auditSummaryPromise,
  ]);

  const memberIds = new Set(members.map((member) => member.id));
  const periodsByMember = new Map<string, Array<PeriodRow & { membershipStatus: string }>>();
  for (const membership of memberships) {
    if (!memberIds.has(membership.member_user_id)) continue;
    const periods = periodsByMember.get(membership.member_user_id) ?? [];
    for (const period of membership.membership_periods ?? []) periods.push({ ...period, membershipStatus: membership.status });
    periodsByMember.set(membership.member_user_id, periods);
  }

  const balances = new Map<string, { memberUserId: string; currency: string; amount: number }>();
  for (const [memberUserId, periods] of periodsByMember) {
    for (const period of periods) {
      if (period.status === 'cancelled' || period.membershipStatus === 'cancelled') continue;
      const key = `${memberUserId}:${period.currency}`;
      const current = balances.get(key) ?? { memberUserId, currency: period.currency, amount: 0 };
      current.amount += Number(period.charged_amount);
      balances.set(key, current);
    }
  }
  for (const payment of debtPayments) {
    if (!payment.member_user_id || !memberIds.has(payment.member_user_id)) continue;
    const key = `${payment.member_user_id}:${payment.currency}`;
    const current = balances.get(key) ?? { memberUserId: payment.member_user_id, currency: payment.currency, amount: 0 };
    current.amount -= Number(payment.amount);
    balances.set(key, current);
  }

  const outstandingBalances = [...balances.values()].filter((balance) => balance.amount > 0.005);
  const outstanding = summarizeMoney(outstandingBalances.map((balance) => ({ amount: balance.amount, currency: balance.currency })));
  outstanding.count = new Set(outstandingBalances.map((balance) => balance.memberUserId)).size;

  let expired = 0;
  for (const member of members) {
    if (member.status !== 'active') continue;
    const periods = (periodsByMember.get(member.id) ?? [])
      .filter((period) => period.status !== 'cancelled' && period.membershipStatus !== 'cancelled');
    const hasCurrentCoverage = periods.some((period) => period.membershipStatus === 'active'
      && period.status === 'active' && period.starts_on <= today && period.ends_on >= today);
    const hasExpiredCoverage = periods.some((period) => period.ends_on < today);
    if (!hasCurrentCoverage && hasExpiredCoverage) expired += 1;
  }

  const dailyCounts = new Map<string, number>();
  const attendanceByLocation = new Map<string, number>();
  for (const attendance of attendances) {
    dailyCounts.set(attendance.attendance_date, (dailyCounts.get(attendance.attendance_date) ?? 0) + 1);
    attendanceByLocation.set(attendance.location_id, (attendanceByLocation.get(attendance.location_id) ?? 0) + 1);
  }
  const daily: Array<{ date: string; count: number }> = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    daily.push({ date: cursor, count: dailyCounts.get(cursor) ?? 0 });
  }

  const heatmapCounts = new Map<string, number>();
  let minimumHour = 23;
  let maximumHour = 0;
  for (const attendance of attendances) {
    const { weekday, hour } = localAttendanceParts(attendance.checked_in_at, timezone);
    heatmapCounts.set(`${hour}:${weekday}`, (heatmapCounts.get(`${hour}:${weekday}`) ?? 0) + 1);
    minimumHour = Math.min(minimumHour, hour);
    maximumHour = Math.max(maximumHour, hour);
  }
  if (!attendances.length) {
    minimumHour = 6;
    maximumHour = 22;
  }
  const heatmap = Array.from({ length: maximumHour - minimumHour + 1 }, (_, index) => {
    const hour = minimumHour + index;
    const counts = Array.from({ length: 7 }, (__, weekday) => heatmapCounts.get(`${hour}:${weekday}`) ?? 0);
    return { hour, label: `${String(hour).padStart(2, '0')}:00`, counts, total: counts.reduce((sum, count) => sum + count, 0) };
  });

  const lastAttendanceByMember = new Map<string, string>();
  for (const attendance of recentAttendances) {
    const current = lastAttendanceByMember.get(attendance.member_user_id);
    if (!current || attendance.attendance_date > current) lastAttendanceByMember.set(attendance.member_user_id, attendance.attendance_date);
  }
  const renewalBuckets = [
    { key: 'next7', label: 'Próximos 7 días', count: 0 },
    { key: 'next15', label: 'Entre 8 y 15 días', count: 0 },
    { key: 'next30', label: 'Entre 16 y 30 días', count: 0 },
  ];
  const atRisk: Array<{ memberUserId: string; name: string; lastAttendanceDate: string | null; daysWithoutAttendance: number | null; endsOn: string }> = [];
  for (const member of members.filter((item) => item.status === 'active')) {
    const eligiblePeriods = (periodsByMember.get(member.id) ?? [])
      .filter((period) => period.status === 'active' && period.membershipStatus === 'active' && period.ends_on >= today)
      .sort((left, right) => right.ends_on.localeCompare(left.ends_on));
    const coverageEnd = eligiblePeriods[0]?.ends_on;
    if (!coverageEnd) continue;
    const daysUntilEnd = inclusiveDays(today, coverageEnd) - 1;
    if (daysUntilEnd <= 7) renewalBuckets[0]!.count += 1;
    else if (daysUntilEnd <= 15) renewalBuckets[1]!.count += 1;
    else if (daysUntilEnd <= 30) renewalBuckets[2]!.count += 1;

    const hasCurrentCoverage = eligiblePeriods.some((period) => period.starts_on <= today);
    if (!hasCurrentCoverage) continue;
    const lastAttendanceDate = lastAttendanceByMember.get(member.id) ?? null;
    const daysWithoutAttendance = lastAttendanceDate ? inclusiveDays(lastAttendanceDate, today) - 1 : null;
    if (daysWithoutAttendance == null || daysWithoutAttendance >= 14) {
      atRisk.push({ memberUserId: member.id, name: memberName(member), lastAttendanceDate, daysWithoutAttendance, endsOn: coverageEnd });
    }
  }
  atRisk.sort((left, right) => (right.daysWithoutAttendance ?? 31) - (left.daysWithoutAttendance ?? 31));

  const visibleLocations = locations.filter((location) => location.is_active && (!locationId || location.id === locationId));
  const locationComparison = visibleLocations.map((location) => ({
    locationId: location.id,
    locationName: location.name,
    isMain: location.is_main,
    revenue: summarizeMoney(confirmedPayments
      .filter((payment) => payment.location_id === location.id)
      .map((payment) => ({ amount: Number(payment.amount), currency: payment.currency }))),
    attendances: attendanceByLocation.get(location.id) ?? 0,
    activeMembers: members.filter((member) => member.status === 'active' && member.default_location_id === location.id).length,
  }));

  const staffById = new Map(staff.map((item) => [item.id, item]));
  const sensitiveActions = new Set([
    'payment.voided', 'payment.refunded', 'membership.cancelled', 'attendance.voided',
    'staff.permissions_updated', 'staff.status_updated', 'staff.removed',
  ]);
  const activityByStaff = new Map<string, { actions: number; pinActions: number; sensitiveActions: number }>();
  for (const event of auditSummary) {
    if (!event.actor_gym_user_id || !staffById.has(event.actor_gym_user_id)) continue;
    const current = activityByStaff.get(event.actor_gym_user_id) ?? { actions: 0, pinActions: 0, sensitiveActions: 0 };
    current.actions += 1;
    if (event.used_pin_elevation) current.pinActions += 1;
    if (sensitiveActions.has(event.action)) current.sensitiveActions += 1;
    activityByStaff.set(event.actor_gym_user_id, current);
  }
  const staffActivity = [...activityByStaff.entries()].map(([staffUserId, totals]) => ({
    staffUserId, name: actorName(staffById.get(staffUserId)), ...totals,
  })).sort((left, right) => right.actions - left.actions);
  const auditAlerts = {
    failedPinAttempts: auditSummary.filter((event) => event.action === 'admin_pin.attempt_failed').length,
    blockedPinAttempts: auditSummary.filter((event) => event.action === 'admin_pin.attempt_blocked').length,
    reversals: auditSummary.filter((event) => event.action === 'payment.voided' || event.action === 'payment.refunded').length,
    attendanceVoids: auditSummary.filter((event) => event.action === 'attendance.voided').length,
  };

  const incomeEvolution = buildIncomeEvolution(
    confirmedPayments, refundedPayments, previousConfirmedPayments, previousRefundedPayments, buckets, timezone,
  );

  response.json({
    range: { from, to, view, previousFrom: previousFromDate, previousTo: previousToDate }, selectedLocationId: locationId ?? null,
    locations: locations.filter((location) => location.is_active)
      .map((location) => ({ id: location.id, name: location.name, isMain: location.is_main })),
    financial: {
      confirmed: summarizeMoney(confirmedPayments.map((payment) => ({ amount: Number(payment.amount), currency: payment.currency }))),
      voided: summarizeMoney(voidedPayments.map((payment) => ({ amount: Number(payment.amount), currency: payment.currency }))),
      refunded: summarizeMoney(refundedPayments.map((payment) => ({ amount: Number(payment.amount), currency: payment.currency }))),
      outstanding, evolution: incomeEvolution,
    },
    members: {
      active: members.filter((member) => member.status === 'active').length,
      suspended: members.filter((member) => member.status === 'suspended').length,
      retired: members.filter((member) => member.status === 'inactive').length,
      expired,
    },
    attendance: {
      total: attendances.length,
      daily,
      heatmap,
      byLocation: locations.map((location) => ({
        locationId: location.id, locationName: location.name,
        count: attendanceByLocation.get(location.id) ?? 0,
      })),
    },
    retention: {
      renewalBuckets,
      atRiskCount: atRisk.length,
      atRiskMembers: atRisk.slice(0, 8),
      riskRuleDays: 14,
    },
    locationComparison,
    staffActivity: { people: staffActivity, alerts: auditAlerts },
  });
}

export async function listOwnerAudit(request: Request, response: Response) {
  const input = auditQuerySchema.safeParse(request.query);
  if (!input.success) throw new AppError(400, 'INVALID_AUDIT_FILTERS', 'Revisa los filtros de auditoría.', input.error.flatten());

  const { from, to, action, entityType, usedPin, page, pageSize } = input.data;
  const client = request.supabase!;
  const timezone = request.tenant!.timezone;
  const offset = (page - 1) * pageSize;

  let query = client.from('audit_logs')
    .select('id,actor_gym_user_id,action,entity_type,entity_id,permission_key,used_pin_elevation,before_data,after_data,created_at', { count: 'exact' })
    .eq('gym_id', request.tenant!.gymId).order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);
  if (from) query = query.gte('created_at', localMidnightAsUtc(from, timezone));
  if (to) query = query.lt('created_at', localMidnightAsUtc(addDays(to, 1), timezone));
  if (action) query = query.ilike('action', `%${action}%`);
  if (entityType) query = query.ilike('entity_type', `%${entityType}%`);
  if (usedPin !== undefined) query = query.eq('used_pin_elevation', usedPin === 'true');

  const auditResult = await query;
  if (auditResult.error) throw fromSupabaseError(auditResult.error);
  const items = auditResult.data ?? [];
  const actorIds = [...new Set(items.map((item) => item.actor_gym_user_id).filter((id): id is string => Boolean(id)))];
  const entityGymUserIds = items
    .filter((item) => item.entity_type === 'gym_user')
    .map((item) => item.entity_id)
    .filter((id): id is string => Boolean(id));
  const relatedGymUserIds = [...new Set([...actorIds, ...entityGymUserIds])];
  const [actorsResult, catalogResult] = await Promise.all([
    relatedGymUserIds.length
    ? await client.from('gym_users').select('id,role,managed_full_name,profiles(full_name)')
      .eq('gym_id', request.tenant!.gymId).in('id', relatedGymUserIds)
    : Promise.resolve({ data: [], error: null }),
    client.from('permission_catalog').select('key,name,description').order('key'),
  ]);
  const relatedError = actorsResult.error ?? catalogResult.error;
  if (relatedError) throw fromSupabaseError(relatedError);
  const actors = new Map(((actorsResult.data ?? []) as ActorRow[]).map((actor) => [actor.id, actor]));
  const permissionNames = new Map((catalogResult.data ?? []).map((permission) => [permission.key, permission.name]));
  const total = auditResult.count ?? 0;

  response.json({
    items: items.map((item) => {
      const actor = item.actor_gym_user_id ? actors.get(item.actor_gym_user_id) : undefined;
      const entityUser = item.entity_type === 'gym_user' && item.entity_id
        ? actors.get(item.entity_id)
        : undefined;
      const beforePermissions = item.action === 'staff.permissions_updated' ? permissionMatrix(item.before_data) : null;
      const afterPermissions = item.action === 'staff.permissions_updated' ? permissionMatrix(item.after_data) : null;
      const permissionKeys = afterPermissions
        ? [...new Set([...(beforePermissions ? Object.keys(beforePermissions) : []), ...Object.keys(afterPermissions)])].sort()
        : [];
      const permissionChanges = beforePermissions && afterPermissions
        ? permissionKeys.filter((key) => beforePermissions[key] !== afterPermissions[key]).map((key) => ({
          key, name: permissionNames.get(key) ?? 'Permiso', before: beforePermissions[key] ?? 'denied', after: afterPermissions[key] ?? 'denied',
        }))
        : [];
      const permissionSnapshot = !beforePermissions && afterPermissions
        ? permissionKeys.map((key) => ({ key, name: permissionNames.get(key) ?? 'Permiso', mode: afterPermissions[key] }))
        : [];
      const readable = item.action === 'staff.permissions_updated'
        ? { changes: [], details: [] }
        : readableAuditDetails(item.before_data, item.after_data);
      return {
        id: item.id, actorName: actorName(actor),
        actorRole: actor?.role ?? 'system', action: item.action, entityType: item.entity_type,
        entityName: entityUser ? actorName(entityUser) : null,
        entityRole: entityUser?.role ?? null,
        usedPinElevation: item.used_pin_elevation,
        permissionChanges, permissionSnapshot,
        changes: readable.changes, details: readable.details,
        createdAt: item.created_at,
      };
    }),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  });
}
