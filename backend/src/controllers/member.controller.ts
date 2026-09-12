import type { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { convertManagedMemberToPortal, inviteMember as inviteMemberAccount } from '../services/memberInvitation.service.js';
import { avatarExtension, createAvatarPath, isInternalAvatarPath, MEMBER_AVATAR_BUCKET, signAvatarUrl } from '../services/memberProfile.service.js';
import { convertManagedMemberSchema, inviteMemberSchema, managedMemberSchema, updateMemberSchema, updateMemberStatusSchema } from '../validators/membership.validator.js';
import { z } from 'zod';
import { dateInTimezone } from '../utils/gymDate.js';

const memberFields = 'id,gym_id,profile_id,role,status,account_mode,invitation_id,default_location_id,joined_at,created_at,managed_full_name,managed_phone,managed_birth_date,managed_guardian_name,managed_guardian_phone,managed_notes,profiles(full_name,phone,avatar_url,preferred_language),invitation:gym_invitations!gym_users_invitation_id_fkey(email,status,expires_at)';
const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(150),
  phone: z.string().trim().max(30).nullable().optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
});

const fitnessGoalTypes = ['lose_weight', 'gain_weight', 'build_muscle', 'improve_fitness', 'maintain_weight', 'general_wellness'] as const;
const fitnessProfileSchema = z.object({
  weightKg: z.coerce.number().min(20).max(500),
  heightCm: z.coerce.number().min(80).max(260),
  goalType: z.enum(fitnessGoalTypes),
  experienceLevel: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
  trainingFrequencyPerWeek: z.coerce.number().int().min(1).max(14).default(3),
  availableDays: z.array(z.coerce.number().int().min(1).max(7)).max(7).default([])
    .refine((values) => new Set(values).size === values.length, 'No repitas días disponibles.'),
  targetWeightKg: z.coerce.number().min(20).max(500).nullable().optional(),
  preferredTrainingType: z.string().trim().min(2).max(80).nullable().optional(),
  goalHorizonMonths: z.coerce.number().int().min(1).max(36).nullable().optional(),
  publicMessage: z.string().trim().min(1).max(160).nullable().optional(),
  showInCommunity: z.boolean().default(false),
  showProfilePhoto: z.boolean().default(false),
  showStreak: z.boolean().default(false),
  showAttendanceCount: z.boolean().default(false),
  showWeightProgress: z.boolean().default(false),
  showGoal: z.boolean().default(false),
});
const avatarUploadSchema = z.object({ contentType: z.string().trim().toLowerCase() });
const avatarFinalizeSchema = z.object({ path: z.string().trim().min(1).max(300) });
const memberWeightSchema = z.object({
  weightKg: z.coerce.number().finite().min(20).max(500),
  measuredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha no es válida.'),
});

const fitnessProfileFields = 'id,gym_id,member_user_id,weight_kg,height_cm,goal_type,experience_level,training_frequency_per_week,available_days,target_weight_kg,preferred_training_type,goal_horizon_months,public_message,show_in_community,show_profile_photo,show_streak,show_attendance_count,show_weight_progress,show_goal,onboarding_completed_at,updated_at';

function memberOnly(request: Request) {
  if (request.tenant?.role !== 'member') throw new AppError(403, 'MEMBER_ONLY_ENDPOINT', 'Esta sección está disponible solo para miembros.');
}

const DAY_MS = 86_400_000;

function utcDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, amount: number) {
  return isoDate(new Date(utcDate(value).getTime() + amount * DAY_MS));
}

function addYears(value: string, amount: number) {
  const date = utcDate(value);
  date.setUTCFullYear(date.getUTCFullYear() + amount);
  return isoDate(date);
}

function mondayOf(value: string) {
  const date = utcDate(value);
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(value, -offset);
}

function monthStart(value: string) {
  const date = utcDate(value);
  return isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
}

function monthKey(value: string) {
  return value.slice(0, 7);
}

function monthLabel(key: string) {
  return new Intl.DateTimeFormat('es-EC', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${key}-01T00:00:00Z`));
}

function weekLabel(start: string) {
  return new Intl.DateTimeFormat('es-EC', { day: '2-digit', month: 'short', timeZone: 'UTC' })
    .format(utcDate(start));
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function computeGoalProgress(goalType: string, initialWeight: number | null, currentWeight: number | null, targetWeight: number | null) {
  if (initialWeight === null || currentWeight === null) return null;
  let progressPercent: number | null = null;
  const targetDirectionIsValid = targetWeight !== null && (
    (goalType === 'lose_weight' && targetWeight < initialWeight)
    || ((goalType === 'gain_weight' || goalType === 'build_muscle') && targetWeight > initialWeight)
  );
  if (targetDirectionIsValid && targetWeight !== null) {
    const denominator = targetWeight - initialWeight;
    if (denominator !== 0) progressPercent = clampPercent(((currentWeight - initialWeight) / denominator) * 100);
  } else if (goalType === 'maintain_weight' && targetWeight !== null) {
    const distance = Math.abs(initialWeight - targetWeight);
    progressPercent = distance === 0 ? 100 : clampPercent((1 - Math.abs(currentWeight - targetWeight) / distance) * 100);
  }
  if (progressPercent === null) return null;
  return { progressPercent, initialWeightKg: initialWeight, currentWeightKg: currentWeight, targetWeightKg: targetWeight, goalType };
}

function motivationForProgress(currentStreak: number, currentMonthAttendances: number, latestAttendanceDate: string | null, today: string) {
  const daysSinceLast = latestAttendanceDate ? Math.max(0, Math.round((utcDate(today).getTime() - utcDate(latestAttendanceDate).getTime()) / DAY_MS)) : null;
  if (currentStreak >= 7) return { tone: 'success', title: '¡Una semana completa!', message: `Llevas una racha de ${currentStreak} días. Tu disciplina está construyendo resultados.` };
  if (currentMonthAttendances >= 8) return { tone: 'success', title: 'Vas con muy buen ritmo', message: `Ya sumas ${currentMonthAttendances} asistencias este mes. Mantén ese impulso.` };
  if (daysSinceLast !== null && daysSinceLast >= 3) return { tone: 'encouragement', title: 'Tu próximo entrenamiento te espera', message: `Han pasado ${daysSinceLast} días desde tu última asistencia. Un día puede reactivar tu constancia.` };
  if (currentStreak >= 3) return { tone: 'success', title: 'La constancia se nota', message: `Llevas ${currentStreak} días seguidos. ¡Sigue así!` };
  return { tone: 'neutral', title: 'Cada entrenamiento cuenta', message: 'Un paso a la vez: registra tu próxima asistencia y sigue acercándote a tu objetivo.' };
}

export async function updateMyProfile(request: Request, response: Response) {
  const input = profileSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_PROFILE_INPUT', 'Los datos del perfil no son válidos.', input.error.flatten());
  const changes: { full_name: string; phone: string | null; avatar_url?: string | null } = {
    full_name: input.data.fullName,
    phone: input.data.phone || null,
  };
  // Las fotos nuevas se finalizan por /me/avatar. Omitir avatarUrl aquí evita
  // que una edición de nombre o teléfono borre una foto ya subida.
  if (Object.prototype.hasOwnProperty.call(input.data, 'avatarUrl')) {
    changes.avatar_url = input.data.avatarUrl || null;
  }
  const { data, error } = await supabaseAdmin.from('profiles').update(changes)
    .eq('id', request.authUser!.id).select('full_name,phone,avatar_url,preferred_language').single();
  if (error) throw fromSupabaseError(error);
  response.json({ profile: { ...data, avatar_url: await signAvatarUrl(data.avatar_url) } });
}

export async function getMyFitnessProfile(request: Request, response: Response) {
  memberOnly(request);
  const { data, error } = await supabaseAdmin.from('member_fitness_profiles')
    .select(fitnessProfileFields)
    .eq('gym_id', request.tenant!.gymId)
    .eq('member_user_id', request.tenant!.gymUserId)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  response.json({ fitnessProfile: data });
}

export async function upsertMyFitnessProfile(request: Request, response: Response) {
  memberOnly(request);
  const input = fitnessProfileSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_FITNESS_PROFILE_INPUT', 'Revisa los datos deportivos ingresados.', input.error.flatten());
  const { data, error } = await supabaseAdmin.rpc('upsert_member_fitness_profile_backend', {
    target_gym_id: request.tenant!.gymId,
    target_member_user_id: request.tenant!.gymUserId,
    supplied_weight_kg: input.data.weightKg,
    supplied_height_cm: input.data.heightCm,
    supplied_goal_type: input.data.goalType,
    supplied_experience_level: input.data.experienceLevel,
    supplied_training_frequency_per_week: input.data.trainingFrequencyPerWeek,
    supplied_available_days: [...input.data.availableDays].sort((a, b) => a - b),
    supplied_target_weight_kg: input.data.targetWeightKg ?? null,
    supplied_preferred_training_type: input.data.preferredTrainingType ?? null,
    supplied_goal_horizon_months: input.data.goalHorizonMonths ?? null,
    supplied_public_message: input.data.publicMessage ?? null,
    supplied_show_in_community: input.data.showInCommunity,
    supplied_show_profile_photo: input.data.showProfilePhoto,
    supplied_show_streak: input.data.showStreak,
    supplied_show_attendance_count: input.data.showAttendanceCount,
    supplied_show_weight_progress: input.data.showWeightProgress,
    supplied_show_goal: input.data.showGoal,
  });
  if (error) throw fromSupabaseError(error);
  const fitnessProfile = Array.isArray(data) ? data[0] : data;
  if (!fitnessProfile) throw new AppError(500, 'FITNESS_PROFILE_EMPTY_RESULT', 'No se pudo guardar el perfil deportivo.');
  response.json({ fitnessProfile });
}

export async function createMyAvatarUpload(request: Request, response: Response) {
  memberOnly(request);
  const input = avatarUploadSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_AVATAR_UPLOAD_INPUT', 'El tipo de imagen no es válido.');
  const contentType = input.data.contentType;
  avatarExtension(contentType);
  const path = createAvatarPath(request.tenant!.gymId, request.authUser!.id, contentType);
  const { data, error } = await supabaseAdmin.storage.from(MEMBER_AVATAR_BUCKET).createSignedUploadUrl(path, { upsert: false });
  if (error || !data) throw new AppError(503, 'AVATAR_UPLOAD_URL_FAILED', 'No se pudo preparar la carga de la foto.');
  response.json({ upload: { ...data, bucket: MEMBER_AVATAR_BUCKET, contentType } });
}

export async function finalizeMyAvatar(request: Request, response: Response) {
  memberOnly(request);
  const input = avatarFinalizeSchema.safeParse(request.body);
  if (!input.success || !isInternalAvatarPath(input.success ? input.data.path : '', request.tenant!.gymId, request.authUser!.id)) {
    throw new AppError(400, 'INVALID_AVATAR_PATH', 'La foto no pertenece a esta cuenta.');
  }
  const path = input.data.path;
  const { data: signedData, error: signedError } = await supabaseAdmin.storage.from(MEMBER_AVATAR_BUCKET).createSignedUrl(path, 60);
  if (signedError || !signedData?.signedUrl) throw new AppError(400, 'AVATAR_NOT_FOUND', 'La foto no se pudo encontrar en el almacenamiento.');
  const { data, error } = await supabaseAdmin.from('profiles').update({ avatar_url: path })
    .eq('id', request.authUser!.id).select('full_name,phone,avatar_url,preferred_language').single();
  if (error) throw fromSupabaseError(error);
  response.json({ profile: { ...data, avatar_url: await signAvatarUrl(data.avatar_url) }, avatarPath: path });
}

export async function getMyProgress(request: Request, response: Response) {
  memberOnly(request);
  const today = dateInTimezone(request.tenant!.timezone);
  const [attendanceResult, streakResult, weightsResult, profileResult] = await Promise.all([
    supabaseAdmin.from('attendances')
      .select('id,attendance_date,checked_in_at,source,status,counts_toward_streak')
      .eq('gym_id', request.tenant!.gymId)
      .eq('member_user_id', request.tenant!.gymUserId)
      .order('attendance_date', { ascending: false })
      .limit(2000),
    supabaseAdmin.from('user_streaks')
      .select('current_streak,longest_streak,last_attendance_date')
      .eq('gym_id', request.tenant!.gymId)
      .eq('member_user_id', request.tenant!.gymUserId)
      .maybeSingle(),
    supabaseAdmin.from('member_weight_entries')
      .select('id,weight_kg,measured_on,source,created_at')
      .eq('gym_id', request.tenant!.gymId)
      .eq('member_user_id', request.tenant!.gymUserId)
      .order('measured_on', { ascending: true })
      .limit(500),
    supabaseAdmin.from('member_fitness_profiles')
      .select('weight_kg,target_weight_kg,goal_type')
      .eq('gym_id', request.tenant!.gymId)
      .eq('member_user_id', request.tenant!.gymUserId)
      .maybeSingle(),
  ]);
  const error = attendanceResult.error ?? streakResult.error ?? weightsResult.error ?? profileResult.error;
  if (error) throw fromSupabaseError(error);

  const validAttendances = (attendanceResult.data ?? []).filter((attendance) => attendance.status === 'valid');
  const currentWeekStart = mondayOf(today);
  const currentMonthStart = monthStart(today);
  const currentWeekAttendances = validAttendances.filter((attendance) => attendance.attendance_date >= currentWeekStart && attendance.attendance_date <= today).length;
  const currentMonthAttendances = validAttendances.filter((attendance) => monthKey(attendance.attendance_date) === monthKey(today)).length;
  const monthBuckets = Array.from({ length: 6 }, (_, index) => {
    const date = utcDate(monthStart(today));
    date.setUTCMonth(date.getUTCMonth() - (5 - index));
    const start = isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
    const key = monthKey(start);
    return { period: key, label: monthLabel(key), count: validAttendances.filter((attendance) => monthKey(attendance.attendance_date) === key).length };
  });
  const weekBuckets = Array.from({ length: 8 }, (_, index) => {
    const start = addDays(currentWeekStart, -((7 - index) * 7));
    const end = addDays(start, 6);
    return { period: start, label: weekLabel(start), count: validAttendances.filter((attendance) => attendance.attendance_date >= start && attendance.attendance_date <= end).length };
  });
  const streak = streakResult.data;
  const latestAttendanceDate = validAttendances[0]?.attendance_date ?? null;
  const weights = (weightsResult.data ?? []).map((entry) => ({
    id: entry.id,
    weightKg: Number(entry.weight_kg),
    measuredOn: entry.measured_on,
    source: entry.source,
    createdAt: entry.created_at,
  }));
  const profile = profileResult.data;
  const initialWeight = weights[0]?.weightKg ?? (profile ? Number(profile.weight_kg) : null);
  const currentWeight = weights.at(-1)?.weightKg ?? initialWeight;
  const targetWeight = profile?.target_weight_kg == null ? null : Number(profile.target_weight_kg);
  const goal = profile ? computeGoalProgress(profile.goal_type, initialWeight, currentWeight, targetWeight) : null;
  const motivation = motivationForProgress(Number(streak?.current_streak ?? 0), currentMonthAttendances, latestAttendanceDate, today);
  response.json({
    progress: {
      today,
      totalAttendances: validAttendances.length,
      currentMonthAttendances,
      currentWeekAttendances,
      averageWeeklyAttendances: Math.round((weekBuckets.reduce((total, bucket) => total + bucket.count, 0) / weekBuckets.length) * 10) / 10,
      attendanceByMonth: monthBuckets,
      attendanceByWeek: weekBuckets,
      currentStreak: Number(streak?.current_streak ?? 0),
      longestStreak: Number(streak?.longest_streak ?? 0),
      latestAttendanceDate,
      weights,
      goal,
      motivation,
      currentWeekStart,
      currentMonthStart,
    },
  });
}

export async function recordMyWeight(request: Request, response: Response) {
  memberOnly(request);
  const input = memberWeightSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_MEMBER_WEIGHT_INPUT', 'Indica un peso y una fecha válidos.', input.error.flatten());
  const today = dateInTimezone(request.tenant!.timezone);
  if (isoDate(utcDate(input.data.measuredOn)) !== input.data.measuredOn || input.data.measuredOn > today || input.data.measuredOn < addYears(today, -5)) {
    throw new AppError(400, 'MEMBER_WEIGHT_ENTRY_DATE_INVALID', 'La fecha debe estar entre hoy y los últimos cinco años.');
  }
  const { data, error } = await supabaseAdmin.rpc('upsert_member_weight_backend', {
    target_gym_id: request.tenant!.gymId,
    target_member_user_id: request.tenant!.gymUserId,
    supplied_weight_kg: input.data.weightKg,
    supplied_measured_on: input.data.measuredOn,
    supplied_source: 'member',
  });
  if (error) throw fromSupabaseError(error);
  const weightEntry = Array.isArray(data) ? data[0] : data;
  if (!weightEntry) throw new AppError(500, 'MEMBER_WEIGHT_ENTRY_EMPTY_RESULT', 'No se pudo guardar la medición.');
  response.status(201).json({ weightEntry: { ...weightEntry, weightKg: Number(weightEntry.weight_kg), measuredOn: weightEntry.measured_on, source: weightEntry.source, createdAt: weightEntry.created_at } });
}

export async function listMembers(request: Request, response: Response) {
  const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
  const [membersResult, locationsResult] = await Promise.all([
    supabaseAdmin.from('gym_users').select(memberFields)
      .eq('gym_id', request.tenant!.gymId).eq('role', 'member')
      .in('status', ['invited', 'active', 'suspended', 'inactive'])
      .order('created_at', { ascending: false }).limit(250),
    supabaseAdmin.from('gym_locations').select('id,name,is_main')
      .eq('gym_id', request.tenant!.gymId).eq('is_active', true)
      .order('is_main', { ascending: false }).order('name'),
  ]);
  const error = membersResult.error ?? locationsResult.error;
  if (error) throw fromSupabaseError(error);
  const needle = search.toLocaleLowerCase('es');
  const allMembers = (membersResult.data ?? []).filter((member) => {
    if (!needle) return true;
    const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
    const invitation = Array.isArray(member.invitation) ? member.invitation[0] : member.invitation;
    return `${profile?.full_name ?? member.managed_full_name ?? ''} ${profile?.phone ?? member.managed_phone ?? ''} ${invitation?.email ?? ''}`
      .toLocaleLowerCase('es').includes(needle);
  });
  response.json({
    members: allMembers.filter((member) => member.status !== 'inactive'),
    retiredMembers: allMembers.filter((member) => member.status === 'inactive' && member.joined_at),
    locations: locationsResult.data ?? [],
  });
}

export async function getMember(request: Request, response: Response) {
  const id = request.params.id;
  if (!id) throw new AppError(400, 'INVALID_ID', 'El identificador no es válido.');
  const { data, error } = await supabaseAdmin.from('gym_users').select(memberFields)
    .eq('gym_id', request.tenant!.gymId).eq('id', id).eq('role', 'member').maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw new AppError(404, 'MEMBER_NOT_FOUND', 'El miembro no existe.');
  const [membershipsResult, paymentsResult, attendancesResult, streakResult] = await Promise.all([
    supabaseAdmin.from('memberships').select('id,status,price_at_purchase,currency,created_at,plans(name),membership_periods(id,starts_on,ends_on,status,charged_amount,currency)').eq('gym_id', request.tenant!.gymId).eq('member_user_id', id).order('created_at', { ascending: false }),
    supabaseAdmin.from('member_payments').select('id,amount,currency,payment_method,status,paid_at,voided_at,refunded_at,receipt_number').eq('gym_id', request.tenant!.gymId).eq('member_user_id', id).order('paid_at', { ascending: false }),
    supabaseAdmin.from('attendances').select('id,attendance_date,checked_in_at,source,status,counts_toward_streak,void_reason').eq('gym_id', request.tenant!.gymId).eq('member_user_id', id).order('checked_in_at', { ascending: false }).limit(50),
    supabaseAdmin.from('user_streaks').select('status,current_streak,longest_streak,last_attendance_date,frozen_at').eq('gym_id', request.tenant!.gymId).eq('member_user_id', id).maybeSingle(),
  ]);
  const relatedError = membershipsResult.error ?? paymentsResult.error ?? attendancesResult.error ?? streakResult.error;
  if (relatedError) throw fromSupabaseError(relatedError);
  const memberships = membershipsResult.data ?? [];
  const payments = paymentsResult.data ?? [];
  const today = dateInTimezone(request.tenant!.timezone);
  const periods = memberships.flatMap((membership) => (membership.membership_periods ?? []).map((period) => ({
    ...period,
    membership,
  }))).filter((period) => period.status !== 'cancelled');
  const currentPeriod = periods
    .filter((period) => period.starts_on <= today && period.ends_on >= today && period.status === 'active')
    .sort((a, b) => b.ends_on.localeCompare(a.ends_on))[0];
  const latestPeriod = periods.sort((a, b) => b.ends_on.localeCompare(a.ends_on))[0];
  const currency = periods[0]?.currency ?? memberships[0]?.currency ?? payments[0]?.currency ?? 'USD';
  const totalCharged = periods.filter((period) => period.currency === currency)
    .reduce((total, period) => total + Number(period.charged_amount), 0);
  const totalPaid = payments.filter((payment) => payment.currency === currency && payment.status === 'confirmed')
    .reduce((total, payment) => total + Number(payment.amount), 0);
  const currentPlan = currentPeriod?.membership.plans;
  const latestPlan = latestPeriod?.membership.plans;
  const currentPlanName = (Array.isArray(currentPlan) ? currentPlan[0] : currentPlan)?.name ?? null;
  const latestPlanName = (Array.isArray(latestPlan) ? latestPlan[0] : latestPlan)?.name ?? null;
  response.json({
    member: data,
    memberships,
    payments,
    attendances: attendancesResult.data ?? [],
    streak: streakResult.data ?? null,
    summary: {
      coverageStatus: currentPeriod ? 'active' : latestPeriod && latestPeriod.ends_on < today ? 'expired' : 'none',
      planName: currentPlanName ?? latestPlanName,
      startsOn: currentPeriod?.starts_on ?? latestPeriod?.starts_on ?? null,
      endsOn: currentPeriod?.ends_on ?? latestPeriod?.ends_on ?? null,
      currency,
      totalCharged,
      totalPaid,
      outstanding: Math.max(0, totalCharged - totalPaid),
    },
  });
}

export async function inviteMember(request: Request, response: Response) {
  const input = inviteMemberSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_MEMBER_INPUT', 'Los datos del miembro no son válidos.', input.error.flatten());
  const member = await inviteMemberAccount({
    gymId: request.tenant!.gymId,
    invitedBy: request.tenant!.gymUserId,
    email: input.data.email,
    fullName: input.data.fullName,
    phone: input.data.phone ?? null,
    defaultLocationId: input.data.defaultLocationId ?? null,
  });
  response.status(201).json({ member });
}

export async function createManagedMember(request: Request, response: Response) {
  const input = managedMemberSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_MANAGED_MEMBER_INPUT', 'Los datos del miembro no son válidos.', input.error.flatten());
  const { data, error } = await supabaseAdmin.rpc('create_managed_member', {
    target_gym_id: request.tenant!.gymId,
    target_created_by: request.tenant!.gymUserId,
    target_full_name: input.data.fullName,
    target_phone: input.data.phone ?? null,
    target_birth_date: input.data.birthDate ?? null,
    target_guardian_name: input.data.guardianName ?? null,
    target_guardian_phone: input.data.guardianPhone ?? null,
    target_notes: input.data.notes ?? null,
    target_default_location_id: input.data.defaultLocationId ?? null,
  });
  if (error) throw fromSupabaseError(error);
  const created = Array.isArray(data) ? data[0] : undefined;
  if (!created) throw new AppError(500, 'MANAGED_MEMBER_EMPTY_RESULT', 'No se pudo crear el miembro administrado.');
  response.status(201).json({ member: created });
}

export async function revokeInvitation(request: Request, response: Response) {
  const invitationId = request.params.id;
  if (!invitationId || !z.string().uuid().safeParse(invitationId).success) {
    throw new AppError(400, 'INVALID_INVITATION_ID', 'La invitación no es válida.');
  }
  const { data: invitedMember } = await supabaseAdmin.from('gym_users').select('joined_at')
    .eq('gym_id', request.tenant!.gymId).eq('invitation_id', invitationId).maybeSingle();
  const { data, error } = await supabaseAdmin.rpc('revoke_member_invitation', {
    target_gym_id: request.tenant!.gymId,
    target_invitation_id: invitationId,
    target_revoked_by: request.tenant!.gymUserId,
  });
  if (error) throw fromSupabaseError(error);
  const revoked = Array.isArray(data) ? data[0] : undefined;
  if (!revoked) throw new AppError(404, 'INVITATION_NOT_FOUND', 'La invitación no existe o ya no está pendiente.');
  if (revoked.auth_user_id && !invitedMember?.joined_at) {
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(revoked.auth_user_id);
    if (deleteError) console.error('REVOKED_AUTH_USER_DELETE_FAILED', deleteError.message);
  }
  response.status(204).send();
}

function routeId(value: string | string[] | undefined) {
  return typeof value === 'string' ? value : undefined;
}

function validMemberId(value: string | undefined) {
  return Boolean(value && z.string().uuid().safeParse(value).success);
}

export async function updateMember(request: Request, response: Response) {
  const memberUserId = routeId(request.params.id);
  const input = updateMemberSchema.safeParse(request.body);
  if (!validMemberId(memberUserId) || !input.success) {
    throw new AppError(400, 'INVALID_MEMBER_DETAILS', 'Revisa los datos del miembro.', input.success ? undefined : input.error.flatten());
  }
  const { data, error } = await supabaseAdmin.rpc('update_member_backend', {
    target_gym_id: request.tenant!.gymId,
    target_member_user_id: memberUserId,
    target_updated_by: request.tenant!.gymUserId,
    supplied_full_name: input.data.fullName,
    supplied_phone: input.data.phone ?? null,
    supplied_birth_date: input.data.birthDate ?? null,
    supplied_guardian_name: input.data.guardianName ?? null,
    supplied_guardian_phone: input.data.guardianPhone ?? null,
    supplied_notes: input.data.notes ?? null,
    supplied_default_location_id: input.data.defaultLocationId ?? null,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  const member = Array.isArray(data) ? data[0] : undefined;
  if (!member) throw new AppError(404, 'MEMBER_NOT_FOUND', 'El miembro no existe.');
  response.json({ member });
}

export async function updateMemberStatus(request: Request, response: Response) {
  const memberUserId = routeId(request.params.id);
  const input = updateMemberStatusSchema.safeParse(request.body);
  if (!validMemberId(memberUserId) || !input.success) throw new AppError(400, 'INVALID_MEMBER_STATUS', 'El estado indicado no es válido.');
  const { data, error } = await supabaseAdmin.rpc('change_member_status_backend', {
    target_gym_id: request.tenant!.gymId,
    target_member_user_id: memberUserId,
    target_changed_by: request.tenant!.gymUserId,
    target_status: input.data.status,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.json({ member: Array.isArray(data) ? data[0] : data });
}

export async function retireMember(request: Request, response: Response) {
  const memberUserId = routeId(request.params.id);
  if (!validMemberId(memberUserId)) throw new AppError(400, 'INVALID_MEMBER_ID', 'El miembro no es válido.');
  const { error } = await supabaseAdmin.rpc('change_member_status_backend', {
    target_gym_id: request.tenant!.gymId,
    target_member_user_id: memberUserId,
    target_changed_by: request.tenant!.gymUserId,
    target_status: 'inactive',
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.status(204).send();
}

export async function reinstateMember(request: Request, response: Response) {
  const memberUserId = routeId(request.params.id);
  if (!validMemberId(memberUserId)) throw new AppError(400, 'INVALID_MEMBER_ID', 'El miembro no es válido.');
  const { data, error } = await supabaseAdmin.rpc('change_member_status_backend', {
    target_gym_id: request.tenant!.gymId,
    target_member_user_id: memberUserId,
    target_changed_by: request.tenant!.gymUserId,
    target_status: 'active',
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.json({ member: Array.isArray(data) ? data[0] : data });
}

export async function convertMemberToPortal(request: Request, response: Response) {
  const memberUserId = routeId(request.params.id);
  const input = convertManagedMemberSchema.safeParse(request.body);
  if (!validMemberId(memberUserId) || !input.success) throw new AppError(400, 'INVALID_MEMBER_CONVERSION', 'Ingresa un correo válido.');
  const converted = await convertManagedMemberToPortal({
    gymId: request.tenant!.gymId,
    memberUserId: memberUserId!,
    convertedBy: request.tenant!.gymUserId,
    email: input.data.email,
    usedPinElevation: request.permissionContext?.usedPinElevation ?? false,
  });
  response.status(201).json({ member: converted });
}
