import type { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { gymSettingsSchema, locationSettingsSchema } from '../validators/settings.validator.js';
import { writeAuditLog } from '../services/audit.service.js';

const nullable = (value: string | null | undefined) => value?.trim() || null;

export async function getSettings(request: Request, response: Response) {
  const [gym, locations] = await Promise.all([
    request.supabase!.from('gyms').select('id,name,legal_name,email,phone,whatsapp_phone,timezone,currency').eq('id', request.tenant!.gymId).single(),
    request.supabase!.from('gym_locations').select('id,name,address,city,email,phone,whatsapp_phone,timezone,is_main,is_active').order('is_main', { ascending: false }).order('name'),
  ]);
  const error = gym.error ?? locations.error;
  if (error) throw fromSupabaseError(error);
  response.json({ gym: gym.data, locations: locations.data ?? [] });
}

export async function updateGymSettings(request: Request, response: Response) {
  const input = gymSettingsSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_GYM_SETTINGS', 'Los datos del gimnasio no son válidos.', input.error.flatten());
  const { data, error } = await supabaseAdmin.from('gyms').update({
    name: input.data.name,
    email: nullable(input.data.email),
    phone: nullable(input.data.phone),
    whatsapp_phone: nullable(input.data.whatsappPhone),
  }).eq('id', request.tenant!.gymId).select('id,name,email,phone,whatsapp_phone,timezone,currency').single();
  if (error) throw fromSupabaseError(error);
  await writeAuditLog(request, {
    action: 'settings.gym_updated', entityType: 'gym', entityId: data.id, afterData: data,
  });
  response.json({ gym: data });
}

export async function updateLocationSettings(request: Request, response: Response) {
  const locationId = request.params.id;
  if (!locationId) throw new AppError(400, 'INVALID_LOCATION_ID', 'La sucursal no es válida.');
  const input = locationSettingsSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_LOCATION_SETTINGS', 'Los datos de la sucursal no son válidos.', input.error.flatten());
  const { data, error } = await supabaseAdmin.from('gym_locations').update({
    name: input.data.name,
    address: nullable(input.data.address),
    city: input.data.city,
    email: nullable(input.data.email),
    phone: nullable(input.data.phone),
    whatsapp_phone: nullable(input.data.whatsappPhone),
  }).eq('id', locationId).eq('gym_id', request.tenant!.gymId).select('id,name,address,city,email,phone,whatsapp_phone,timezone,is_main,is_active').maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw new AppError(404, 'LOCATION_NOT_FOUND', 'La sucursal no pertenece al gimnasio.');
  await writeAuditLog(request, {
    action: 'settings.location_updated', entityType: 'gym_location', entityId: data.id, afterData: data,
  });
  response.json({ location: data });
}
