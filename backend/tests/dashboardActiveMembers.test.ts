import type { Request, RequestHandler, Response as ExpressResponse } from 'express';
import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transport: vi.fn<typeof fetch>(),
  rpc: vi.fn(),
  getUser: vi.fn(),
  clientForToken: vi.fn(),
}));
vi.mock('../src/config/supabase.js', () => {
  const client = createClient('https://dashboard.invalid', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: mocks.transport },
  });
  return {
    supabaseAdmin: { from: client.from.bind(client), rpc: mocks.rpc },
    supabasePublic: { auth: { getUser: mocks.getUser } },
    createUserSupabaseClient: mocks.clientForToken,
  };
});
vi.mock('../src/config/env.js', () => ({ env: {} }));

import { memberRouter } from '../src/routes/member.routes.js';
import { verifyJWT } from '../src/middlewares/verifyJWT.js';
import { tenantContext } from '../src/middlewares/tenantContext.js';

const route = memberRouter.stack.find(layer => layer.route?.path === '/dashboard-summary')!.route!;
const handlers = [verifyJWT, tenantContext, ...route.stack.map(layer => layer.handle)] as RequestHandler[];
const gymA = 'gym-a';
const gymB = 'gym-b';
const branchA = 'branch-a';
const branchB = 'branch-b';
const makeRow = (id: number, changes = {}) => ({
  id, gym_id: gymA, default_location_id: branchA, role: 'member',
  status: 'active', account_mode: 'managed', created_at: id,
  profiles: null as null | { full_name: string }, ...changes,
});
let rows: ReturnType<typeof makeRow>[];
let urls: URL[];
let mode: 'allowed' | 'denied' | 'requires_pin' | undefined;
let role: 'member' | 'staff' | 'owner';
let actorGym: string;
let actorBranch: string;

beforeEach(() => {
  vi.resetAllMocks();
  rows = [];
  urls = [];
  mode = undefined;
  role = 'owner';
  actorGym = gymA;
  actorBranch = branchA;
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'auth-actor' } }, error: null });
  mocks.clientForToken.mockReturnValue({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: vi.fn(() => q),
        single: async () => {
          if (table === 'gym_users') {
            expect(q.eq).toHaveBeenCalledWith('profile_id', 'auth-actor');
            return { data: { id: 'actor', gym_id: actorGym, role, status: 'active', default_location_id: actorBranch }, error: null };
          }
          expect(table).toBe('gyms');
          expect(q.eq).toHaveBeenCalledWith('id', actorGym);
          return { data: { timezone: 'America/Guayaquil', status: 'active' }, error: null };
        },
        maybeSingle: async () => {
          expect(table).toBe('staff_permissions');
          expect(q.eq.mock.calls).toEqual([['gym_id', actorGym], ['staff_user_id', 'actor'], ['permission_key', 'members.view']]);
          return { data: mode ? { access_mode: mode } : null, error: null };
        },
      };
      return q;
    },
  });

  // Exercise the real Supabase client against an in-memory transport: no network or SQL.
  mocks.transport.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    urls.push(url);
    expect(url.hostname).toBe('dashboard.invalid');
    expect(url.pathname).toBe('/rest/v1/gym_users');
    const p = url.searchParams;
    const filtered = rows.filter(row => p.get('gym_id') === `eq.${row.gym_id}` && p.get('role') === `eq.${row.role}`);
    if (init?.method === 'HEAD') {
      expect(p.get('select')).toBe('id');
      expect(p.get('status')).toBe('eq.active');
      expect([...p.keys()].sort()).toEqual(['gym_id', 'role', 'select', 'status']);
      expect(new Headers(init.headers).get('prefer')).toContain('count=exact');
      return new Response(null, { headers: { 'content-range': `*/${filtered.filter(row => row.status === 'active').length}` } });
    }
    expect(init?.method).toBe('GET');
    expect(p.get('select')).toBe('id,status,profiles(full_name)');
    expect(p.get('limit')).toBe('250');
    expect(p.get('order')).toBe('created_at.desc');
    expect(p.get('status')).toBe('in.(invited,active,suspended,inactive)');
    return Response.json(filtered.sort((a, b) => b.created_at - a.created_at).slice(0, 250)
      .map(({ id, status, profiles }) => ({ id, status, profiles })));
  });
});

function request(token: string | null = null, signedIn = true) {
  return new Promise<{ activeMemberCount: number; members: Array<{ id: number; profiles: unknown }> }>((resolve, reject) => {
    const req = {
      method: 'GET',
      headers: signedIn ? { authorization: 'Bearer test-session' } : {},
      header: (name: string) => name === 'x-admin-elevation-token' ? token : undefined,
      query: { gym_id: gymB, gymId: gymB, locationId: branchB, status: 'suspended', role: 'staff' },
    } as unknown as Request;
    const res = {
      setHeader: (key: string, value: string) => {
        expect(key).toBe('Cache-Control');
        expect(value).toBe('private, no-store');
      },
      json: resolve,
    } as unknown as ExpressResponse;
    let nextIndex = 0;
    const next = (error?: unknown) => error ? reject(error) : handlers[nextIndex++]!(req, res, next);
    next();
  });
}

describe('FIT-OWNER-001: Dashboard members summary', () => {
  it('requires the same authentication and tenant middleware as GET /members', async () => {
    expect(memberRouter.stack[0]?.handle).toBe(verifyJWT);
    expect(memberRouter.stack[1]?.handle).toBe(tenantContext);
    expect(route.methods.get).toBe(true);
    await expect(request(null, false)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(urls).toHaveLength(0);
  });

  it.each([
    ['zero with an empty gym', [], 0],
    ['zero with foreign and non-member rows', [
      makeRow(1, { gym_id: gymB }), makeRow(2, { role: 'staff' }), makeRow(3, { role: 'owner' }),
      ...['invited', 'suspended', 'inactive'].map((status, i) => makeRow(i + 10, { status })),
    ], 0],
    ['one active managed member', [makeRow(1)], 1],
    ['one active portal member', [makeRow(1, { account_mode: 'portal', profiles: { full_name: 'Ana' } })], 1],
    ['251 active members', Array.from({ length: 251 }, (_, i) => makeRow(i)), 251],
    ['230 active and 40 more recent non-active members', [
      ...Array.from({ length: 230 }, (_, i) => makeRow(i)),
      ...Array.from({ length: 40 }, (_, i) => makeRow(i + 230, { status: ['invited', 'suspended', 'inactive'][i % 3] })),
    ], 230],
  ] as const)('counts exactly: %s', async (_label, expectedRows, total) => {
    rows = [...expectedRows];
    const data = await request();
    expect(data.activeMemberCount).toBe(total);
    expect(data.members.length).toBeLessThanOrEqual(250);
    expect(urls).toHaveLength(2);
    expect(urls.every(url => url.searchParams.get('gym_id') === `eq.${gymA}`)).toBe(true);
  });

  it('reads the current account status after an invitation is accepted or the account is suspended', async () => {
    const account = makeRow(1, { account_mode: 'portal', status: 'invited' });
    rows = [account];
    expect((await request()).activeMemberCount).toBe(0);
    account.status = 'active';
    expect((await request()).activeMemberCount).toBe(1);
    account.status = 'suspended';
    expect((await request()).activeMemberCount).toBe(0);
  });

  it('counts all assigned and unassigned branches, but only in the authenticated gym', async () => {
    rows = [
      makeRow(1), makeRow(2, { default_location_id: branchB, account_mode: 'portal' }),
      makeRow(3, { default_location_id: null }), makeRow(4, { gym_id: gymB, default_location_id: branchB }),
    ];
    expect((await request()).activeMemberCount).toBe(3);
    actorBranch = branchB;
    expect((await request()).activeMemberCount).toBe(3);
    actorGym = gymB;
    expect((await request()).activeMemberCount).toBe(1);
  });

  it('returns the existing names for activity without exposing directory fields', async () => {
    rows = [makeRow(1, { profiles: { full_name: 'Ana' } }), makeRow(2, { status: 'inactive' })];
    expect(await request()).toEqual({ activeMemberCount: 1, members: [{ id: 1, profiles: { full_name: 'Ana' } }] });
  });

  it.each([undefined, 'denied'] as const)('denies staff with members.view = %s', async access => {
    role = 'staff';
    mode = access;
    await expect(request()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(urls).toHaveLength(0);
  });

  it('denies a member and allows authorized staff without changing the gym scope', async () => {
    role = 'member';
    await expect(request()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(urls).toHaveLength(0);
    role = 'staff';
    mode = 'allowed';
    rows = [makeRow(1), makeRow(2, { gym_id: gymB })];
    expect((await request()).activeMemberCount).toBe(1);
  });

  it('preserves the existing single elevation for staff with members.view = requires_pin', async () => {
    role = 'staff';
    mode = 'requires_pin';
    await expect(request()).rejects.toMatchObject({ code: 'REQUIRES_ADMIN_PIN' });
    expect(urls).toHaveLength(0);
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(request('invalid')).rejects.toMatchObject({ code: 'INVALID_ADMIN_ELEVATION' });
    expect(urls).toHaveLength(0);
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    expect((await request('approved')).activeMemberCount).toBe(0);
    expect(mocks.rpc).toHaveBeenLastCalledWith('consume_admin_pin_elevation', {
      target_gym_id: gymA, target_staff_user_id: 'actor', requested_permission: 'members.view', supplied_token: 'approved',
    });
  });

  it('does not report a missing count as zero', async () => {
    mocks.transport.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(request()).rejects.toMatchObject({ code: 'ACTIVE_MEMBER_COUNT_UNAVAILABLE' });
  });
});
