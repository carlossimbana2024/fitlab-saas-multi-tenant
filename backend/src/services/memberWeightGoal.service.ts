/**
 * FIT-MEMBER-010: backend equivalent of private.member_weight_goal_metric (0055).
 * Keep SQL parity tests when changing this definition. No survey-weight fallback.
 * Persisted weights use numeric(6,2); integer hundredths avoid binary decimal drift.
 */
export type WeightMaintenance = { currentWeightKg: number; targetWeightKg: number; differenceKg: number };
export function weightGoalMetric(goal: string, target: number | null, baseline: number | null, current: number | null):
  { progressPercent: number | null; maintenance: WeightMaintenance | null } {
  const valid = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 20 && n <= 500;
  const empty = { progressPercent: null, maintenance: null };
  if (!valid(target) || !valid(current)) return empty;
  const t = Math.round(target * 100), c = Math.round(current * 100);
  if (goal === 'maintain_weight') return {
    progressPercent: null, maintenance: { currentWeightKg: current, targetWeightKg: target, differenceKg: (c - t) / 100 },
  };
  if (!valid(baseline)) return empty;
  const b = Math.round(baseline * 100);
  const directionValid = (goal === 'lose_weight' && t < b)
    || ((goal === 'gain_weight' || goal === 'build_muscle') && t > b);
  if (!directionValid) return empty;
  // Equivalent signed ratios for loss/gain; round only after clamping.
  const tenths = Math.max(0, Math.min(1000, ((c - b) * 1000) / (t - b)));
  return { progressPercent: Math.round(tenths) / 10, maintenance: null };
}

export function computeGoalProgress(goalType: string, initialWeightKg: number | null, currentWeightKg: number | null, targetWeightKg: number | null) {
  const metric = weightGoalMetric(goalType, targetWeightKg, initialWeightKg, currentWeightKg);
  if (metric.progressPercent === null && metric.maintenance === null) return null;
  return { goalType, initialWeightKg, currentWeightKg, targetWeightKg,
    progressPercent: metric.progressPercent, maintenance: metric.maintenance };
}
