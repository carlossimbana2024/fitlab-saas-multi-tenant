import { describe, expect, it } from 'vitest';
import { selectMembershipCoverage } from '../../frontend/src/utils/membershipCoverage';

const membership = (periods: Array<{ starts_on: string; ends_on: string; status: string }>, status = 'active') => ({ status, membership_periods: periods });
const period = (starts_on: string, ends_on: string, status = 'active') => ({ starts_on, ends_on, status });

describe('selección de cobertura para el miembro', () => {
  it('elige la renovación vigente aunque la API devuelva antes el período vencido', () => {
    const data = [membership([
      period('2026-07-21', '2026-08-20'),
      period('2026-08-27', '2026-09-26'),
    ])];
    expect(selectMembershipCoverage(data, '2026-09-17').period?.ends_on).toBe('2026-09-26');
  });

  it('elige la próxima cobertura cuando hay un intervalo sin vigencia', () => {
    const data = [membership([period('2026-08-01', '2026-08-31'), period('2026-10-01', '2026-10-31')])];
    expect(selectMembershipCoverage(data, '2026-09-15').period?.starts_on).toBe('2026-10-01');
  });

  it('muestra el último vencimiento si no hay una cobertura actual ni futura', () => {
    const data = [membership([period('2026-07-01', '2026-07-31'), period('2026-08-01', '2026-08-31')])];
    expect(selectMembershipCoverage(data, '2026-09-15').period?.ends_on).toBe('2026-08-31');
  });

  it('ignora las membresías y períodos cancelados', () => {
    const data = [membership([period('2026-09-01', '2026-09-30')], 'cancelled'), membership([period('2026-09-01', '2026-09-30', 'cancelled')])];
    expect(selectMembershipCoverage(data, '2026-09-15').period).toBeUndefined();
  });
});
