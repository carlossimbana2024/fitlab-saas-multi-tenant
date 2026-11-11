import { describe, expect, it, vi } from 'vitest';
import { selectMembershipCoverage, summarizeMembershipCoverage } from '../../frontend/src/utils/membershipCoverage';
import { watchPortalDate } from '../../frontend/src/utils/currentPortalDate';

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

describe('FIT-MEMBER-018 civil date boundaries', () => {
  it.each([
    ['America/Guayaquil', '2026-11-05T05:00:00Z', '2026-11-06T05:00:00Z', '2026-11-06', 24],
    ['America/New_York', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', '2026-03-09', 23],
    ['America/New_York', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', '2026-11-02', 25],
  ])('counts civil days in %s starting %s (expiry %s, %s, %i hours)', (zone, start, expiry, endsOn, hours) => {
    const dayLength = Date.parse(expiry) - Date.parse(start);
    expect(dayLength).toBe(hours * 3_600_000);
    vi.useFakeTimers();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', new EventTarget());
    vi.setSystemTime(Date.parse(start) - 1_000);
    const data = [membership([period('2026-01-01', endsOn)])];
    const labels: string[] = [];
    const stop = watchPortalDate(today => labels.push(summarizeMembershipCoverage(data, today).label), zone);
    try {
      expect(labels).toEqual(['2 días restantes']);
      vi.advanceTimersByTime(1_000);
      expect(labels.at(-1)).toBe('1 día restante');
      vi.advanceTimersByTime(dayLength - 1_000);
      expect(labels).toHaveLength(2); // 23:59:59 before the final day.
      vi.advanceTimersByTime(1_000);
      expect(labels.at(-1)).toBe('Vence hoy');
      vi.advanceTimersByTime(86_400_000 - 1_000);
      expect(labels).toHaveLength(3); // 23:59:59 of the final day is still covered.
      vi.advanceTimersByTime(1_000);
      expect(labels).toEqual(['2 días restantes', '1 día restante', 'Vence hoy', 'Cobertura vencida']);
    } finally {
      stop(); vi.useRealTimers(); vi.unstubAllGlobals();
    }
  });

  it('shows an expired historical period even after the persisted status is updated', () => {
    const old = period('2026-11-01', '2026-11-04', 'expired');
    const refunded = period('2026-11-05', '2026-12-05', 'cancelled');
    const data = [membership([old, refunded], 'expired')];
    expect(summarizeMembershipCoverage(data, '2026-11-05')).toMatchObject({ period: old, label: 'Cobertura vencida' });
    expect(selectMembershipCoverage(data, '2026-11-05').membership).toBeUndefined();
  });

  it('does not report a countdown for missing or unparseable coverage', () => {
    expect(summarizeMembershipCoverage([], '2026-11-05')).toEqual({ label: 'Sin cobertura vigente' });
    expect(summarizeMembershipCoverage([membership([period('2026-11-01', '')])], '2026-11-05').label).toBe('Fecha de cobertura no disponible');
  });
});
