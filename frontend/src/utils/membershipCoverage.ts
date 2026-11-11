export type CoveragePeriod = { starts_on: string; ends_on: string; status: string };
type MembershipWithPeriods = { status: string; membership_periods?: CoveragePeriod[] };
type CoverageSelection<T> = { membership?: T; period?: CoveragePeriod };

export function selectMembershipCoverage<T extends MembershipWithPeriods>(memberships: T[], today: string): CoverageSelection<T> {
  const active = memberships.filter((membership) => membership.status === 'active');
  const candidates = active.flatMap((membership) => (membership.membership_periods ?? [])
    .filter((period) => period.status === 'active')
    .map((period) => ({ membership, period })));
  const current = candidates.filter(({ period }) => period.starts_on <= today && period.ends_on >= today)
    .sort((a, b) => b.period.ends_on.localeCompare(a.period.ends_on))[0];
  if (current) return current;
  const upcoming = candidates.filter(({ period }) => period.starts_on > today)
    .sort((a, b) => a.period.starts_on.localeCompare(b.period.starts_on))[0];
  if (upcoming) return upcoming;
  const latest = candidates.sort((a, b) => b.period.ends_on.localeCompare(a.period.ends_on))[0];
  return latest ?? { membership: active[0] };
}

/** Display only. Inactive memberships must not be passed to access/booking logic. */
export function summarizeMembershipCoverage<T extends MembershipWithPeriods>(memberships: T[], today: string): CoverageSelection<T> & { label: string; notice?: string } {
  const selected = selectMembershipCoverage(memberships, today);
  const membership = selected.membership ?? memberships.find(m => m.status === 'expired' || m.status === 'paused');
  if (membership?.status === 'paused') return { membership, label: 'Membresía pausada' };

  const period = selected.period ?? membership?.membership_periods
    ?.filter(p => (p.status === 'active' || p.status === 'expired') && p.ends_on < today)
    .sort((a, b) => b.ends_on.localeCompare(a.ends_on))[0];
  if (!period) return { membership, label: membership?.status === 'expired' ? 'Cobertura vencida' : 'Sin cobertura vigente' };

  // UTC encodes the civil date labels as day numbers, not local instants.
  // This subtracts calendar days even when the gym day lasts 23 or 25 hours.
  const starts = Date.parse(`${period.starts_on}T00:00:00Z`);
  const ends = Date.parse(`${period.ends_on}T00:00:00Z`);
  const current = Date.parse(`${today}T00:00:00Z`);
  if (![starts, ends, current].every(Number.isFinite) || starts > ends) return { membership, label: 'Fecha de cobertura no disponible' };
  if (membership?.status === 'expired' || ends < current) return { membership, period, label: 'Cobertura vencida' };
  if (starts > current) return { membership, period, label: `Comienza el ${period.starts_on}` };

  const remaining = (ends - current) / 86_400_000;
  if (remaining === 0) return { membership, period, label: 'Vence hoy', notice: 'Tu membresía vence hoy.' };
  const days = remaining === 1 ? '1 día' : `${remaining} días`;
  return { membership, period, label: `${days} restante${remaining === 1 ? '' : 's'}`, notice: remaining <= 5 ? `Tu membresía vence en ${days}.` : undefined };
}
