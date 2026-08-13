import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { createUserSupabaseClient, supabaseAdmin, supabasePublic } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { stripe } from '../config/stripe.js';
import { isValidTimeZone } from '../utils/timezone.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1).optional() });
const acceptInviteSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  password: z.string().min(8).max(128),
});
const requestPasswordResetSchema = z.object({ email: z.string().email() });
const resetPasswordSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  password: z.string().min(8).max(128),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128),
}).refine((value) => value.currentPassword !== value.newPassword, {
  path: ['newPassword'],
  message: 'La nueva contraseña debe ser diferente de la actual.',
});
const registerOwnerSchema = z.object({
  fullName: z.string().trim().min(2).max(150),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  acceptsTerms: z.literal(true),
  acceptsPrivacy: z.literal(true),
});
const ownerOnboardingSchema = z.object({
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  gymName: z.string().trim().min(2).max(150),
  locationName: z.string().trim().min(2).max(150),
  address: z.string().trim().max(250).default(''),
  city: z.string().trim().min(2).max(120).default('Quito'),
  timezone: z.string().default('America/Guayaquil').refine(isValidTimeZone, 'La zona horaria no es válida.'),
});

const cookieBase = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: env.NODE_ENV === 'production' ? ('none' as const) : ('lax' as const),
  signed: true,
  path: '/',
};

export async function login(request: Request, response: Response) {
  const credentials = loginSchema.safeParse(request.body);
  if (!credentials.success) {
    throw new AppError(400, 'INVALID_LOGIN_INPUT', 'Correo o contraseña inválidos.');
  }

  const { data, error } = await supabasePublic.auth.signInWithPassword(credentials.data);
  if (error || !data.session) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.');
  }

  response.cookie('fitlab_access_token', data.session.access_token, {
    ...cookieBase,
    maxAge: data.session.expires_in * 1000,
  });
  response.cookie('fitlab_refresh_token', data.session.refresh_token, {
    ...cookieBase,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  response.status(200).json({ user: { id: data.user.id, email: data.user.email } });
}

export async function registerOwner(request: Request, response: Response) {
  const input = registerOwnerSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_OWNER_REGISTRATION', 'Revisa los datos del registro.', input.error.flatten());

  const redirectTo = `${env.frontendOrigins[0]}/owner/confirm`;
  const { data, error } = await supabasePublic.auth.signUp({
    email: input.data.email.toLowerCase(),
    password: input.data.password,
    options: {
      emailRedirectTo: redirectTo,
      data: {
        full_name: input.data.fullName,
      },
    },
  });
  if (error) throw new AppError(400, 'OWNER_REGISTRATION_FAILED', error.message);
  if (data.user && (data.user.identities?.length ?? 0) > 0) {
    const { error: metadataError } = await supabaseAdmin.auth.admin.updateUserById(data.user.id, {
      app_metadata: {
        ...data.user.app_metadata,
        fitlab_registration: 'owner',
        legal_version: '2026-07-20',
        terms_accepted_at: new Date().toISOString(),
        privacy_accepted_at: new Date().toISOString(),
      },
    });
    if (metadataError) throw new AppError(500, 'OWNER_REGISTRATION_METADATA_FAILED', 'No se pudo preparar el registro del gimnasio.');
  }

  response.status(202).json({
    message: 'Revisa tu correo para verificar la cuenta y continuar con la configuración.',
    requiresEmailVerification: !data.session,
  });
}

function slugify(value: string) {
  const base = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'gimnasio';
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

export async function completeOwnerOnboarding(request: Request, response: Response) {
  const input = ownerOnboardingSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_OWNER_ONBOARDING', 'Revisa los datos del gimnasio.', input.error.flatten());

  const accessToken = input.data.accessToken ?? request.signedCookies?.fitlab_access_token;
  const refreshToken = input.data.refreshToken ?? request.signedCookies?.fitlab_refresh_token;
  if (!accessToken) throw new AppError(401, 'OWNER_SESSION_REQUIRED', 'Inicia sesión con tu cuenta verificada para continuar.');
  const client = createUserSupabaseClient(accessToken);
  if (refreshToken) {
    const { error: sessionError } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (sessionError) throw new AppError(401, 'INVALID_OWNER_VERIFICATION_SESSION', 'El enlace de verificación es inválido o expiró.');
  }

  const { data: userData, error: userError } = await client.auth.getUser(accessToken);
  const user = userData.user;
  if (userError || !user || !user.email || !user.email_confirmed_at) {
    throw new AppError(401, 'OWNER_EMAIL_NOT_VERIFIED', 'Primero debes verificar tu correo.');
  }
  if (user.app_metadata?.fitlab_registration !== 'owner') {
    throw new AppError(403, 'OWNER_REGISTRATION_REQUIRED', 'Esta cuenta no inició un registro de gimnasio.');
  }

  const price = await stripe.prices.retrieve(env.STRIPE_PRICE_ID, { expand: ['product'] });
  if (!price.active || price.type !== 'recurring' || price.recurring?.interval !== 'month' || price.unit_amount == null) {
    throw new AppError(500, 'INVALID_STRIPE_PRICE', 'El precio de Stripe debe ser mensual, recurrente y estar activo.');
  }
  const productName = typeof price.product === 'string' || !('name' in price.product)
    ? 'FitLab Inicial'
    : price.product.name;

  const { data, error } = await supabaseAdmin.rpc('complete_owner_onboarding', {
    target_profile_id: user.id,
    target_email: user.email,
    target_full_name: String(user.user_metadata?.full_name ?? user.email.split('@')[0]),
    target_gym_name: input.data.gymName,
    target_gym_slug: slugify(input.data.gymName),
    target_location_name: input.data.locationName,
    target_location_address: input.data.address,
    target_city: input.data.city,
    target_timezone: input.data.timezone,
    target_plan_name: productName,
    target_plan_price: price.unit_amount / 100,
    target_plan_currency: price.currency.toUpperCase(),
    target_stripe_price_id: price.id,
    target_trial_days: env.TRIAL_DAYS,
    target_legal_version: String(user.app_metadata?.legal_version ?? '2026-07-20'),
  });
  if (error) throw new AppError(400, 'OWNER_ONBOARDING_FAILED', error.message);

  response.cookie('fitlab_access_token', accessToken, { ...cookieBase, maxAge: 60 * 60 * 1000 });
  if (refreshToken) response.cookie('fitlab_refresh_token', refreshToken, { ...cookieBase, maxAge: 30 * 24 * 60 * 60 * 1000 });
  response.status(201).json({ onboarding: Array.isArray(data) ? data[0] : data });
}

export async function me(request: Request, response: Response) {
  const { data, error } = await request.supabase!
    .from('gym_users')
    .select('id,gym_id,role,status,default_location_id,profiles(full_name,phone,avatar_url),staff_permissions(permission_key,access_mode)')
    .eq('profile_id', request.authUser!.id)
    .single();

  if (error && error.code !== 'PGRST116') throw new AppError(403, 'MEMBERSHIP_NOT_AVAILABLE', error.message);
  if (!data) {
    const canOnboard = request.authUser!.email_confirmed_at
      && request.authUser!.app_metadata?.fitlab_registration === 'owner';
    if (!canOnboard) throw new AppError(403, 'MEMBERSHIP_NOT_AVAILABLE', 'La cuenta no pertenece a un gimnasio.');
    response.json({ user: request.authUser, gymUser: null, onboardingRequired: true });
    return;
  }
  response.json({ user: request.authUser, gymUser: data, onboardingRequired: false });
}

export async function refresh(request: Request, response: Response) {
  const parsed = refreshSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new AppError(400, 'INVALID_REFRESH_INPUT', 'La solicitud de renovación no es válida.');
  const input = parsed.data;
  const refreshToken = request.signedCookies?.fitlab_refresh_token ?? input.refreshToken;
  if (!refreshToken) throw new AppError(401, 'REFRESH_TOKEN_REQUIRED', 'No existe una sesión renovable.');

  const { data, error } = await supabasePublic.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'La sesión no puede renovarse.');

  response.cookie('fitlab_access_token', data.session.access_token, { ...cookieBase, maxAge: data.session.expires_in * 1000 });
  response.cookie('fitlab_refresh_token', data.session.refresh_token, { ...cookieBase, maxAge: 30 * 24 * 60 * 60 * 1000 });
  response.json({ user: { id: data.user?.id, email: data.user?.email } });
}

export async function logout(request: Request, response: Response) {
  const bearer = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : undefined;
  const accessToken = request.signedCookies?.fitlab_access_token ?? bearer;
  if (accessToken) {
    const { error } = await supabaseAdmin.auth.admin.signOut(accessToken, 'local');
    if (error && ![401, 403, 404].includes(error.status ?? 0)) {
      console.error('SUPABASE_SESSION_REVOCATION_FAILED', error.message);
    }
  }
  response.clearCookie('fitlab_access_token', cookieBase);
  response.clearCookie('fitlab_refresh_token', cookieBase);
  response.status(204).send();
}

export async function changePassword(request: Request, response: Response) {
  const input = changePasswordSchema.safeParse(request.body);
  if (!input.success) {
    throw new AppError(400, 'INVALID_PASSWORD_CHANGE_INPUT', 'Revisa las contraseñas ingresadas.', input.error.flatten());
  }

  const email = request.authUser?.email;
  if (!email) throw new AppError(400, 'ACCOUNT_EMAIL_REQUIRED', 'La cuenta no tiene un correo válido.');

  const { error: verificationError } = await supabasePublic.auth.signInWithPassword({
    email,
    password: input.data.currentPassword,
  });
  if (verificationError) {
    throw new AppError(401, 'CURRENT_PASSWORD_INVALID', 'La contraseña actual no es correcta.');
  }

  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(request.authUser!.id, {
    password: input.data.newPassword,
  });
  if (updateError) throw new AppError(400, 'PASSWORD_UPDATE_FAILED', 'No se pudo actualizar la contraseña.');

  response.json({ message: 'Contraseña actualizada correctamente.' });
}

export async function acceptInvite(request: Request, response: Response) {
  const input = acceptInviteSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_INVITATION_INPUT', 'El enlace o la contraseña no son válidos.');
  const client = createUserSupabaseClient(input.data.accessToken);
  const { data: userData, error: userError } = await client.auth.getUser(input.data.accessToken);
  if (userError || !userData.user) throw new AppError(401, 'INVALID_INVITATION_TOKEN', 'La invitación es inválida o expiró.');
  const { data: pendingAccount, error: pendingAccountError } = await supabaseAdmin.from('gym_users')
    .select('id,invitation_id,role').eq('profile_id', userData.user.id).in('role', ['member', 'staff']).eq('status', 'invited').maybeSingle();
  if (pendingAccountError || !pendingAccount?.invitation_id) {
    throw new AppError(409, 'INVITATION_NOT_PENDING', 'La invitación expiró, fue revocada o ya fue utilizada.');
  }
  const { data: pendingInvitation, error: pendingInvitationError } = await supabaseAdmin.from('gym_invitations')
    .select('id,expires_at,intended_role').eq('id', pendingAccount.invitation_id).eq('auth_user_id', userData.user.id).eq('status', 'pending').maybeSingle();
  if (pendingInvitationError || !pendingInvitation) {
    throw new AppError(409, 'INVITATION_NOT_PENDING', 'La invitación expiró, fue revocada o ya fue utilizada.');
  }
  if (pendingInvitation.intended_role !== pendingAccount.role) {
    throw new AppError(409, 'INVITATION_ROLE_MISMATCH', 'La invitacion no coincide con el acceso asignado.');
  }
  if (new Date(pendingInvitation.expires_at).getTime() <= Date.now()) {
    await supabaseAdmin.rpc('accept_portal_invitation', { target_auth_user_id: userData.user.id });
    throw new AppError(409, 'INVITATION_EXPIRED', 'La invitación expiró. Solicita una nueva invitación al gimnasio.');
  }
  const { error: sessionError } = await client.auth.setSession({
    access_token: input.data.accessToken,
    refresh_token: input.data.refreshToken,
  });
  if (sessionError) throw new AppError(401, 'INVALID_INVITATION_SESSION', 'La invitación es inválida o expiró.');

  const { error: passwordError } = await client.auth.updateUser({ password: input.data.password });
  if (passwordError) throw new AppError(400, 'PASSWORD_UPDATE_FAILED', 'No se pudo establecer la contraseña.');
  const { data: activation, error: activationError } = await supabaseAdmin.rpc('accept_portal_invitation', {
    target_auth_user_id: userData.user.id,
  });
  const activated = Array.isArray(activation) ? activation[0] : undefined;
  if (activationError || !activated) throw new AppError(409, 'INVITATION_NOT_PENDING', 'La invitación expiró, fue revocada o ya fue utilizada.');
  response.cookie('fitlab_access_token', input.data.accessToken, { ...cookieBase, maxAge: 60 * 60 * 1000 });
  response.cookie('fitlab_refresh_token', input.data.refreshToken, { ...cookieBase, maxAge: 30 * 24 * 60 * 60 * 1000 });
  response.json({ user: { id: userData.user.id, email: userData.user.email }, role: activated.account_role });
}

export async function requestPasswordReset(request: Request, response: Response) {
  const input = requestPasswordResetSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_EMAIL', 'Ingresa un correo válido.');

  const redirectTo = `${env.frontendOrigins[0]}/reset-password`;
  // La misma respuesta se devuelve aunque Supabase no encuentre el correo.
  // Así no revelamos qué cuentas están registradas en FitLab.
  await supabasePublic.auth.resetPasswordForEmail(input.data.email, { redirectTo });
  response.status(202).json({
    message: 'Si el correo pertenece a una cuenta, recibirás un enlace para crear una nueva contraseña.',
  });
}

export async function resetPassword(request: Request, response: Response) {
  const input = resetPasswordSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_PASSWORD_RESET_INPUT', 'El enlace o la contraseña no son válidos.');

  const client = createUserSupabaseClient(input.data.accessToken);
  const { data: userData, error: userError } = await client.auth.getUser(input.data.accessToken);
  if (userError || !userData.user) throw new AppError(401, 'INVALID_PASSWORD_RESET_TOKEN', 'El enlace es inválido o expiró.');

  const { error: sessionError } = await client.auth.setSession({
    access_token: input.data.accessToken,
    refresh_token: input.data.refreshToken,
  });
  if (sessionError) throw new AppError(401, 'INVALID_PASSWORD_RESET_SESSION', 'El enlace es inválido o expiró.');

  const { error: passwordError } = await client.auth.updateUser({ password: input.data.password });
  if (passwordError) throw new AppError(400, 'PASSWORD_UPDATE_FAILED', 'No se pudo actualizar la contraseña.');

  response.cookie('fitlab_access_token', input.data.accessToken, { ...cookieBase, maxAge: 60 * 60 * 1000 });
  response.cookie('fitlab_refresh_token', input.data.refreshToken, { ...cookieBase, maxAge: 30 * 24 * 60 * 60 * 1000 });
  response.json({ user: { id: userData.user.id, email: userData.user.email } });
}
