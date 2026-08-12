import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { supabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';
import { decideSubscriptionWriteAccess, type GymStatus, type SubscriptionStatus } from '../security/subscriptionPolicy.js';

const readOnlyMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

const subscriptionMessages = {
  SUBSCRIPTION_NOT_CONFIGURED: 'El gimnasio no tiene una suscripción configurada. Activa un plan desde facturación.',
  SUBSCRIPTION_READ_ONLY: 'La suscripción solo permite lectura. Ve a facturación para reactivarla.',
  SUBSCRIPTION_GRACE_EXPIRED: 'El periodo de gracia terminó. Activa el plan para realizar cambios.',
} as const;

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

  const requiresWriteAccess = !readOnlyMethods.has(request.method) && request.baseUrl !== '/api/billing';
  if (requiresWriteAccess) {
    const { data: subscription, error: subscriptionError } = await supabaseAdmin.from('gym_subscriptions')
      .select('status,trial_ends_at,updated_at')
      .eq('gym_id', gymUser.gym_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (subscriptionError) {
      throw new AppError(503, 'SUBSCRIPTION_CHECK_FAILED', 'No se pudo comprobar la suscripción. Intenta nuevamente.');
    }

    const decision = decideSubscriptionWriteAccess({
      gymStatus: gym.status as GymStatus,
      subscription: subscription ? {
        status: subscription.status as SubscriptionStatus,
        trialEndsAt: subscription.trial_ends_at,
        updatedAt: subscription.updated_at,
      } : null,
      nowMs: Date.now(),
      graceDays: env.SUBSCRIPTION_GRACE_DAYS,
    });
    if (!decision.allowed) {
      throw new AppError(402, decision.code, subscriptionMessages[decision.code]);
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
