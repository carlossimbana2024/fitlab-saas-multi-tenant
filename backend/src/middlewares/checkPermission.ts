import type { RequestHandler } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export function checkPermission(permissionKey: string): RequestHandler {
  return asyncHandler(async (request, _response, next) => {
    const tenant = request.tenant!;
    if (tenant.role === 'owner') return next();
    if (tenant.role !== 'staff') throw new AppError(403, 'PERMISSION_DENIED', 'No tienes permiso para esta operación.');

    const { data, error } = await request.supabase!
      .from('staff_permissions').select('access_mode')
      .eq('staff_user_id', tenant.gymUserId).eq('permission_key', permissionKey).maybeSingle();
    if (error) throw new AppError(500, 'PERMISSION_LOOKUP_FAILED', 'No se pudo comprobar el permiso.');
    if (data?.access_mode === 'allowed') return next();
    if (data?.access_mode !== 'requires_pin') throw new AppError(403, 'PERMISSION_DENIED', 'No tienes permiso para esta operación.');

    const token = request.header('x-admin-elevation-token');
    if (!token) throw new AppError(403, 'REQUIRES_ADMIN_PIN', 'Esta operación requiere autorización del administrador.');

    const { data: consumed, error: consumeError } = await supabaseAdmin.rpc('consume_admin_pin_elevation', {
      target_gym_id: tenant.gymId,
      target_staff_user_id: tenant.gymUserId,
      requested_permission: permissionKey,
      supplied_token: token,
    });
    if (consumeError || consumed !== true) throw new AppError(403, 'INVALID_ADMIN_ELEVATION', 'La autorización temporal es inválida o expiró.');
    next();
  });
}
