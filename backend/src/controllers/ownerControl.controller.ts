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
type AttendanceRow = { attendance_date: string; location_id: string };
type LocationRow = { id: string; name: string; is_main: boolean; is_active: boolean };
type MoneyRow = { amount: number; currency: string };
type MoneySummary = { count: number; byCurrency: Array<{ currency: string; amount: number }> };
type ActorRow = {
  id: string;
  role: string;
  managed_full_name: string | null;
  profiles: { full_name?: string | null } | Array<{ full_name?: string | null }> | null;
};

const reportQuerySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  locationId: z.string().uuid().optional(),
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

export async function getOwnerReport(request: Request, response: Response) {
  const input = reportQuerySchema.safeParse(request.query);
  if (!input.success) throw new AppError(400, 'INVALID_OWNER_REPORT_FILTERS', 'Revisa las fechas y la sucursal del reporte.', input.error.flatten());

  const { from, to, locationId } = input.data;
  const client = request.supabase!;
  const gymId = request.tenant!.gymId;
  const timezone = request.tenant!.timezone;
  const eventFrom = localMidnightAsUtc(from, timezone);
  const eventTo = localMidnightAsUtc(addDays(to, 1), timezone);
  const today = dateInTimezone(timezone);

  const locations = await collectRows<LocationRow>((rangeFrom, rangeTo) => client
    .from('gym_locations').select('id,name,is_main,is_active').eq('gym_id', gymId)
    .order('is_main', { ascending: false }).order('name').range(rangeFrom, rangeTo));

  if (locationId && !locations.some((location) => location.id === locationId)) {
    throw new AppError(400, 'INVALID_REPORT_LOCATION', 'La sucursal seleccionada no pertenece al gimnasio.');
  }

  const readPayments = (status: PaymentRow['status'], timestampField: 'paid_at' | 'voided_at' | 'refunded_at') =>
    collectRows<PaymentRow>((rangeFrom, rangeTo) => {
      let query = client.from('member_payments')
        .select('member_user_id,location_id,membership_id,amount,currency,status,paid_at,voided_at,refunded_at')
        .eq('gym_id', gymId).not('membership_id', 'is', null).eq('status', status)
        .gte(timestampField, eventFrom).lt(timestampField, eventTo).order(timestampField, { ascending: false });
      if (locationId) query = query.eq('location_id', locationId);
      return query.range(rangeFrom, rangeTo);
    });

  const membersPromise = collectRows<MemberRow>((rangeFrom, rangeTo) => {
    let query = client.from('gym_users').select('id,status,default_location_id')
      .eq('gym_id', gymId).eq('role', 'member').order('created_at', { ascending: false });
    if (locationId) query = query.eq('default_location_id', locationId);
    return query.range(rangeFrom, rangeTo);
  });

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
    let query = client.from('attendances').select('attendance_date,location_id')
      .eq('gym_id', gymId).eq('status', 'valid').gte('attendance_date', from)
      .lte('attendance_date', to).order('attendance_date');
    if (locationId) query = query.eq('location_id', locationId);
    return query.range(rangeFrom, rangeTo);
  });

  const [confirmedPayments, voidedPayments, refundedPayments, members, memberships, debtPayments, attendances] = await Promise.all([
    readPayments('confirmed', 'paid_at'), readPayments('voided', 'voided_at'),
    readPayments('refunded', 'refunded_at'), membersPromise, membershipsPromise,
    debtPaymentsPromise, attendancesPromise,
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

  response.json({
    range: { from, to }, selectedLocationId: locationId ?? null,
    locations: locations.filter((location) => location.is_active)
      .map((location) => ({ id: location.id, name: location.name, isMain: location.is_main })),
    financial: {
      confirmed: summarizeMoney(confirmedPayments.map((payment) => ({ amount: Number(payment.amount), currency: payment.currency }))),
      voided: summarizeMoney(voidedPayments.map((payment) => ({ amount: Number(payment.amount), currency: payment.currency }))),
      refunded: summarizeMoney(refundedPayments.map((payment) => ({ amount: Number(payment.amount), currency: payment.currency }))),
      outstanding,
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
      byLocation: locations.map((location) => ({
        locationId: location.id, locationName: location.name,
        count: attendanceByLocation.get(location.id) ?? 0,
      })),
    },
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
  const actorsResult = actorIds.length
    ? await client.from('gym_users').select('id,role,managed_full_name,profiles(full_name)')
      .eq('gym_id', request.tenant!.gymId).in('id', actorIds)
    : { data: [], error: null };
  if (actorsResult.error) throw fromSupabaseError(actorsResult.error);
  const actors = new Map(((actorsResult.data ?? []) as ActorRow[]).map((actor) => [actor.id, actor]));
  const total = auditResult.count ?? 0;

  response.json({
    items: items.map((item) => {
      const actor = item.actor_gym_user_id ? actors.get(item.actor_gym_user_id) : undefined;
      return {
        id: item.id, actorGymUserId: item.actor_gym_user_id, actorName: actorName(actor),
        actorRole: actor?.role ?? 'system', action: item.action, entityType: item.entity_type,
        entityId: item.entity_id, permissionKey: item.permission_key,
        usedPinElevation: item.used_pin_elevation, beforeData: item.before_data,
        afterData: item.after_data, createdAt: item.created_at,
      };
    }),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  });
}
