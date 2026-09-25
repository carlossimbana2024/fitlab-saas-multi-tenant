import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { writeAuditLog } from '../services/audit.service.js';
import { fromSupabaseError } from '../utils/supabaseError.js';

const publishSchema = z.object({
  body: z.string().trim().min(1).max(3000),
  locationId: z.string().uuid().nullable(),
}).strict();

export async function listAnnouncements(request: Request, response: Response) {
  const tenant = request.tenant!;
  if (tenant.role !== 'owner' && tenant.role !== 'member') throw new AppError(403, 'ANNOUNCEMENTS_ACCESS_DENIED', 'No tienes acceso a los avisos.');
  let query = supabaseAdmin.from('gym_announcements')
    .select('id,location_id,body,created_at')
    .eq('gym_id', tenant.gymId)
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .limit(50);
  if (tenant.role === 'member') {
    query = tenant.defaultLocationId
      ? query.or(`location_id.is.null,location_id.eq.${tenant.defaultLocationId}`)
      : query.is('location_id', null);
  }
  const [announcements, locations] = await Promise.all([
    query,
    tenant.role === 'owner'
      ? supabaseAdmin.from('gym_locations').select('id,name').eq('gym_id', tenant.gymId).eq('is_active', true).order('name')
      : Promise.resolve({ data: [], error: null }),
  ]);
  const error = announcements.error ?? locations.error;
  if (error) throw fromSupabaseError(error);
  response.json({ announcements: announcements.data ?? [], locations: locations.data ?? [] });
}

export async function publishAnnouncement(request: Request, response: Response) {
  if (request.tenant?.role !== 'owner') throw new AppError(403, 'OWNER_REQUIRED', 'Solo el owner puede publicar avisos.');
  const input = publishSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_ANNOUNCEMENT', 'Escribe un aviso de hasta 3000 caracteres y selecciona una sucursal válida.');
  const tenant = request.tenant!;
  if (input.data.locationId) {
    const { data: location, error } = await supabaseAdmin.from('gym_locations').select('id')
      .eq('id', input.data.locationId).eq('gym_id', tenant.gymId).eq('is_active', true).maybeSingle();
    if (error) throw fromSupabaseError(error);
    if (!location) throw new AppError(404, 'ANNOUNCEMENT_LOCATION_NOT_FOUND', 'La sucursal no está activa en tu gimnasio.');
  }
  const { data, error } = await supabaseAdmin.from('gym_announcements').insert({
    gym_id: tenant.gymId,
    location_id: input.data.locationId,
    body: input.data.body,
    created_by: tenant.gymUserId,
  }).select('id,location_id,body,created_at').single();
  if (error) throw fromSupabaseError(error);
  await writeAuditLog(request, { action: 'announcement.published', entityType: 'gym_announcement', entityId: data.id, afterData: data });
  response.status(201).json({ announcement: data });
}

export async function archiveAnnouncement(request: Request, response: Response) {
  if (request.tenant?.role !== 'owner') throw new AppError(403, 'OWNER_REQUIRED', 'Solo el owner puede retirar avisos.');
  const id = z.string().uuid().safeParse(request.params.id);
  if (!id.success) throw new AppError(400, 'INVALID_ANNOUNCEMENT_ID', 'El aviso no es válido.');
  const tenant = request.tenant!;
  const { data, error } = await supabaseAdmin.from('gym_announcements').update({
    status: 'archived', archived_by: tenant.gymUserId, archived_at: new Date().toISOString(),
  }).eq('id', id.data).eq('gym_id', tenant.gymId).eq('status', 'published')
    .select('id,location_id,body,created_at').maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw new AppError(404, 'ANNOUNCEMENT_NOT_FOUND', 'El aviso ya no está publicado.');
  await writeAuditLog(request, { action: 'announcement.archived', entityType: 'gym_announcement', entityId: data.id, beforeData: data });
  response.json({ archived: true });
}
