import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export function checkAnyPermission(permissionKeys: string[]): RequestHandler {
  return asyncHandler(async (request, _response, next) => {
    const tenant = request.tenant!;
    if (tenant.role === 'owner') return next();
    if (tenant.role !== 'staff') throw new AppError(403, 'PERMISSION_DENIED', 'No tienes permiso para esta operación.');
    const { data, error } = await request.supabase!
      .from('staff_permissions').select('permission_key,access_mode')
      .eq('gym_id', tenant.gymId).eq('staff_user_id', tenant.gymUserId).in('permission_key', permissionKeys);
    if (error) throw new AppError(500, 'PERMISSION_LOOKUP_FAILED', 'No se pudo comprobar el permiso.');
    if (!(data ?? []).some((permission) => permission.access_mode !== 'denied')) {
      throw new AppError(403, 'PERMISSION_DENIED', 'No tienes permiso para esta operación.');
    }
    next();
  });
}

