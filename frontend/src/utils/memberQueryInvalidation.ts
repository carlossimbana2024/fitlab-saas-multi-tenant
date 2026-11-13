import type { QueryClient, QueryKey } from '@tanstack/react-query';

export type MemberQueryContext = { gymId?: string; memberId?: string };
export type MemberChange = 'weight' | 'fitness' | 'privacy' | 'identity' | 'social' | 'reaction' | 'attendance' | 'classes' | 'paymentRequest' | 'paymentHistory' | 'friendPreference' | 'friendAction' | 'trainingAction' | 'trainingPreference';
const dependencies: Record<MemberChange, string[]> = {
  weight: ['my-progress', 'member-social-profile', 'member-community', 'member-community-rankings'],
  fitness: ['my-fitness-profile', 'my-progress', 'member-social-profile', 'member-community', 'member-community-rankings'],
  privacy: ['my-fitness-profile', 'member-social-profile', 'member-community', 'member-community-rankings', 'member-friendship', 'member-friends', 'member-training-social'],
  identity: ['member-social-profile', 'member-community', 'member-community-rankings'],
  social: ['member-social-profile', 'member-community'],
  reaction: ['member-social-profile', 'member-community'],
  attendance: ['my-attendances', 'my-personal-streaks', 'my-weekly-progress', 'my-progress', 'member-social-profile', 'member-community', 'member-community-rankings', 'loyalty-engagement', 'member-training-social'],
  classes: ['my-activities'],
  paymentRequest: ['my-membership-payments', 'my-payment-requests-history', 'my-payments-history'],
  paymentHistory: ['my-payment-requests-history', 'my-payments-history'],
  friendPreference: ['member-friends', 'member-friendship'],
  friendAction: ['member-friends', 'member-friendship', 'member-training-social', 'loyalty-engagement'],
  trainingAction: ['member-training-social', 'loyalty-engagement'],
  trainingPreference: ['member-training-social'],
};

function belongsToMember(key: QueryKey, context: MemberQueryContext) {
  switch (key[0]) {
    case 'member-community': case 'member-community-rankings': case 'my-progress': case 'my-personal-streaks': case 'loyalty-engagement':
      return key[1] === context.gymId && key[2] === context.memberId;
    case 'my-activities': return key[4] === context.gymId && (key[1] !== 'history' || key[5] === context.memberId);
    case 'my-weekly-progress': return key[3] === context.gymId;
    case 'my-membership-payments': return key[1] === context.memberId;
    case 'my-payment-requests-history': case 'my-payments-history':
      return key[1] === context.gymId && key[2] === context.memberId;
    // Personal legacy keys are isolated by AuthProvider's session cache lifecycle.
    default: return true;
  }
}

/** Run after confirmed writes only; never invalidate unrelated portal resources. */
export async function refreshMemberQueries(client: QueryClient, context: MemberQueryContext, change: MemberChange) {
  if (!context.gymId || !context.memberId) return;
  const populationChanged = ['weight', 'fitness', 'privacy', 'identity', 'attendance'].includes(change);
  await Promise.all(dependencies[change].map(async resource => {
    const filters = { queryKey: [resource], predicate: (query: { queryKey: QueryKey }) => belongsToMember(query.queryKey, context) };
    if (resource === 'member-community' && populationChanged) {
      // Discard cursor pages (including an in-flight next page) before loading anew.
      await client.cancelQueries(filters);
      await client.resetQueries(filters);
    } else {
      await client.invalidateQueries(filters);
    }
  }));
}

export function classConflictNeedsRefresh(error: unknown) {
  const failure = error as { response?: { status?: number; data?: { error?: { code?: string } } } };
  return failure?.response?.status === 409 && [
    'CLASS_CAPACITY_REACHED', 'CLASS_WAITLIST_NOT_NEEDED', 'CLASS_WAITLIST_OFFER_EXPIRED',
    'CLASS_WAITLIST_OFFER_UNAVAILABLE', 'CLASS_WAITLIST_OFFER_ACCEPT_REQUIRED', 'CLASS_WAITLIST_PRIORITY_REQUIRED',
  ].includes(failure.response.data?.error?.code ?? '');
}
