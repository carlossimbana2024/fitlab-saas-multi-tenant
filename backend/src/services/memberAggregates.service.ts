import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';

const weightMaintenance = z.object({ currentWeightKg: z.number().finite().min(20).max(500), targetWeightKg: z.number().finite().min(20).max(500), differenceKg: z.number().finite() });
const count = z.number().int().nonnegative();
const bucket = z.object({ period: z.string(), count });
export const attendanceSummarySchema = z.object({
  today: z.string(), currentWeekStart: z.string(), currentMonthStart: z.string(),
  totalAttendances: count, currentMonthAttendances: count, currentWeekAttendances: count,
  latestAttendanceDate: z.string().nullable(), hasAttendanceToday: z.boolean(),
  attendanceByMonth: z.array(bucket), attendanceByWeek: z.array(bucket), averageWeeklyAttendances: z.number(),
});
export const communityPageSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(), name: z.string(), avatarPath: z.string().nullable(), goalType: z.string().nullable(),
    publicMessage: z.string().nullable(), joinedAt: z.string().nullable(), currentStreak: count.nullable(),
    longestStreak: count.nullable(), monthlyAttendances: count.nullable(), progressPercent: z.number().finite().min(0).max(100).nullable(),
    weightMaintenance: weightMaintenance.nullable().default(null),
    reactions: z.object({ like: count, love: count, mine: z.enum(['like','love']).nullable() }),
  })).max(50),
  nextCursor: z.record(z.unknown()).nullable(), hasMore: z.boolean(),
}).refine(page => page.hasMore === (page.nextCursor !== null), 'Invalid pagination result');
const rankingEntry = z.object({ memberUserId: z.string().uuid(), name: z.string(), value: z.number(),
  position: z.number().int().min(1).max(3), avatarPath: z.string().nullable(), goalType: z.string().nullable() });
export const communityRankingsSchema = z.object({ from: z.string(), to: z.string(), categories: z.object({
  attendance: z.array(rankingEntry).max(3), streak: z.array(rankingEntry).max(3), progress: z.array(rankingEntry).max(3),
}) });

// Null/malformed RPC output is an API error, never an empty or zero summary.
export function parseAggregate<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new AppError(502, 'INVALID_MEMBER_AGGREGATE_RESPONSE', 'No se pudo recuperar el resumen. Intenta nuevamente.');
  return result.data;
}
export async function memberAttendanceSummary(gymId: string, memberId: string) {
  const { data, error } = await supabaseAdmin.rpc('get_member_attendance_summary_backend', {
    target_gym_id: gymId, actor_member_user_id: memberId,
  });
  if (error) throw fromSupabaseError(error);
  return parseAggregate(attendanceSummarySchema, data);
}
