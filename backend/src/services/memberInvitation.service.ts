import { env } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';

type InviteInput = { gymId: string; invitedBy: string; email: string; fullName: string; phone?: string | null; defaultLocationId?: string | null };

export async function inviteMember(input: InviteInput) {
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(input.email, {
    data: { full_name: input.fullName },
    redirectTo: `${env.frontendOrigins[0]!}/accept-invite`,
  });
  if (authError || !authData.user) throw new AppError(400, 'AUTH_INVITATION_FAILED', authError?.message ?? 'No se pudo invitar al usuario.');

  const userId = authData.user.id;
  try {
    const { error: profileError } = await supabaseAdmin.from('profiles').insert({
      id: userId, full_name: input.fullName, phone: input.phone ?? null,
    });
    if (profileError) throw profileError;

    const { data: gymUser, error: gymUserError } = await supabaseAdmin.from('gym_users').insert({
      gym_id: input.gymId, profile_id: userId, role: 'member', status: 'invited',
      default_location_id: input.defaultLocationId ?? null,
    }).select('id,gym_id,profile_id,role,status,default_location_id').single();
    if (gymUserError) throw gymUserError;
    return gymUser;
  } catch (error) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new AppError(400, 'MEMBER_CREATION_FAILED', 'No se pudo completar la creación del miembro.');
  }
}
