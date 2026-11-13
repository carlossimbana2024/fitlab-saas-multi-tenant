// Explicit units; never interpret legacy current_streak/longest_streak here.
export type MemberPersonalStreaks = {
  weeklyCurrentStreak: number | null;
  weeklyBestStreak: number | null;
  dailyCurrentStreak: number;
  dailyBestStreak: number;
  weeklyStatus: 'available' | 'not_evaluable' | 'needs_review';
  today: string;
};

export type SharedWeeklyStreak = {
  current: number | null;
  best: number | null;
  status: MemberPersonalStreaks['weeklyStatus'];
};

export function weeklyStreakLabel(current: number | null, status: SharedWeeklyStreak['status']) {
  if (status === 'not_evaluable') return 'No aplicable actualmente';
  return streakQuantity(current, 'week');
}

export const personalStreakKey = (gymId: string | undefined, memberId: string | undefined, today: string, timezone: string) =>
  ['my-personal-streaks', gymId, memberId, today, timezone] as const;

export function streakQuantity(value: number | null | undefined, unit: 'week' | 'day'): string {
  if (value == null || !Number.isInteger(value) || value < 0) return 'No disponible';
  return `${value} ${unit === 'week' ? value === 1 ? 'semana' : 'semanas' : value === 1 ? 'día' : 'días'}`;
}

export function personalStreakLabels(value: MemberPersonalStreaks | undefined) {
  return {
    weekly: value ? weeklyStreakLabel(value.weeklyCurrentStreak, value.weeklyStatus) : 'No disponible',
    weeklyBest: streakQuantity(value?.weeklyBestStreak, 'week'),
    daily: streakQuantity(value?.dailyCurrentStreak, 'day'),
    dailyBest: streakQuantity(value?.dailyBestStreak, 'day'),
  };
}
