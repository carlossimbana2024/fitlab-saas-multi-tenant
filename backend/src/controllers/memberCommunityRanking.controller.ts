import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { monthlyWeightGoalProgress, longestConsecutiveAttendance, type RankingGoal } from '../services/communityRanking.service.js';
import { signAvatarUrl } from '../services/memberProfile.service.js';
import { dateInTimezone } from '../utils/gymDate.js';
import { fromSupabaseError } from '../utils/supabaseError.js';

const rankingQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});

type RankingProfile = {
  member_user_id: string;
  goal_type: RankingGoal;
  target_weight_kg: number | null;
  show_profile_photo: boolean;
  show_streak: boolean;
  show_attendance_count: boolean;
  show_weight_progress: boolean;
  show_goal: boolean;
};

type Candidate = {
  memberUserId: string;
  name: string;
  value: number;
  profile: RankingProfile;
};

function memberOnly(request: Request) {
  if (request.tenant?.role !== 'member') throw new AppError(403, 'MEMBER_ONLY_ENDPOINT', 'Esta sección está disponible solo para miembros.');
}

function relatedOne<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

function monthEnd(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, monthNumber!, 0)).toISOString().slice(0, 10);
}

function monthLabel(month: string) {
  return new Intl.DateTimeFormat('es-EC', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${month}-01T00:00:00Z`));
}

function availablePeriods(currentMonth: string) {
  const [year, month] = currentMonth.split('-').map(Number);
  return Array.from({ length: 24 }, (_, index) => {
    const date = new Date(Date.UTC(year!, month! - 1 - index, 1));
    const key = date.toISOString().slice(0, 7);
    return { key, label: monthLabel(key) };
  });
}

function topThree(candidates: Candidate[]) {
  return candidates
    .filter((candidate) => candidate.value > 0)
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name, 'es') || left.memberUserId.localeCompare(right.memberUserId))
    .slice(0, 3);
}

export async function getMemberCommunityRankings(request: Request, response: Response) {
  memberOnly(request);
  const input = rankingQuerySchema.safeParse({ month: typeof request.query.month === 'string' ? request.query.month : undefined });
  if (!input.success) throw new AppError(400, 'INVALID_COMMUNITY_RANKING_MONTH', 'El mes seleccionado no es válido.');

  const today = dateInTimezone(request.tenant!.timezone);
  const currentMonth = today.slice(0, 7);
  const selectedMonth = input.data.month ?? currentMonth;
  if (selectedMonth > currentMonth) throw new AppError(400, 'COMMUNITY_RANKING_FUTURE_MONTH', 'No puedes consultar un ranking futuro.');
  const from = `${selectedMonth}-01`;
  const naturalTo = monthEnd(selectedMonth);
  const to = selectedMonth === currentMonth ? today : naturalTo;

  const [membersResult, profilesResult, attendancesResult, weightsResult] = await Promise.all([
    supabaseAdmin.from('gym_users').select('id,profiles(full_name,avatar_url)')
      .eq('gym_id', request.tenant!.gymId).eq('role', 'member').eq('status', 'active').eq('account_mode', 'portal').limit(250),
    supabaseAdmin.from('member_fitness_profiles')
      .select('member_user_id,goal_type,target_weight_kg,show_profile_photo,show_streak,show_attendance_count,show_weight_progress,show_goal')
      .eq('gym_id', request.tenant!.gymId).eq('show_in_community', true).limit(250),
    supabaseAdmin.from('attendances').select('member_user_id,attendance_date')
      .eq('gym_id', request.tenant!.gymId).eq('status', 'valid').gte('attendance_date', from).lte('attendance_date', to).limit(10000),
    supabaseAdmin.from('member_weight_entries').select('member_user_id,weight_kg,measured_on')
      .eq('gym_id', request.tenant!.gymId).lte('measured_on', to).order('measured_on', { ascending: true }).limit(10000),
  ]);
  const error = membersResult.error ?? profilesResult.error ?? attendancesResult.error ?? weightsResult.error;
  if (error) throw fromSupabaseError(error);

  const profileByMember = new Map<string, RankingProfile>((profilesResult.data ?? []).map((profile) => [profile.member_user_id, profile as RankingProfile]));
  const members = (membersResult.data ?? []).flatMap((member) => {
    const profile = profileByMember.get(member.id);
    if (!profile) return [];
    const identity = relatedOne(member.profiles);
    return [{ id: member.id, name: identity?.full_name ?? 'Miembro', avatarPath: identity?.avatar_url ?? null, profile }];
  });
  const attendanceDates = new Map<string, string[]>();
  for (const attendance of attendancesResult.data ?? []) {
    const values = attendanceDates.get(attendance.member_user_id) ?? [];
    values.push(attendance.attendance_date);
    attendanceDates.set(attendance.member_user_id, values);
  }
  const weights = new Map<string, Array<{ weightKg: number; measuredOn: string }>>();
  for (const entry of weightsResult.data ?? []) {
    const values = weights.get(entry.member_user_id) ?? [];
    values.push({ weightKg: Number(entry.weight_kg), measuredOn: entry.measured_on });
    weights.set(entry.member_user_id, values);
  }

  const attendanceCandidates: Candidate[] = [];
  const streakCandidates: Candidate[] = [];
  const progressCandidates: Candidate[] = [];
  for (const member of members) {
    const dates = attendanceDates.get(member.id) ?? [];
    if (member.profile.show_attendance_count) attendanceCandidates.push({ memberUserId: member.id, name: member.name, value: new Set(dates).size, profile: member.profile });
    if (member.profile.show_streak) streakCandidates.push({ memberUserId: member.id, name: member.name, value: longestConsecutiveAttendance(dates), profile: member.profile });
    if (member.profile.show_weight_progress) {
      const progress = monthlyWeightGoalProgress(member.profile.goal_type, member.profile.target_weight_kg == null ? null : Number(member.profile.target_weight_kg), weights.get(member.id) ?? [], from, to);
      if (progress) progressCandidates.push({ memberUserId: member.id, name: member.name, value: progress.progressPercent, profile: member.profile });
    }
  }

  const ranked = {
    attendance: topThree(attendanceCandidates),
    streak: topThree(streakCandidates),
    progress: topThree(progressCandidates),
  };
  const winnerIds = [...new Set([...ranked.attendance, ...ranked.streak, ...ranked.progress].map((entry) => entry.memberUserId))];
  const memberById = new Map(members.map((member) => [member.id, member]));
  const avatarByMember = new Map<string, string | null>();
  await Promise.all(winnerIds.map(async (memberUserId) => {
    const member = memberById.get(memberUserId);
    avatarByMember.set(memberUserId, member?.profile.show_profile_photo ? await signAvatarUrl(member.avatarPath) : null);
  }));
  const entries = (values: Candidate[], unit: 'attendance' | 'streak' | 'progress') => values.map((candidate, index) => ({
    position: index + 1,
    memberUserId: candidate.memberUserId,
    name: candidate.name,
    avatarUrl: avatarByMember.get(candidate.memberUserId) ?? null,
    value: candidate.value,
    displayValue: unit === 'attendance' ? `${candidate.value} asistencias` : unit === 'streak' ? `${candidate.value} días consecutivos` : `${candidate.value}% de avance`,
    goalType: candidate.profile.show_goal ? candidate.profile.goal_type : null,
  }));

  response.json({
    ranking: {
      period: { key: selectedMonth, label: monthLabel(selectedMonth), from, to, isCurrent: selectedMonth === currentMonth },
      availablePeriods: availablePeriods(currentMonth),
      historyMode: 'reconstructed',
      categories: {
        attendance: {
          title: 'Más asistencias del mes',
          explanation: 'Cuenta únicamente asistencias válidas registradas durante el mes.',
          entries: entries(ranked.attendance, 'attendance'),
        },
        streak: {
          title: 'Mayor racha del mes',
          explanation: 'Mayor secuencia de días calendario consecutivos con una asistencia válida dentro del mes.',
          entries: entries(ranked.streak, 'streak'),
        },
        progress: {
          title: 'Mayor progreso hacia su meta',
          explanation: 'Porcentaje de la distancia al peso objetivo cerrada durante el mes. Requiere una medición base y otra posterior; nunca compara kilos absolutos.',
          entries: entries(ranked.progress, 'progress'),
        },
      },
    },
  });
}
