import type { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { dateInTimezone } from '../utils/gymDate.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { attendanceListSchema, qrAttendanceSchema, staffAttendanceSchema, voidAttendanceSchema } from '../validators/attendance.validator.js';
import { writeAuditLog } from '../services/audit.service.js';

const attendanceFields = 'id,gym_id,location_id,member_user_id,membership_id,attendance_date,checked_in_at,source,counts_toward_streak,status,voided_at,voided_by,void_reason';

export async function registerQrAttendance(request: Request, response: Response) {
  if (request.tenant!.role !== 'member') throw new AppError(403, 'MEMBER_ONLY', 'El registro QR es exclusivo para miembros.');
  const input = qrAttendanceSchema.safeParse(request.body ?? {});
  if (!input.success) throw new AppError(400, 'INVALID_ATTENDANCE_INPUT', 'Los datos de asistencia no son válidos.');

  const locationId = input.data.locationId ?? request.tenant!.defaultLocationId;
  if (!locationId) throw new AppError(400, 'LOCATION_REQUIRED', 'Selecciona una sucursal.');

  let membershipId = input.data.membershipId;
  if (!membershipId) {
    const { data, error } = await request.supabase!.from('memberships').select('id')
      .eq('member_user_id', request.tenant!.gymUserId).eq('status', 'active').maybeSingle();
    if (error) throw fromSupabaseError(error);
    membershipId = data?.id;
  }
  if (!membershipId) throw new AppError(409, 'ACTIVE_MEMBERSHIP_REQUIRED', 'No existe una membresía activa.');

  const { data, error } = await supabaseAdmin.from('attendances').insert({
    gym_id: request.tenant!.gymId,
    location_id: locationId,
    member_user_id: request.tenant!.gymUserId,
    membership_id: membershipId,
    attendance_date: dateInTimezone(request.tenant!.timezone),
    source: 'qr',
    registered_by: request.tenant!.gymUserId,
  }).select(attendanceFields).single();
  if (error) throw fromSupabaseError(error);
  response.status(201).json({ attendance: data });
}

export async function registerStaffAttendance(request: Request, response: Response) {
  const input = staffAttendanceSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_ATTENDANCE_INPUT', 'Los datos de asistencia no son válidos.');

  const { data, error } = await supabaseAdmin.from('attendances').insert({
    gym_id: request.tenant!.gymId,
    location_id: input.data.locationId,
    member_user_id: input.data.memberUserId,
    membership_id: input.data.membershipId,
    attendance_date: dateInTimezone(request.tenant!.timezone),
    source: 'staff',
    registered_by: request.tenant!.gymUserId,
  }).select(attendanceFields).single();
  if (error) throw fromSupabaseError(error);
  await writeAuditLog(request, {
    action: 'attendance.registered_by_staff', entityType: 'attendance', entityId: data.id,
    afterData: { member_user_id: data.member_user_id, source: data.source },
  });
  response.status(201).json({ attendance: data });
}

export async function voidAttendance(request: Request, response: Response) {
  const attendanceId = zUuid(request.params.id);
  const input = voidAttendanceSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_VOID_INPUT', 'Debes indicar un motivo válido.');

  const { data, error } = await supabaseAdmin.from('attendances').update({
    status: 'voided',
    voided_at: new Date().toISOString(),
    voided_by: request.tenant!.gymUserId,
    void_reason: input.data.reason,
  }).eq('id', attendanceId).eq('gym_id', request.tenant!.gymId).eq('status', 'valid').select(attendanceFields).maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw new AppError(404, 'ATTENDANCE_NOT_FOUND', 'La asistencia no existe o no puede anularse.');
  await writeAuditLog(request, {
    action: 'attendance.voided', entityType: 'attendance', entityId: data.id,
    afterData: { status: data.status, reason: data.void_reason },
  });
  response.json({ attendance: data });
}

export async function listAttendances(request: Request, response: Response) {
  const input = attendanceListSchema.safeParse(request.query);
  if (!input.success) throw new AppError(400, 'INVALID_ATTENDANCE_FILTERS', 'Los filtros no son válidos.');
  let query = request.supabase!.from('attendances').select(attendanceFields).order('checked_in_at', { ascending: false }).limit(200);
  if (input.data.from) query = query.gte('attendance_date', input.data.from);
  if (input.data.to) query = query.lte('attendance_date', input.data.to);
  if (input.data.memberUserId) query = query.eq('member_user_id', input.data.memberUserId);
  const { data, error } = await query;
  if (error) throw fromSupabaseError(error);
  response.json({ attendances: data });
}

export async function listStreaks(request: Request, response: Response) {
  let query = request.supabase!.from('user_streaks')
    .select('id,member_user_id,status,current_streak,longest_streak,last_attendance_date,frozen_at,updated_at')
    .order('current_streak', { ascending: false }).limit(200);
  if (typeof request.query.memberUserId === 'string') query = query.eq('member_user_id', zUuid(request.query.memberUserId));
  const { data, error } = await query;
  if (error) throw fromSupabaseError(error);
  response.json({ streaks: data });
}

export async function listWeeklyProgress(request: Request, response: Response) {
  const { data, error } = await request.supabase!.from('weekly_attendance_progress')
    .select('id,membership_id,week_starts_on,week_ends_on,target_attendances,completed_attendances,goal_met,is_grace_week,evaluated_at')
    .order('week_starts_on', { ascending: false }).limit(12);
  if (error) throw fromSupabaseError(error);
  response.json({ progress: data });
}

function zUuid(value: string | string[] | undefined): string {
  if (Array.isArray(value)) throw new AppError(400, 'INVALID_ID', 'El identificador no es válido.');
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(400, 'INVALID_ID', 'El identificador no es válido.');
  }
  return value;
}
