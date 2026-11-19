import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, RequestHandler, Response as ExpressResponse } from 'express';
import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { localMidnightAsUtc } from '../src/utils/gymDate.js';

const mocks = vi.hoisted(() => ({
  transport: vi.fn<typeof fetch>(),
  getUser: vi.fn(),
  userClient: vi.fn(),
}));
vi.mock('../src/config/env.js', () => ({ env: {} }));
vi.mock('../src/config/supabase.js', () => ({
  supabaseAdmin: createClient('https://dashboard-income.invalid', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: mocks.transport },
  }),
  supabasePublic: { auth: { getUser: mocks.getUser } },
  createUserSupabaseClient: mocks.userClient,
}));

import { paymentRouter } from '../src/routes/payment.routes.js';
import { verifyJWT } from '../src/middlewares/verifyJWT.js';
import { tenantContext } from '../src/middlewares/tenantContext.js';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');
const layer = paymentRouter.stack.find(item => item.route?.path === '/dashboard-summary')!.route!;
const handlers = [verifyJWT, tenantContext, ...layer.stack.map(item => item.handle)] as RequestHandler[];

const zero = { amount: 0, count: 0 };
const mixed = {
  month: '2027-01',
  currencies: [
    { currency: 'EUR', amount: 4.56, count: 1, categories: { memberships: zero, stockSales: zero, activities: { amount: 4.56, count: 1 }, other: zero } },
    { currency: 'USD', amount: 5556.91, count: 5003, categories: {
      memberships: { amount: 2.35, count: 1 }, stockSales: { amount: 3.45, count: 1 },
      activities: zero, other: { amount: 5551.11, count: 5001 },
    } },
  ],
};
let actorGym: string;
let role: 'owner' | 'staff' | 'member';
let mode: 'allowed' | 'denied' | 'requires_pin' | null;

beforeEach(() => {
  actorGym = 'gym-a';
  role = 'owner';
  mode = null;
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'auth-actor' } }, error: null });
  mocks.userClient.mockReset().mockReturnValue({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: vi.fn(() => q),
        single: async () => {
          if (table === 'gym_users') {
            expect(q.eq).toHaveBeenCalledWith('profile_id', 'auth-actor');
            return { data: { id: 'actor', gym_id: actorGym, role, status: 'active', default_location_id: 'branch-a' }, error: null };
          }
          expect(table).toBe('gyms');
          expect(q.eq).toHaveBeenCalledWith('id', actorGym);
          return { data: { timezone: 'America/Guayaquil', status: 'active' }, error: null };
        },
        maybeSingle: async () => {
          expect(table).toBe('staff_permissions');
          expect(q.eq.mock.calls).toEqual([['gym_id', actorGym], ['staff_user_id', 'actor'], ['permission_key', 'finances.view']]);
          return { data: mode ? { access_mode: mode } : null, error: null };
        },
      };
      return q;
    },
  });
  mocks.transport.mockReset().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(url.href).toBe('https://dashboard-income.invalid/rest/v1/rpc/get_owner_dashboard_income_backend');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ target_gym_id: actorGym });
    return Response.json(mixed);
  });
});

function run({ signedIn = true, pin }: { signedIn?: boolean; pin?: string } = {}) {
  return new Promise<unknown>((ok, fail) => {
    const request = {
      headers: signedIn ? { authorization: 'Bearer test-session' } : {},
      header: (key: string) => key === 'x-admin-elevation-token' ? pin : undefined,
      method: 'GET',
      query: { gym_id: 'foreign', target_gym_id: 'foreign', locationId: 'foreign-branch', reference_at: '2035-01-01' },
    } as unknown as Request;
    const response = { json: ok } as unknown as ExpressResponse;
    let index = 0;
    const next = (error?: unknown) => error ? fail(error) : handlers[index++]!(request, response, next);
    next();
  });
}

describe('FIT-OWNER-003: ingresos mensuales del dashboard', () => {
  it('makes one RPC for the session gym and forwards the exact legacy UI contract', async () => {
    expect(await run()).toEqual({ summary: mixed });
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    actorGym = 'gym-b';
    expect(await run()).toEqual({ summary: mixed });
    expect(mocks.transport).toHaveBeenCalledTimes(2);
  });

  it('keeps the gym currency and zero categories when the database finds no payments', async () => {
    const summary = {
      month: '2027-01',
      currencies: [{ currency: 'CAD', ...zero, categories: { memberships: zero, stockSales: zero, activities: zero, other: zero } }],
    };
    mocks.transport.mockResolvedValueOnce(Response.json(summary));
    expect(await run()).toEqual({ summary });
  });

  it('does not turn a missing gym or failure into a zero total or a paginated fallback', async () => {
    mocks.transport.mockResolvedValueOnce(Response.json(null));
    await expect(run()).rejects.toMatchObject({ code: 'GYM_NOT_FOUND' });
    mocks.transport.mockResolvedValueOnce(Response.json({ code: 'PGRST202', message: 'RPC unavailable' }, { status: 404 }));
    await expect(run()).rejects.toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
    expect(mocks.transport).toHaveBeenCalledTimes(2);
  });

  it.each([null, 'denied', 'requires_pin'] as const)('keeps the financial permission for staff in mode %s', async value => {
    role = 'staff';
    mode = value;
    await expect(run()).rejects.toMatchObject({ code: value === 'requires_pin' ? 'REQUIRES_ADMIN_PIN' : 'PERMISSION_DENIED' });
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('allows authorized staff and rejects a member or unauthenticated visitor before querying income', async () => {
    role = 'staff';
    mode = 'allowed';
    expect(await run()).toEqual({ summary: mixed });
    role = 'member';
    await expect(run()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(run({ signedIn: false })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(mocks.transport).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing verified PIN elevation, then requests exactly one snapshot', async () => {
    role = 'staff';
    mode = 'requires_pin';
    const aggregate = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/rpc/consume_admin_pin_elevation')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          target_gym_id: actorGym, target_staff_user_id: 'actor', requested_permission: 'finances.view', supplied_token: 'test-pin',
        });
        return Response.json(true);
      }
      return aggregate(input, init);
    });
    expect(await run({ pin: 'test-pin' })).toEqual({ summary: mixed });
    expect(mocks.transport).toHaveBeenCalledTimes(2);
  });

  it('preserves the established civil-month bounds (also exercised against SQL fixtures)', () => {
    expect(localMidnightAsUtc('2026-09-01', 'America/Guayaquil')).toBe('2026-09-01T05:00:00.000Z');
    expect(localMidnightAsUtc('2026-09-01', 'Europe/Madrid')).toBe('2026-08-31T22:00:00.000Z');
    expect(localMidnightAsUtc('2027-03-01', 'America/New_York')).toBe('2027-03-01T05:00:00.000Z');
    expect(localMidnightAsUtc('2027-04-01', 'America/New_York')).toBe('2027-04-01T04:00:00.000Z');
  });

  it('keeps the list endpoint and the Dashboard query, with route-level auth, tenant and finances.view', () => {
    const controller = source('backend/src/controllers/payment.controller.ts');
    const routes = source('backend/src/routes/payment.routes.ts');
    expect(paymentRouter.stack.some(item => item.handle === verifyJWT)).toBe(true);
    expect(paymentRouter.stack.some(item => item.handle === tenantContext)).toBe(true);
    expect(controller).toContain(".eq('gym_id', request.tenant!.gymId).not('membership_id', 'is', null)");
    expect(routes).toContain("paymentRouter.get('/dashboard-summary', checkPermission('finances.view')");
    expect(source('frontend/src/pages/DashboardPage.tsx')).toContain("'/member-payments/dashboard-summary'");
  });
});
