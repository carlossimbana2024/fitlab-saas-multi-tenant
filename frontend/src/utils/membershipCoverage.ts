export type CoveragePeriod = { starts_on: string; ends_on: string; status: string };

export function selectMembershipCoverage<T extends { status: string; membership_periods?: CoveragePeriod[] }>(memberships: T[], today: string): { membership?: T; period?: CoveragePeriod } {
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
