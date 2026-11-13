import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { parseAggregate } from './memberAggregates.service.js';

const count = z.number().int().nonnegative();
const weeklyStatus = z.enum(['available', 'not_evaluable', 'needs_review']);
export const memberPersonalStreaksSchema = z.object({
  weeklyCurrentStreak: count.nullable(),
  weeklyBestStreak: count.nullable(),
  dailyCurrentStreak: count,
  dailyBestStreak: count,
  weeklyStatus,
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).superRefine((value, ctx) => {
  const unknown = value.weeklyStatus === 'needs_review';
  if ((value.weeklyCurrentStreak === null) !== unknown || (value.weeklyBestStreak === null) !== unknown
    || (value.weeklyCurrentStreak ?? 0) > (value.weeklyBestStreak ?? 0)
    || value.dailyCurrentStreak > value.dailyBestStreak) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent streak evidence' });
  }
});

export function sharedWeeklyStreak(streaks: z.infer<typeof memberPersonalStreaksSchema>) {
  return { current: streaks.weeklyCurrentStreak, best: streaks.weeklyBestStreak, status: streaks.weeklyStatus };
}

export async function memberPersonalStreaks(gymId: string, memberId: string) {
  const { data, error } = await supabaseAdmin.rpc('get_member_personal_streaks_backend', {
    target_gym_id: gymId, actor_member_user_id: memberId,
  });
  if (error) throw fromSupabaseError(error);
  return parseAggregate(memberPersonalStreaksSchema, data);
}
