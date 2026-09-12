import { describe, expect, it } from 'vitest';
import { longestConsecutiveAttendance, monthlyWeightGoalProgress } from '../src/services/communityRanking.service.js';

describe('rankings mensuales de Comunidad', () => {
  it('reinicia y calcula la mayor racha dentro de las fechas recibidas', () => {
    expect(longestConsecutiveAttendance(['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-05', '2026-09-06'])).toBe(3);
    expect(longestConsecutiveAttendance([])).toBe(0);
  });

  it('compara progreso relativo para metas de pérdida y aumento de peso', () => {
    expect(monthlyWeightGoalProgress('lose_weight', 70, [
      { weightKg: 80, measuredOn: '2026-08-31' },
      { weightKg: 77, measuredOn: '2026-09-20' },
    ], '2026-09-01', '2026-09-30')?.progressPercent).toBe(30);
    expect(monthlyWeightGoalProgress('build_muscle', 70, [
      { weightKg: 60, measuredOn: '2026-09-01' },
      { weightKg: 64, measuredOn: '2026-09-25' },
    ], '2026-09-01', '2026-09-30')?.progressPercent).toBe(40);
  });

  it('excluye datos insuficientes, metas incompatibles y retrocesos', () => {
    expect(monthlyWeightGoalProgress('general_wellness', null, [], '2026-09-01', '2026-09-30')).toBeNull();
    expect(monthlyWeightGoalProgress('lose_weight', 70, [
      { weightKg: 80, measuredOn: '2026-09-01' },
      { weightKg: 81, measuredOn: '2026-09-20' },
    ], '2026-09-01', '2026-09-30')).toBeNull();
    expect(monthlyWeightGoalProgress('gain_weight', 55, [
      { weightKg: 60, measuredOn: '2026-09-01' },
      { weightKg: 61, measuredOn: '2026-09-20' },
    ], '2026-09-01', '2026-09-30')).toBeNull();
  });
});
