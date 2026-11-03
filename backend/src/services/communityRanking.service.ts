import { weightGoalMetric } from './memberWeightGoal.service.js';

export type RankingGoal = 'lose_weight' | 'gain_weight' | 'build_muscle' | 'improve_fitness' | 'maintain_weight' | 'general_wellness';

export type WeightPoint = {
  weightKg: number;
  measuredOn: string;
};

export type MonthlyGoalProgress = {
  progressPercent: number;
  baselineWeightKg: number;
  currentWeightKg: number;
  baselineDate: string;
  currentDate: string;
};

const DAY_MS = 86_400_000;

function utcDay(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year!, month! - 1, day!);
}

export function longestConsecutiveAttendance(values: string[]) {
  const dates = [...new Set(values)].sort();
  let longest = 0;
  let current = 0;
  let previous: number | null = null;
  for (const value of dates) {
    const day = utcDay(value);
    current = previous !== null && day - previous === DAY_MS ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = day;
  }
  return longest;
}

export function monthlyWeightGoalProgress(
  goal: RankingGoal,
  targetWeightKg: number | null,
  points: WeightPoint[],
  from: string,
  to: string,
): MonthlyGoalProgress | null {
  if (targetWeightKg === null || !Number.isFinite(targetWeightKg)) return null;
  const ordered = points
    .filter((point) => Number.isFinite(point.weightKg) && point.measuredOn <= to)
    .sort((left, right) => left.measuredOn.localeCompare(right.measuredOn));
  const monthPoints = ordered.filter((point) => point.measuredOn >= from && point.measuredOn <= to);
  const baseline = ordered.filter((point) => point.measuredOn < from).at(-1) ?? monthPoints[0];
  const current = monthPoints.at(-1);
  if (!baseline || !current || baseline.measuredOn >= current.measuredOn) return null;

  const { progressPercent } = weightGoalMetric(goal, targetWeightKg, baseline.weightKg, current.weightKg);
  if (progressPercent === null || progressPercent <= 0) return null;
  return {
    progressPercent,
    baselineWeightKg: baseline.weightKg,
    currentWeightKg: current.weightKg,
    baselineDate: baseline.measuredOn,
    currentDate: current.measuredOn,
  };
}
