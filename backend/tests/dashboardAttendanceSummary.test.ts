import { readFileSync } from 'node:fs';
import type { Request, RequestHandler, Response as ExpressResponse } from 'express';
import { createClient } from '@supabase/supabase-js';
import { beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ getUser: vi.fn(), userClient: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({
  supabasePublic: { auth: { getUser: auth.getUser } },
  createUserSupabaseClient: auth.userClient,
  // The read must not use a service role or a PIN elevation.
  supabaseAdmin: {},
}));
vi.mock('../src/config/env.js', () => ({ env: {} }));

import { attendanceRouter } from '../src/routes/attendance.routes.js';
import { verifyJWT } from '../src/middlewares/verifyJWT.js';
import { tenantContext } from '../src/middlewares/tenantContext.js';

const date = '2026-11-18';
const otherDate = '2026-11-19';
const gym = 'gym-a';
const branch = 'branch-a';
const row = (id: number, extra: Partial<{
  gym_id: string; location_id: string; attendance_date: string; status: string; member_user_id: string;
}> = {}) => ({
  id, gym_id: gym, location_id: branch, attendance_date: date,
  status: 'valid', member_user_id: `member-${id}`, ...extra,
});
let rows: ReturnType<typeof row>[];
let actorGym: string;
let actorBranch: string;
let actorRole: 'owner' | 'staff' | 'member';
let access: 'allowed' | 'denied' | 'requires_pin' | null;
const fetchLocal = vi.fn<typeof fetch>();

beforeEach(() => {
  rows = [];
  actorGym = gym;
  actorBranch = branch;
  actorRole = 'owner';
  access = null;
  auth.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'profile' } }, error: null });
  auth.userClient.mockReset().mockReturnValue(createClient('https://attendance.invalid', 'public-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: 'Bearer actor-session' }, fetch: fetchLocal },
  }));
  fetchLocal.mockReset().mockImplementation(async (target, init) => {
    const url = new URL(String(target));
    expect(url.origin).toBe('https://attendance.invalid');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer actor-session');
    const p = url.searchParams;
    switch (url.pathname) {
      case '/rest/v1/gym_users':
        expect(p.get('profile_id')).toBe('eq.profile');
        return Response.json({ id: 'actor', gym_id: actorGym, role: actorRole, status: 'active', default_location_id: actorBranch });
      case '/rest/v1/gyms':
        expect(p.get('id')).toBe(`eq.${actorGym}`);
        return Response.json({ timezone: 'Pacific/Galapagos', status: 'active' });
      case '/rest/v1/staff_permissions':
        expect(p.get('gym_id')).toBe(`eq.${actorGym}`);
        expect(p.get('staff_user_id')).toBe('eq.actor');
        expect(p.get('permission_key')).toBe('eq.members.view');
        return Response.json(access ? [{ access_mode: access }] : []);
      case '/rest/v1/attendances': {
        expect(init?.method).toBe('HEAD');
        expect(headers.get('prefer')).toBe('count=exact');
        expect([...p.keys()].sort()).toEqual(['attendance_date', 'gym_id', 'select', 'status']);
        expect(p.get('select')).toBe('id');
        expect(p.get('gym_id')).toBe(`eq.${actorGym}`);
        expect(p.get('status')).toBe('eq.valid');
        const visible = rows.filter(item => p.get('gym_id') === `eq.${item.gym_id}`
          && p.get('attendance_date') === `eq.${item.attendance_date}` && item.status === 'valid');
        return new Response(null, { headers: { 'content-range': `*/${visible.length}` } });
      }
      default:
        throw Error(`Unexpected URL ${url.pathname}`);
    }
  });
});

const layer = attendanceRouter.stack.find(item => item.route?.path === '/dashboard-summary')!.route!;
const handlers = [verifyJWT, tenantContext, ...layer.stack.map(item => item.handle)] as RequestHandler[];
const attendanceCalls = () => fetchLocal.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/rest/v1/attendances');

function request(query: Record<string, unknown> = { date }, signedIn = true) {
  return new Promise<{ validTodayCount: number }>((resolve, reject) => {
    const req = {
      query, method: 'GET', headers: signedIn ? { authorization: 'Bearer actor-session' } : {},
      header: () => 'existing-pin-token',
    } as unknown as Request;
    const res = {
      setHeader: (name: string, value: string) => expect([name, value]).toEqual(['Cache-Control', 'private, no-store']),
      json: resolve,
    } as unknown as ExpressResponse;
    let index = 0;
    const next = (error?: unknown) => error ? reject(error) : handlers[index++]!(req, res, next);
    next();
  });
}

it.each([[0, 0], [1, 0], [200, 0], [201, 0], [500, 0], [501, 0], [200, 5], [0, 50]])(
  'counts %i valid rows with %i later voided rows, without paging',
  async (valid, voided) => {
    rows = [
      ...Array.from({ length: voided }, (_, i) => row(valid + i, { status: 'voided' })),
      ...Array.from({ length: valid }, (_, i) => row(i)),
    ];
    expect(await request()).toEqual({ validTodayCount: valid });
    expect(attendanceCalls()).toHaveLength(1);
  },
);

it('combines A+B, ignores tenant and branch from the browser, and honors only the requested civil day', async () => {
  rows = [
    row(1), row(2, { location_id: 'branch-b' }), row(3, { location_id: 'branch-b' }),
    row(4, { attendance_date: otherDate }), row(5, { gym_id: 'gym-b' }),
  ];
  expect(await request({ date, gym_id: 'gym-b', gymId: 'gym-b', locationId: branch })).toEqual({ validTodayCount: 3 });
  actorBranch = 'branch-b';
  expect(await request()).toEqual({ validTodayCount: 3 });
  expect(await request({ date: otherDate })).toEqual({ validTodayCount: 1 });
  actorGym = 'gym-b';
  expect(await request()).toEqual({ validTodayCount: 1 });
});

it.each([undefined, '2026-02-30', '2026-11-18T05:00:00Z', [date, otherDate]])('rejects malformed date %j', async value => {
  await expect(request({ date: value })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_ATTENDANCE_FILTERS' });
  expect(attendanceCalls()).toHaveLength(0);
});

it('uses router authentication and tenant middleware and denies unauthenticated reads', async () => {
  expect(attendanceRouter.stack.slice(0, 2).map(item => item.handle)).toEqual([verifyJWT, tenantContext]);
  expect(layer.methods.get).toBe(true);
  await expect(request({ date }, false)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  expect(fetchLocal).not.toHaveBeenCalled();
});

it.each([null, 'denied', 'requires_pin'] as const)('does not report a partial total for staff access %s', async mode => {
  actorRole = 'staff';
  access = mode;
  await expect(request()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(attendanceCalls()).toHaveLength(0);
});

it('allows staff with direct members.view; a member cannot request the gym-wide KPI', async () => {
  actorRole = 'staff';
  access = 'allowed';
  rows = [row(1), row(2, { location_id: 'branch-b' })];
  expect(await request()).toEqual({ validTodayCount: 2 });
  actorRole = 'member';
  await expect(request()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(attendanceCalls()).toHaveLength(1);
});

it('counts only the valid check-in among several attempts by one member, keeping the existing unique index', async () => {
  rows = [row(1), ...[2, 3].map(id => row(id, { status: 'voided', member_user_id: 'member-1' }))];
  expect(await request()).toEqual({ validTodayCount: 1 });
  const schema = readFileSync(new URL('../../supabase/migrations/0005_attendance_classes_streaks.sql', import.meta.url), 'utf8');
  expect(schema).toMatch(/create unique index attendances_one_valid_per_day_idx\s+on public\.attendances\(member_user_id, attendance_date\)\s+where status = 'valid';/);
});

it.each([
  [200, 'ATTENDANCE_COUNT_UNAVAILABLE'],
  [403, 'DATABASE_OPERATION_FAILED'],
] as const)('ignores neither missing count nor upstream failure (HTTP %i)', async (status, code) => {
  const transport = fetchLocal.getMockImplementation()!;
  fetchLocal.mockImplementation((url, init) => init?.method === 'HEAD'
    ? Promise.resolve(new Response(null, { status }))
    : transport(url, init));
  await expect(request()).rejects.toMatchObject({ code });
});
