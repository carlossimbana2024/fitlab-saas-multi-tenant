type Period = { starts_on: string; ends_on: string; status: string };
type Membership = { id: string; status: string; attendance_mode_snapshot: string; weekly_target_snapshot?: number | null; membership_periods?: Period[] };
export type WeeklyProgress = { id: string; membership_id: string; week_starts_on: string; week_ends_on: string; target_attendances: number; completed_attendances: number; goal_met: boolean; is_grace_week: boolean };

/** Same Monday/Sunday boundaries as the SQL engine. Today is a gym-local date. */
export function selectCurrentWeeklyProgress(rows: WeeklyProgress[], membership: Membership | undefined, today: string): WeeklyProgress | undefined {
  if (!membership || membership.status !== 'active' || membership.attendance_mode_snapshot !== 'weekly') return;
  const periods = membership.membership_periods?.filter(p => p.status === 'active') ?? [];
  if (!periods.some(p => p.starts_on <= today && p.ends_on >= today)) return;
  const date = new Date(`${today}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return;
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  const start = date.toISOString().slice(0,10);
  date.setUTCDate(date.getUTCDate() + 6);
  const end = date.toISOString().slice(0,10);
  const current = rows.find(row => row.membership_id === membership.id && row.week_starts_on === start && row.week_ends_on === end);
  if (current) return current;
  const target = membership.weekly_target_snapshot;
  if (target == null || target < 1 || target > 7) return;
  return { id: `pending:${membership.id}:${start}`, membership_id: membership.id, week_starts_on: start, week_ends_on: end,
    target_attendances: target, completed_attendances: 0, goal_met: false,
    is_grace_week: periods.some(p => p.starts_on > start && p.starts_on <= end) };
}
