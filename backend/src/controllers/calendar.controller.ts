import type { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { exceptionSchema, scheduleSchema } from '../validators/calendar.validator.js';
import { writeAuditLog } from '../services/audit.service.js';

async function ensureLocation(request: Request, locationId: string) {
  const { data, error } = await request.supabase!.from('gym_locations').select('id,name,address,city,timezone,email,phone,whatsapp_phone,is_main,is_active').eq('id', locationId).maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw new AppError(404, 'LOCATION_NOT_FOUND', 'La sucursal no pertenece al gimnasio.');
  return data;
}

export async function getCalendar(request: Request, response: Response) {
  const locationId = typeof request.query.locationId === 'string' ? request.query.locationId : request.tenant!.defaultLocationId;
  if (!locationId) throw new AppError(400, 'LOCATION_REQUIRED', 'Selecciona una sucursal.');
  const location = await ensureLocation(request, locationId);
  const from = typeof request.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(request.query.from) ? request.query.from : new Date().toISOString().slice(0, 10);
  const to = typeof request.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(request.query.to) ? request.query.to : undefined;
  let exceptionsQuery = request.supabase!.from('location_calendar_exceptions').select('id,calendar_date,day_mode,opens_at,closes_at,reason').eq('location_id', locationId).gte('calendar_date', from).order('calendar_date').limit(100);
  if (to) exceptionsQuery = exceptionsQuery.lte('calendar_date', to);
  const [hours, exceptions, gym] = await Promise.all([
    request.supabase!.from('location_opening_hours').select('id,weekday,opens_at,closes_at,day_mode').eq('location_id', locationId).order('weekday'),
    exceptionsQuery,
    request.supabase!.from('gyms').select('id,name,email,phone,whatsapp_phone,timezone,currency').eq('id', request.tenant!.gymId).single(),
  ]);
  const error = hours.error ?? exceptions.error ?? gym.error;
  if (error) throw fromSupabaseError(error);
  response.json({ location, gym: gym.data, hours: hours.data ?? [], exceptions: exceptions.data ?? [] });
}

export async function saveSchedule(request: Request, response: Response) {
  const input = scheduleSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_SCHEDULE_INPUT', 'El horario semanal no es válido.', input.error.flatten());
  await ensureLocation(request, input.data.locationId);
  const rows = input.data.days.map((day) => ({ gym_id: request.tenant!.gymId, location_id: input.data.locationId, weekday: day.weekday, day_mode: day.dayMode, opens_at: day.dayMode === 'closed' ? null : day.opensAt, closes_at: day.dayMode === 'closed' ? null : day.closesAt }));
  const { data, error } = await supabaseAdmin.from('location_opening_hours').upsert(rows, { onConflict: 'location_id,weekday' }).select('id,weekday,opens_at,closes_at,day_mode');
  if (error) throw fromSupabaseError(error);
  await writeAuditLog(request, {
    action: 'calendar.schedule_updated', entityType: 'gym_location', entityId: input.data.locationId,
    afterData: { days: data },
  });
  response.json({ hours: data });
}

export async function saveException(request: Request, response: Response) {
  const input = exceptionSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_EXCEPTION_INPUT', 'La excepción de calendario no es válida.', input.error.flatten());
  await ensureLocation(request, input.data.locationId);
  const { data, error } = await supabaseAdmin.from('location_calendar_exceptions').upsert({ gym_id: request.tenant!.gymId, location_id: input.data.locationId, calendar_date: input.data.calendarDate, day_mode: input.data.dayMode, opens_at: input.data.dayMode === 'closed' ? null : input.data.opensAt, closes_at: input.data.dayMode === 'closed' ? null : input.data.closesAt, reason: input.data.reason ?? null, created_by: request.tenant!.gymUserId }, { onConflict: 'location_id,calendar_date' }).select('id,calendar_date,day_mode,opens_at,closes_at,reason').single();
  if (error) throw fromSupabaseError(error);
  await writeAuditLog(request, {
    action: 'calendar.exception_saved', entityType: 'calendar_exception', entityId: data.id,
    afterData: data,
  });
  response.status(201).json({ exception: data });
}
