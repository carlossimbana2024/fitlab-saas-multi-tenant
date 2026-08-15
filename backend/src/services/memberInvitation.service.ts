import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';

type InviteInput = { gymId: string; invitedBy: string; email: string; fullName: string; phone?: string | null; defaultLocationId?: string | null };
type ConvertInput = { gymId: string; memberUserId: string; convertedBy: string; email: string; usedPinElevation: boolean };

export async function inviteMember(input: InviteInput) {
  const invitationSecret = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(invitationSecret).digest('hex');
  const expiresAt = new Date(Date.now() + env.INVITATION_TTL_HOURS * 3_600_000).toISOString();
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(input.email, {
    data: { full_name: input.fullName },
    redirectTo: `${env.frontendOrigins[0]!}/accept-invite`,
  });
  if (authError || !authData.user) throw new AppError(400, 'AUTH_INVITATION_FAILED', authError?.message ?? 'No se pudo invitar al usuario.');

  const userId = authData.user.id;
  try {
    const { data, error } = await supabaseAdmin.rpc('register_member_invitation', {
      target_gym_id: input.gymId,
      target_auth_user_id: userId,
      target_email: input.email,
      target_full_name: input.fullName,
      target_phone: input.phone ?? null,
      target_default_location_id: input.defaultLocationId ?? null,
      target_invited_by: input.invitedBy,
      target_token_hash: tokenHash,
      target_expires_at: expiresAt,
    });
    if (error) throw error;
    const created = Array.isArray(data) ? data[0] : undefined;
    if (!created) throw new Error('INVITATION_EMPTY_RESULT');
    return {
      id: created.gym_user_id,
      gym_id: input.gymId,
      profile_id: userId,
      role: 'member' as const,
      status: 'invited' as const,
      account_mode: 'portal' as const,
      invitation_id: created.invitation_id,
      default_location_id: input.defaultLocationId ?? null,
    };
  } catch (error) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new AppError(400, 'MEMBER_CREATION_FAILED', 'No se pudo completar la creación del miembro.');
  }
}

export async function convertManagedMemberToPortal(input: ConvertInput) {
  const { data: member, error: memberError } = await supabaseAdmin.from('gym_users')
    .select('id,managed_full_name,managed_phone')
    .eq('id', input.memberUserId)
    .eq('gym_id', input.gymId)
    .eq('role', 'member')
    .eq('account_mode', 'managed')
    .eq('status', 'active')
    .maybeSingle();
  if (memberError || !member?.managed_full_name) {
    throw new AppError(404, 'ACTIVE_MANAGED_MEMBER_NOT_FOUND', 'El miembro sin cuenta no existe o no está activo.');
  }

  const invitationSecret = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(invitationSecret).digest('hex');
  const expiresAt = new Date(Date.now() + env.INVITATION_TTL_HOURS * 3_600_000).toISOString();
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(input.email, {
    data: { full_name: member.managed_full_name },
    redirectTo: `${env.frontendOrigins[0]!}/accept-invite`,
  });
  if (authError || !authData.user) {
    throw new AppError(400, 'AUTH_INVITATION_FAILED', authError?.message ?? 'No se pudo enviar la invitación.');
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('convert_managed_member_to_portal_backend', {
      target_gym_id: input.gymId,
      target_member_user_id: input.memberUserId,
      target_auth_user_id: authData.user.id,
      target_email: input.email,
      target_converted_by: input.convertedBy,
      target_token_hash: tokenHash,
      target_expires_at: expiresAt,
      supplied_used_pin_elevation: input.usedPinElevation,
    });
    if (error) throw error;
    const converted = Array.isArray(data) ? data[0] : undefined;
    if (!converted) throw new Error('CONVERSION_EMPTY_RESULT');
    return converted;
  } catch {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    throw new AppError(400, 'MEMBER_CONVERSION_FAILED', 'No se pudo convertir el miembro a una cuenta con portal.');
  }
}
