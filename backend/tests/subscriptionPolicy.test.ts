import { describe, expect, it } from 'vitest';
import {
  decideSubscriptionWriteAccess,
  type GymStatus,
  type SubscriptionSnapshot,
} from '../src/security/subscriptionPolicy.js';

const nowMs = Date.parse('2026-08-11T12:00:00.000Z');

function subscription(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    status: 'active',
    trialEndsAt: null,
    updatedAt: '2026-08-11T10:00:00.000Z',
    ...overrides,
  };
}

function decide(gymStatus: GymStatus, current: SubscriptionSnapshot | null, graceDays = 3) {
  return decideSubscriptionWriteAccess({ gymStatus, subscription: current, nowMs, graceDays });
}

describe('decideSubscriptionWriteAccess', () => {
  it('permite escritura para active', () => {
    expect(decide('active', subscription())).toEqual({ allowed: true });
  });

  it('permite trial vigente y su gracia controlada', () => {
    expect(decide('trial', subscription({ status: 'trialing', trialEndsAt: '2026-08-12T12:00:00.000Z' }))).toEqual({ allowed: true });
    expect(decide('trial', subscription({ status: 'trialing', trialEndsAt: '2026-08-10T12:00:00.000Z' }))).toEqual({ allowed: true });
  });

  it('bloquea trial vencido fuera de gracia o sin fecha de fin', () => {
    expect(decide('trial', subscription({ status: 'trialing', trialEndsAt: '2026-08-01T12:00:00.000Z' }))).toEqual({
      allowed: false,
      code: 'SUBSCRIPTION_GRACE_EXPIRED',
    });
    expect(decide('trial', subscription({ status: 'trialing' }))).toEqual({
      allowed: false,
      code: 'SUBSCRIPTION_GRACE_EXPIRED',
    });
  });

  it('permite past_due solo dentro del periodo de gracia', () => {
    expect(decide('past_due', subscription({ status: 'past_due', updatedAt: '2026-08-10T12:00:00.000Z' }))).toEqual({ allowed: true });
    expect(decide('past_due', subscription({ status: 'past_due', updatedAt: '2026-08-01T12:00:00.000Z' }))).toEqual({
      allowed: false,
      code: 'SUBSCRIPTION_GRACE_EXPIRED',
    });
  });

  it.each(['suspended', 'cancelled'] as const)('deja %s en modo solo lectura', (status) => {
    expect(decide(status, subscription({ status }))).toEqual({
      allowed: false,
      code: 'SUBSCRIPTION_READ_ONLY',
    });
  });

  it('falla de forma cerrada si falta la suscripción', () => {
    expect(decide('active', null)).toEqual({
      allowed: false,
      code: 'SUBSCRIPTION_NOT_CONFIGURED',
    });
  });
});
