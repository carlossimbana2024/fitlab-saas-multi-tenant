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

function roundedPercent(value: number) {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
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

  let rawProgress: number | null = null;
  if (goal === 'lose_weight' && targetWeightKg < baseline.weightKg) {
    rawProgress = ((baseline.weightKg - current.weightKg) / (baseline.weightKg - targetWeightKg)) * 100;
  } else if ((goal === 'gain_weight' || goal === 'build_muscle') && targetWeightKg > baseline.weightKg) {
    rawProgress = ((current.weightKg - baseline.weightKg) / (targetWeightKg - baseline.weightKg)) * 100;
  } else if (goal === 'maintain_weight' && targetWeightKg !== baseline.weightKg) {
    const initialDistance = Math.abs(baseline.weightKg - targetWeightKg);
    rawProgress = ((initialDistance - Math.abs(current.weightKg - targetWeightKg)) / initialDistance) * 100;
  }
  if (rawProgress === null || !Number.isFinite(rawProgress) || rawProgress <= 0) return null;
  return {
    progressPercent: roundedPercent(rawProgress),
    baselineWeightKg: baseline.weightKg,
    currentWeightKg: current.weightKg,
    baselineDate: baseline.measuredOn,
    currentDate: current.measuredOn,
  };
}
