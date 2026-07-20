import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';

const elevationSchema = z.object({ permission: z.string().min(3).max(100), pin: z.string().regex(/^\d{4,12}$/) });

export async function createElevation(request: Request, response: Response) {
  const input = elevationSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_ELEVATION_INPUT', 'Permiso o PIN inválido.');
  if (request.tenant!.role !== 'staff') throw new AppError(403, 'STAFF_ONLY', 'La elevación por PIN es solo para personal.');

  const { data, error } = await supabaseAdmin.rpc('create_admin_pin_elevation', {
    target_gym_id: request.tenant!.gymId,
    target_staff_user_id: request.tenant!.gymUserId,
    requested_permission: input.data.permission,
    supplied_pin: input.data.pin,
  });
  if (error) throw new AppError(403, 'PIN_ELEVATION_FAILED', error.message);
  const elevation = Array.isArray(data) ? data[0] : undefined;
  if (!elevation) throw new AppError(403, 'INVALID_ADMIN_PIN', 'El PIN administrativo no es válido.');
  response.json({ token: elevation.elevation_token, expiresAt: elevation.elevation_expires_at });
}
