import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { inviteStaffAccount } from '../services/staffInvitation.service.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { inviteStaffSchema, updateStaffPermissionsSchema, updateStaffStatusSchema } from '../validators/staff.validator.js';

const staffFields = 'id,gym_id,status,default_location_id,joined_at,created_at,invitation_id,profiles(full_name,phone,avatar_url),permissions:staff_permissions!staff_permissions_staff_user_id_fkey(permission_key,access_mode),invitation:gym_invitations!gym_users_invitation_id_fkey(email,status,expires_at)';

export async function listStaff(request: Request, response: Response) {
  const [staffResult, catalogResult, locationsResult] = await Promise.all([
    supabaseAdmin.from('gym_users').select(staffFields)
      .eq('gym_id', request.tenant!.gymId).eq('role', 'staff')
      .in('status', ['invited', 'active', 'suspended', 'inactive'])
      .order('created_at', { ascending: false }),
    supabaseAdmin.from('permission_catalog')
      .select('key,name,description,supports_pin_elevation,is_sensitive')
      .neq('key', 'staff.manage').order('key'),
    supabaseAdmin.from('gym_locations').select('id,name,is_main')
      .eq('gym_id', request.tenant!.gymId).eq('is_active', true)
      .order('is_main', { ascending: false }).order('name'),
  ]);
  const error = staffResult.error ?? catalogResult.error ?? locationsResult.error;
  if (error) throw fromSupabaseError(error);
  const staffAccounts = staffResult.data ?? [];
  response.json({
    staff: staffAccounts.filter((staff) => staff.status !== 'inactive'),
    removedStaff: staffAccounts.filter((staff) => staff.status === 'inactive' && staff.joined_at),
    permissionCatalog: catalogResult.data ?? [],
    locations: locationsResult.data ?? [],
  });
}

export async function inviteStaff(request: Request, response: Response) {
  const input = inviteStaffSchema.safeParse(request.body);
  if (!input.success) {
    throw new AppError(400, 'INVALID_STAFF_INPUT', 'Revisa los datos del empleado.', input.error.flatten());
  }
  const staff = await inviteStaffAccount({
    gymId: request.tenant!.gymId,
    invitedBy: request.tenant!.gymUserId,
    email: input.data.email,
    fullName: input.data.fullName,
    phone: input.data.phone ?? null,
    defaultLocationId: input.data.defaultLocationId ?? null,
  });
  response.status(201).json({ staff });
}

export async function updateStaffPermissions(request: Request, response: Response) {
  const staffUserId = request.params.id;
  const input = updateStaffPermissionsSchema.safeParse(request.body);
  if (!staffUserId || !z.string().uuid().safeParse(staffUserId).success || !input.success) {
    throw new AppError(400, 'INVALID_STAFF_PERMISSIONS', 'La matriz de permisos no es valida.', input.success ? undefined : input.error.flatten());
  }
  const { error } = await supabaseAdmin.rpc('update_staff_permissions_backend', {
    target_gym_id: request.tenant!.gymId,
    target_staff_user_id: staffUserId,
    target_updated_by: request.tenant!.gymUserId,
    target_permissions: input.data.permissions,
  });
  if (error) throw fromSupabaseError(error);
  response.status(204).send();
}

export async function updateStaffStatus(request: Request, response: Response) {
  const staffUserId = request.params.id;
  const input = updateStaffStatusSchema.safeParse(request.body);
  if (!staffUserId || !z.string().uuid().safeParse(staffUserId).success || !input.success) {
    throw new AppError(400, 'INVALID_STAFF_STATUS', 'El estado del empleado no es valido.');
  }
  const { data, error } = await supabaseAdmin.rpc('update_staff_status_backend', {
    target_gym_id: request.tenant!.gymId,
    target_staff_user_id: staffUserId,
    target_updated_by: request.tenant!.gymUserId,
    target_status: input.data.status,
  });
  if (error) throw fromSupabaseError(error);
  const staff = Array.isArray(data) ? data[0] : undefined;
  if (!staff) throw new AppError(404, 'STAFF_NOT_FOUND', 'El empleado no existe.');
  response.json({ staff });
}

export async function revokeStaffInvitation(request: Request, response: Response) {
  const invitationId = request.params.id;
  if (!invitationId || !z.string().uuid().safeParse(invitationId).success) {
    throw new AppError(400, 'INVALID_INVITATION_ID', 'La invitacion no es valida.');
  }
  const { data, error } = await supabaseAdmin.rpc('revoke_staff_invitation', {
    target_gym_id: request.tenant!.gymId,
    target_invitation_id: invitationId,
    target_revoked_by: request.tenant!.gymUserId,
  });
  if (error) throw fromSupabaseError(error);
  const revoked = Array.isArray(data) ? data[0] : undefined;
  if (!revoked) throw new AppError(404, 'INVITATION_NOT_FOUND', 'La invitacion no existe o ya no esta pendiente.');
  if (revoked.auth_user_id) {
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(revoked.auth_user_id);
    if (deleteError) console.error('REVOKED_STAFF_AUTH_USER_DELETE_FAILED', deleteError.message);
  }
  response.status(204).send();
}

export async function removeStaff(request: Request, response: Response) {
  const staffUserId = request.params.id;
  if (!staffUserId || !z.string().uuid().safeParse(staffUserId).success) {
    throw new AppError(400, 'INVALID_STAFF_ID', 'El empleado no es valido.');
  }
  const { data, error } = await supabaseAdmin.rpc('remove_staff_backend', {
    target_gym_id: request.tenant!.gymId,
    target_staff_user_id: staffUserId,
    target_removed_by: request.tenant!.gymUserId,
  });
  if (error) throw fromSupabaseError(error);
  const removed = Array.isArray(data) ? data[0] : undefined;
  if (!removed) throw new AppError(404, 'STAFF_NOT_FOUND', 'El empleado no existe o ya fue eliminado.');
  response.status(204).send();
}

export async function reinstateStaff(request: Request, response: Response) {
  const staffUserId = request.params.id;
  if (!staffUserId || !z.string().uuid().safeParse(staffUserId).success) {
    throw new AppError(400, 'INVALID_STAFF_ID', 'El empleado no es valido.');
  }
  const { data, error } = await supabaseAdmin.rpc('reinstate_staff_backend', {
    target_gym_id: request.tenant!.gymId,
    target_staff_user_id: staffUserId,
    target_reinstated_by: request.tenant!.gymUserId,
  });
  if (error) throw fromSupabaseError(error);
  const reinstated = Array.isArray(data) ? data[0] : undefined;
  if (!reinstated) throw new AppError(404, 'REMOVED_STAFF_NOT_FOUND', 'El empleado retirado no existe.');
  response.json({ staff: reinstated });
}
