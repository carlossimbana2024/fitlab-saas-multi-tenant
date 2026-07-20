import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { supabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';

export const tenantContext: RequestHandler = asyncHandler(async (request, _response, next) => {
  const client = request.supabase!;
  const { data: gymUser, error: gymUserError } = await client
    .from('gym_users')
    .select('id,gym_id,role,status,default_location_id')
    .eq('profile_id', request.authUser!.id)
    .single();

  if (gymUserError || !gymUser) throw new AppError(403, 'GYM_ACCESS_NOT_FOUND', 'El usuario no pertenece a un gimnasio.');
  if (gymUser.status !== 'active') throw new AppError(403, 'GYM_ACCESS_INACTIVE', 'El acceso al gimnasio no está activo.');

  const { data: gym, error: gymError } = await client.from('gyms').select('timezone,status').eq('id', gymUser.gym_id).single();
  if (gymError || !gym) throw new AppError(403, 'GYM_NOT_AVAILABLE', 'El gimnasio no está disponible.');

  if (gym.status === 'trial' && request.method !== 'GET' && request.baseUrl !== '/api/billing') {
    const { data: subscription } = await supabaseAdmin.from('gym_subscriptions')
      .select('trial_ends_at').eq('gym_id', gymUser.gym_id).eq('status', 'trialing').maybeSingle();
    const trialEnd = subscription?.trial_ends_at ? new Date(subscription.trial_ends_at).getTime() : 0;
    const graceEnd = trialEnd + env.SUBSCRIPTION_GRACE_DAYS * 86_400_000;
    if (trialEnd > 0 && Date.now() > graceEnd) {
      throw new AppError(402, 'GYM_SUBSCRIPTION_REQUIRED', 'La prueba y el periodo de gracia terminaron. Activa el plan para realizar cambios.');
    }
  }

  request.tenant = {
    gymUserId: gymUser.id,
    gymId: gymUser.gym_id,
    role: gymUser.role,
    status: gymUser.status,
    defaultLocationId: gymUser.default_location_id,
    timezone: gym.timezone,
  };
  next();
});
