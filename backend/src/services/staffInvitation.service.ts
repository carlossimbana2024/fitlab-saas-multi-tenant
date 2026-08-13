import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';

type InviteStaffInput = {
  gymId: string;
  invitedBy: string;
  email: string;
  fullName: string;
  phone?: string | null;
  defaultLocationId?: string | null;
};

export async function inviteStaffAccount(input: InviteStaffInput) {
  const normalizedEmail = input.email.trim().toLowerCase();
  const tokenHash = createHash('sha256').update(randomBytes(32)).digest('hex');
  const expiresAt = new Date(Date.now() + env.INVITATION_TTL_HOURS * 3_600_000).toISOString();
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(normalizedEmail, {
    data: { full_name: input.fullName, fitlab_invitation_role: 'staff' },
    redirectTo: `${env.frontendOrigins[0]!}/accept-invite`,
  });
  if (authError || !authData.user) {
    throw new AppError(400, 'STAFF_AUTH_INVITATION_FAILED', authError?.message ?? 'No se pudo invitar al empleado.');
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('register_staff_invitation', {
      target_gym_id: input.gymId,
      target_auth_user_id: authData.user.id,
      target_email: normalizedEmail,
      target_full_name: input.fullName,
      target_phone: input.phone ?? null,
      target_default_location_id: input.defaultLocationId ?? null,
      target_invited_by: input.invitedBy,
      target_token_hash: tokenHash,
      target_expires_at: expiresAt,
    });
    if (error) throw error;
    const created = Array.isArray(data) ? data[0] : undefined;
    if (!created) throw new Error('STAFF_INVITATION_EMPTY_RESULT');
    return {
      id: created.gym_user_id,
      invitationId: created.invitation_id,
      email: normalizedEmail,
      fullName: input.fullName,
      status: 'invited' as const,
    };
  } catch {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    throw new AppError(400, 'STAFF_CREATION_FAILED', 'No se pudo completar la invitacion del empleado.');
  }
}
