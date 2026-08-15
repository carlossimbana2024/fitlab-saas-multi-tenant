import type { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { convertManagedMemberToPortal, inviteMember as inviteMemberAccount } from '../services/memberInvitation.service.js';
import { convertManagedMemberSchema, inviteMemberSchema, managedMemberSchema, updateMemberSchema, updateMemberStatusSchema } from '../validators/membership.validator.js';
import { z } from 'zod';
import { dateInTimezone } from '../utils/gymDate.js';

const memberFields = 'id,gym_id,profile_id,role,status,account_mode,invitation_id,default_location_id,joined_at,created_at,managed_full_name,managed_phone,managed_birth_date,managed_guardian_name,managed_guardian_phone,managed_notes,profiles(full_name,phone,avatar_url,preferred_language),invitation:gym_invitations!gym_users_invitation_id_fkey(email,status,expires_at)';
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
    supabaseAdmin.from('memberships').select('id,status,price_at_purchase,currency,created_at,plans(name),membership_periods(id,starts_on,ends_on,status)').eq('gym_id', request.tenant!.gymId).eq('member_user_id', id).order('created_at', { ascending: false }),
    supabaseAdmin.from('member_payments').select('id,amount,currency,payment_method,status,paid_at,voided_at').eq('gym_id', request.tenant!.gymId).eq('member_user_id', id).order('paid_at', { ascending: false }),
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
  const billableMemberships = memberships.filter((membership) => membership.status !== 'cancelled');
  const currency = billableMemberships[0]?.currency ?? payments[0]?.currency ?? 'USD';
  const totalCharged = billableMemberships.filter((membership) => membership.currency === currency)
    .reduce((total, membership) => total + Number(membership.price_at_purchase), 0);
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
