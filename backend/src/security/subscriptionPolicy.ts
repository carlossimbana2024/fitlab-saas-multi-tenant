export type GymStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'suspended' | 'cancelled';

export type SubscriptionSnapshot = {
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  updatedAt: string;
};

export type SubscriptionDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: 'SUBSCRIPTION_NOT_CONFIGURED' | 'SUBSCRIPTION_READ_ONLY' | 'SUBSCRIPTION_GRACE_EXPIRED';
    };

const DAY_MS = 86_400_000;

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function decideSubscriptionWriteAccess(input: {
  gymStatus: GymStatus;
  subscription: SubscriptionSnapshot | null;
  nowMs: number;
  graceDays: number;
}): SubscriptionDecision {
  const { gymStatus, subscription, nowMs, graceDays } = input;

  if (!subscription) return { allowed: false, code: 'SUBSCRIPTION_NOT_CONFIGURED' };

  if (
    gymStatus === 'suspended'
    || gymStatus === 'cancelled'
    || subscription.status === 'suspended'
    || subscription.status === 'cancelled'
  ) {
    return { allowed: false, code: 'SUBSCRIPTION_READ_ONLY' };
  }

  if (gymStatus === 'past_due' || subscription.status === 'past_due') {
    const pastDueSince = timestamp(subscription.updatedAt);
    if (pastDueSince === null || nowMs > pastDueSince + graceDays * DAY_MS) {
      return { allowed: false, code: 'SUBSCRIPTION_GRACE_EXPIRED' };
    }
    return { allowed: true };
  }

  if (subscription.status === 'trialing') {
    const trialEnd = timestamp(subscription.trialEndsAt);
    if (trialEnd === null || nowMs > trialEnd + graceDays * DAY_MS) {
      return { allowed: false, code: 'SUBSCRIPTION_GRACE_EXPIRED' };
    }
    return { allowed: true };
  }

  return { allowed: true };
}
