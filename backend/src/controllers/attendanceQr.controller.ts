import type { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { createAttendanceQr, hashAttendanceQr } from '../security/attendanceQr.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { manageAttendanceQrSchema, qrAttendanceSchema } from '../validators/attendance.validator.js';

function ownerOnly(request: Request) {
  if (request.tenant!.role !== 'owner') throw new AppError(403, 'ATTENDANCE_QR_OWNER_REQUIRED', 'Solo el owner puede administrar los códigos de asistencia.');
}

export async function listAttendanceQr(request: Request, response: Response) {
  ownerOnly(request);
  response.setHeader('Cache-Control', 'no-store');
  const [codes, locations] = await Promise.all([
    supabaseAdmin.from('attendance_qr_codes')
      .select('id,location_id,created_at,revoked_at,expires_at')
      .eq('gym_id', request.tenant!.gymId).is('revoked_at', null).order('created_at', { ascending: false }),
    supabaseAdmin.from('gym_locations').select('id,name,is_active').eq('gym_id', request.tenant!.gymId).order('name'),
  ]);
  if (codes.error || locations.error) throw fromSupabaseError((codes.error ?? locations.error)!);
  response.json({ codes: codes.data, locations: locations.data });
}

export async function manageAttendanceQr(request: Request, response: Response) {
  ownerOnly(request);
  response.setHeader('Cache-Control', 'no-store');
  const input = manageAttendanceQrSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_QR_INPUT', 'Selecciona una sucursal y una operación válidas.');
  const secret = input.data.action === 'generate' ? createAttendanceQr() : null;
  const { data, error } = await supabaseAdmin.rpc('manage_attendance_qr_backend', {
    target_gym_id: request.tenant!.gymId, target_actor_id: request.tenant!.gymUserId,
    target_location_id: input.data.locationId, supplied_action: input.data.action,
    supplied_token_hash: secret?.hash ?? null,
  });
  if (error) throw fromSupabaseError(error);
  // El secreto solo se entrega al crearlo. No se persiste ni se incluye en auditoría.
  response.json({ code: data, token: secret?.token ?? null });
}

async function qrOperation(request: Request, response: Response, preview: boolean) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.tenant!.role !== 'member') throw new AppError(403, 'MEMBER_ONLY', 'Usa tu cuenta de miembro para registrar la asistencia.');
  const input = qrAttendanceSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'ATTENDANCE_QR_INVALID', 'Escanea un código de asistencia válido en la entrada del gimnasio.');
  const { data, error } = await supabaseAdmin.rpc(preview ? 'preview_attendance_qr_backend' : 'register_attendance_qr_backend', {
    target_gym_id: request.tenant!.gymId, target_member_id: request.tenant!.gymUserId,
    supplied_token_hash: hashAttendanceQr(input.data.token),
  });
  if (error) throw fromSupabaseError(error);
  response.status(preview || data.already_registered ? 200 : 201).json(data);
}

export async function previewQrAttendance(request: Request, response: Response) { return qrOperation(request, response, true); }
export async function registerQrAttendance(request: Request, response: Response) { return qrOperation(request, response, false); }
