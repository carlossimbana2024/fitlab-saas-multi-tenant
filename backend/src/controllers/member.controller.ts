import type { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { inviteMember as inviteMemberAccount } from '../services/memberInvitation.service.js';
import { inviteMemberSchema, managedMemberSchema } from '../validators/membership.validator.js';
import { z } from 'zod';

const memberFields = 'id,gym_id,profile_id,role,status,account_mode,invitation_id,default_location_id,joined_at,managed_full_name,managed_phone,managed_birth_date,managed_guardian_name,managed_guardian_phone,managed_notes,profiles(full_name,phone,avatar_url,preferred_language)';
const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(150),
  phone: z.string().trim().max(30).nullable().optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
});

export async function updateMyProfile(request: Request, response: Response) {
  const input = profileSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_PROFILE_INPUT', 'Los datos del perfil no son válidos.', input.error.flatten());
  const { data, error } = await supabaseAdmin.from('profiles').update({
    full_name: input.data.fullName,
    phone: input.data.phone || null,
    avatar_url: input.data.avatarUrl || null,
  }).eq('id', request.authUser!.id).select('full_name,phone,avatar_url,preferred_language').single();
  if (error) throw fromSupabaseError(error);
  response.json({ profile: data });
}

export async function listMembers(request: Request, response: Response) {
  const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
  let query = request.supabase!.from('gym_users').select(memberFields).eq('role', 'member').order('created_at', { ascending: false }).limit(100);
  if (search) query = query.ilike('profiles.full_name', `%${search.replace(/[%_]/g, '')}%`);
  const { data, error } = await query;
  if (error) throw fromSupabaseError(error);
  response.json({ members: data });
}

export async function getMember(request: Request, response: Response) {
  const id = request.params.id;
  if (!id) throw new AppError(400, 'INVALID_ID', 'El identificador no es válido.');
  const { data, error } = await request.supabase!.from('gym_users').select(memberFields).eq('id', id).eq('role', 'member').maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw new AppError(404, 'MEMBER_NOT_FOUND', 'El miembro no existe.');
  const [membershipsResult, paymentsResult, attendancesResult, streakResult] = await Promise.all([
    request.supabase!.from('memberships').select('id,status,price_at_purchase,currency,created_at,plans(name),membership_periods(id,starts_on,ends_on,status)').eq('member_user_id', id).order('created_at', { ascending: false }),
    request.supabase!.from('member_payments').select('id,amount,currency,payment_method,status,paid_at,voided_at').eq('member_user_id', id).order('paid_at', { ascending: false }).limit(50),
    request.supabase!.from('attendances').select('id,attendance_date,checked_in_at,source,status,counts_toward_streak,void_reason').eq('member_user_id', id).order('checked_in_at', { ascending: false }).limit(50),
    request.supabase!.from('user_streaks').select('status,current_streak,longest_streak,last_attendance_date,frozen_at').eq('member_user_id', id).maybeSingle(),
  ]);
  const relatedError = membershipsResult.error ?? paymentsResult.error ?? attendancesResult.error ?? streakResult.error;
  if (relatedError) throw fromSupabaseError(relatedError);
  response.json({
    member: data,
    memberships: membershipsResult.data ?? [],
    payments: paymentsResult.data ?? [],
    attendances: attendancesResult.data ?? [],
    streak: streakResult.data ?? null,
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
  const { data, error } = await supabaseAdmin.rpc('revoke_member_invitation', {
    target_gym_id: request.tenant!.gymId,
    target_invitation_id: invitationId,
    target_revoked_by: request.tenant!.gymUserId,
  });
  if (error) throw fromSupabaseError(error);
  const revoked = Array.isArray(data) ? data[0] : undefined;
  if (!revoked) throw new AppError(404, 'INVITATION_NOT_FOUND', 'La invitación no existe o ya no está pendiente.');
  if (revoked.auth_user_id) {
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(revoked.auth_user_id);
    if (deleteError) console.error('REVOKED_AUTH_USER_DELETE_FAILED', deleteError.message);
  }
  response.status(204).send();
}
