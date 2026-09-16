import type { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import {
  createReceiptLogoPath, GYM_RECEIPT_BRANDING_BUCKET, isReceiptLogoPath,
  publicReceiptLogoUrl, receiptLogoExtension,
} from '../services/gymBranding.service.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import {
  gymSettingsSchema, locationSettingsSchema, receiptBrandingSchema, receiptBrandingUploadSchema,
} from '../validators/settings.validator.js';

export async function getSettings(request: Request, response: Response) {
  const [gym, locations] = await Promise.all([
    request.supabase!.from('gyms').select('id,name,legal_name,email,phone,whatsapp_phone,logo_url,timezone,currency').eq('id', request.tenant!.gymId).single(),
    request.supabase!.from('gym_locations').select('id,name,address,city,email,phone,whatsapp_phone,timezone,is_main,is_active').order('is_main', { ascending: false }).order('name'),
  ]);
  const error = gym.error ?? locations.error;
  if (error) throw fromSupabaseError(error);
  response.json({ gym: gym.data, locations: locations.data ?? [] });
}

export async function updateReceiptBranding(request: Request, response: Response) {
  const input = receiptBrandingSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_RECEIPT_BRANDING', 'El logotipo seleccionado no es válido.', input.error.flatten());
  let logoUrl: string | null;
  if ('path' in input.data) {
    const path = input.data.path;
    if (!isReceiptLogoPath(path, request.tenant!.gymId)) {
      throw new AppError(400, 'INVALID_RECEIPT_LOGO_PATH', 'El logotipo no pertenece a este gimnasio.');
    }
    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from(GYM_RECEIPT_BRANDING_BUCKET).createSignedUrl(path, 60);
    if (signedError || !signed?.signedUrl) {
      throw new AppError(400, 'RECEIPT_LOGO_NOT_FOUND', 'No se encontró el logotipo cargado.');
    }
    logoUrl = publicReceiptLogoUrl(path);
  } else {
    logoUrl = input.data.logoUrl || null;
  }
  const { data, error } = await supabaseAdmin.rpc('update_gym_receipt_branding_backend', {
    target_gym_id: request.tenant!.gymId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_logo_url: logoUrl,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  const gym = Array.isArray(data) ? data[0] : undefined;
  if (!gym) throw new AppError(500, 'RECEIPT_BRANDING_EMPTY_RESULT', 'No se pudo guardar la marca del recibo.');
  response.json({ gym });
}

export async function createReceiptBrandingUpload(request: Request, response: Response) {
  const input = receiptBrandingUploadSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_RECEIPT_LOGO_UPLOAD', 'El tipo de imagen no es válido.');
  receiptLogoExtension(input.data.contentType);
  const path = createReceiptLogoPath(request.tenant!.gymId, input.data.contentType);
  const { data, error } = await supabaseAdmin.storage
    .from(GYM_RECEIPT_BRANDING_BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error || !data) throw new AppError(503, 'RECEIPT_LOGO_UPLOAD_URL_FAILED', 'No se pudo preparar la carga del logotipo.');
  response.json({ upload: { ...data, bucket: GYM_RECEIPT_BRANDING_BUCKET, contentType: input.data.contentType } });
}

export async function updateGymSettings(request: Request, response: Response) {
  const input = gymSettingsSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_GYM_SETTINGS', 'Los datos del gimnasio no son válidos.', input.error.flatten());
  const { data, error } = await supabaseAdmin.rpc('update_gym_settings_backend', {
    target_gym_id: request.tenant!.gymId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_name: input.data.name,
    supplied_email: input.data.email || null,
    supplied_phone: input.data.phone || null,
    supplied_whatsapp_phone: input.data.whatsappPhone || null,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  const gym = Array.isArray(data) ? data[0] : undefined;
  if (!gym) throw new AppError(500, 'GYM_SETTINGS_EMPTY_RESULT', 'No se pudieron guardar los datos del gimnasio.');
  response.json({ gym });
}

export async function updateLocationSettings(request: Request, response: Response) {
  const locationId = request.params.id;
  if (!locationId) throw new AppError(400, 'INVALID_LOCATION_ID', 'La sucursal no es válida.');
  const input = locationSettingsSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_LOCATION_SETTINGS', 'Los datos de la sucursal no son válidos.', input.error.flatten());
  const { data, error } = await supabaseAdmin.rpc('update_location_settings_backend', {
    target_gym_id: request.tenant!.gymId,
    target_location_id: locationId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_name: input.data.name,
    supplied_address: input.data.address || null,
    supplied_city: input.data.city,
    supplied_email: input.data.email || null,
    supplied_phone: input.data.phone || null,
    supplied_whatsapp_phone: input.data.whatsappPhone || null,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  const location = Array.isArray(data) ? data[0] : undefined;
  if (!location) throw new AppError(404, 'LOCATION_NOT_FOUND', 'La sucursal no pertenece al gimnasio.');
  response.json({ location });
}
