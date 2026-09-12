import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { signAvatarUrl } from '../services/memberProfile.service.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { dateInTimezone } from '../utils/gymDate.js';

const communityFilters = ['all', 'similar_goal', 'consistent', 'new', 'longest_streak', 'featured', 'progress'] as const;
const communityQuerySchema = z.object({ filter: z.enum(communityFilters).default('all') });
const reactionSchema = z.object({ targetMemberUserId: z.string().uuid(), reactionType: z.enum(['like', 'love']) });
const DAY_MS = 86_400_000;

type CommunityProfile = {
  member_user_id: string;
  weight_kg: number;
  target_weight_kg: number | null;
  goal_type: string;
  public_message: string | null;
  show_profile_photo: boolean;
  show_streak: boolean;
  show_attendance_count: boolean;
  show_weight_progress: boolean;
  show_goal: boolean;
};

function memberOnly(request: Request) {
  if (request.tenant?.role !== 'member') throw new AppError(403, 'MEMBER_ONLY_ENDPOINT', 'Esta sección está disponible solo para miembros.');
}

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

function monthStart(value: string) {
  const date = utcDate(value);
  return isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function goalProgress(profile: CommunityProfile, currentWeight: number | null) {
  if (currentWeight === null || profile.target_weight_kg === null) return null;
  const initialWeight = Number(profile.weight_kg);
  const targetWeight = Number(profile.target_weight_kg);
  if (profile.goal_type === 'lose_weight' && targetWeight < initialWeight) {
    return clampPercent(((currentWeight - initialWeight) / (targetWeight - initialWeight)) * 100);
  }
  if ((profile.goal_type === 'gain_weight' || profile.goal_type === 'build_muscle') && targetWeight > initialWeight) {
    return clampPercent(((currentWeight - initialWeight) / (targetWeight - initialWeight)) * 100);
  }
  if (profile.goal_type === 'maintain_weight') {
    const distance = Math.abs(initialWeight - targetWeight);
    return distance === 0 ? 100 : clampPercent((1 - Math.abs(currentWeight - targetWeight) / distance) * 100);
  }
  return null;
}

function relatedOne<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

export async function listMemberCommunity(request: Request, response: Response) {
  memberOnly(request);
  const input = communityQuerySchema.safeParse({ filter: typeof request.query.filter === 'string' ? request.query.filter : undefined });
  if (!input.success) throw new AppError(400, 'INVALID_COMMUNITY_FILTER', 'El filtro de Comunidad no es válido.');
  const today = dateInTimezone(request.tenant!.timezone);
  const from = monthStart(today);
  const [membersResult, profilesResult, streaksResult, attendanceResult, weightsResult, reactionsResult, viewerProfileResult] = await Promise.all([
    supabaseAdmin.from('gym_users').select('id,joined_at,profiles(full_name,avatar_url)')
      .eq('gym_id', request.tenant!.gymId).eq('role', 'member').eq('status', 'active').eq('account_mode', 'portal').limit(250),
    supabaseAdmin.from('member_fitness_profiles').select('member_user_id,weight_kg,target_weight_kg,goal_type,public_message,show_profile_photo,show_streak,show_attendance_count,show_weight_progress,show_goal')
      .eq('gym_id', request.tenant!.gymId).eq('show_in_community', true).limit(250),
    supabaseAdmin.from('user_streaks').select('member_user_id,current_streak,longest_streak')
      .eq('gym_id', request.tenant!.gymId).limit(250),
    supabaseAdmin.from('attendances').select('member_user_id,attendance_date,status')
      .eq('gym_id', request.tenant!.gymId).eq('status', 'valid').gte('attendance_date', from).lte('attendance_date', today).limit(5000),
    supabaseAdmin.from('member_weight_entries').select('member_user_id,weight_kg,measured_on')
      .eq('gym_id', request.tenant!.gymId).order('measured_on', { ascending: true }).limit(5000),
    supabaseAdmin.from('member_community_reactions').select('actor_member_user_id,target_member_user_id,reaction_type')
      .eq('gym_id', request.tenant!.gymId).limit(10000),
    supabaseAdmin.from('member_fitness_profiles').select('goal_type').eq('gym_id', request.tenant!.gymId).eq('member_user_id', request.tenant!.gymUserId).maybeSingle(),
  ]);
  const error = membersResult.error ?? profilesResult.error ?? streaksResult.error ?? attendanceResult.error ?? weightsResult.error ?? reactionsResult.error ?? viewerProfileResult.error;
  if (error) throw fromSupabaseError(error);

  const visibleProfiles = new Map<string, CommunityProfile>((profilesResult.data ?? []).map((profile) => [profile.member_user_id, profile as CommunityProfile]));
  const members = (membersResult.data ?? []).filter((member) => member.id !== request.tenant!.gymUserId && visibleProfiles.has(member.id));
  const streaks = new Map((streaksResult.data ?? []).map((streak) => [streak.member_user_id, streak]));
  const monthlyAttendance = new Map<string, number>();
  for (const attendance of attendanceResult.data ?? []) monthlyAttendance.set(attendance.member_user_id, (monthlyAttendance.get(attendance.member_user_id) ?? 0) + 1);
  const weightsByMember = new Map<string, Array<{ weightKg: number; measuredOn: string }>>();
  for (const entry of weightsResult.data ?? []) {
    const entries = weightsByMember.get(entry.member_user_id) ?? [];
    entries.push({ weightKg: Number(entry.weight_kg), measuredOn: entry.measured_on });
    weightsByMember.set(entry.member_user_id, entries);
  }
  const reactions = reactionsResult.data ?? [];
  const viewerReactionByTarget = new Map<string, string>();
  const reactionCounts = new Map<string, { like: number; love: number }>();
  for (const reaction of reactions) {
    const counts = reactionCounts.get(reaction.target_member_user_id) ?? { like: 0, love: 0 };
    if (reaction.reaction_type === 'like') counts.like += 1;
    if (reaction.reaction_type === 'love') counts.love += 1;
    reactionCounts.set(reaction.target_member_user_id, counts);
    if (reaction.actor_member_user_id === request.tenant!.gymUserId) viewerReactionByTarget.set(reaction.target_member_user_id, reaction.reaction_type);
  }

  const profiles = await Promise.all(members.map(async (member) => {
    const profile = visibleProfiles.get(member.id)!;
    const streak = streaks.get(member.id);
    const memberWeights = weightsByMember.get(member.id) ?? [];
    const currentWeight = memberWeights.at(-1)?.weightKg ?? Number(profile.weight_kg);
    const progressPercent = profile.show_weight_progress ? goalProgress(profile, currentWeight) : null;
    const counts = reactionCounts.get(member.id) ?? { like: 0, love: 0 };
    const profileData = relatedOne(member.profiles);
    return {
      id: member.id,
      name: profileData?.full_name ?? 'Miembro',
      avatarUrl: profile.show_profile_photo ? await signAvatarUrl(profileData?.avatar_url ?? null) : null,
      currentStreak: profile.show_streak ? Number(streak?.current_streak ?? 0) : null,
      longestStreak: profile.show_streak ? Number(streak?.longest_streak ?? 0) : null,
      monthlyAttendances: profile.show_attendance_count ? monthlyAttendance.get(member.id) ?? 0 : null,
      goalType: profile.show_goal ? profile.goal_type : null,
      progressPercent,
      publicMessage: profile.public_message,
      reactions: { like: counts.like, love: counts.love, mine: viewerReactionByTarget.get(member.id) ?? null },
      joinedAt: member.joined_at,
    };
  }));

  const viewerGoal = viewerProfileResult.data?.goal_type ?? null;
  const filter = input.data.filter;
  const filtered = profiles.filter((profile) => filter !== 'similar_goal' || (viewerGoal !== null && profile.goalType === viewerGoal));
  // "Destacados" solo prioriza perfiles con contexto público completo.
  // No mezcla métricas deportivas: los rankings de asistencia, racha y progreso
  // se calcularán de forma independiente en la siguiente fase.
  const profileCompleteness = (profile: typeof profiles[number]) => Number(Boolean(profile.publicMessage)) + Number(Boolean(profile.goalType)) + Number(Boolean(profile.avatarUrl));
  filtered.sort((left, right) => {
    if (filter === 'consistent') return (right.monthlyAttendances ?? -1) - (left.monthlyAttendances ?? -1);
    if (filter === 'longest_streak') return (right.longestStreak ?? -1) - (left.longestStreak ?? -1);
    if (filter === 'new') return String(right.joinedAt ?? '').localeCompare(String(left.joinedAt ?? ''));
    if (filter === 'progress') return (right.progressPercent ?? -1) - (left.progressPercent ?? -1);
    if (filter === 'featured') return profileCompleteness(right) - profileCompleteness(left) || left.name.localeCompare(right.name, 'es');
    return left.name.localeCompare(right.name, 'es');
  });
  response.json({
    members: filtered.map(({ joinedAt: _joinedAt, ...profile }) => profile),
    viewer: { goalType: viewerGoal },
    filter,
    period: { from, to: today },
  });
}

export async function toggleMemberCommunityReaction(request: Request, response: Response) {
  memberOnly(request);
  const input = reactionSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_COMMUNITY_REACTION', 'La reacción no es válida.');
  const { data, error } = await supabaseAdmin.rpc('toggle_member_community_reaction_backend', {
    p_target_gym_id: request.tenant!.gymId,
    p_actor_member_user_id: request.tenant!.gymUserId,
    p_target_member_user_id: input.data.targetMemberUserId,
    p_supplied_reaction_type: input.data.reactionType,
  });
  if (error) throw fromSupabaseError(error);
  response.json({ reaction: data });
}
