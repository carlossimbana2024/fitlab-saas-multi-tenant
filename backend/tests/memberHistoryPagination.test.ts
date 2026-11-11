import { beforeEach, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';

const transport = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('../src/config/supabase.js', () => ({
  supabaseAdmin: createClient('https://history.invalid', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport },
  }),
}));
import { listMemberClassHistory } from '../src/controllers/memberClassHistory.controller.js';
import { getMyMembershipPayments, listMyMembershipPaymentRequests } from '../src/controllers/membershipPaymentRequest.controller.js';
import { listMyPayments } from '../src/controllers/payment.controller.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const scope = { gym_id: 'gym-a', member_user_id: 'member-a' };
const tenant = { gymId: scope.gym_id, gymUserId: scope.member_user_id, role: 'member' };
const window = { from: '2020-11-01T05:00:00.000Z', to: '2020-12-01T05:00:00.000Z' };
const time = '2020-11-20T12:00:00.123456Z';
type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let requests: URL[];

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// The real Supabase client serializes the production query. This local transport
// exercises the relevant REST filters and limits against intentionally noisy data.
beforeEach(() => {
  tables = {}; requests = [];
  transport.mockReset().mockImplementation(async (input, init) => {
    const url = new URL(String(input)); requests.push(url);
    expect(url.hostname).toBe('history.invalid');
    expect(init?.method).toBe('GET');
    const table = url.pathname.split('/').at(-1)!;
    const params = url.searchParams;
    let rows = structuredClone(tables[table] ?? []);
    if (table === 'class_schedules') {
      for (const row of rows) {
        for (const alias of ['bookings', 'waitlist']) {
          row[alias] = row[alias].filter((item: Row) => params.get(`${alias}.gym_id`) === `eq.${item.gym_id}`
            && params.get(`${alias}.member_user_id`) === `eq.${item.member_user_id}`
            && (alias !== 'waitlist' || params.get('waitlist.status')?.slice(4, -1).split(',').includes(item.status)));
        }
      }
    }
    for (const [key, value] of params) {
      if (key === 'or') {
        if (value === '(bookings.not.is.null,waitlist.not.is.null)') rows = rows.filter(r => r.bookings.length || r.waitlist.length);
        else if (value.startsWith('(starts_at.lte.')) {
          const until = value.slice('(starts_at.lte.'.length, value.indexOf(','));
          rows = rows.filter(r => Date.parse(r.starts_at) <= Date.parse(until) || r.status !== 'scheduled');
        } else {
          const match = /^\((\w+)\.(lt|gt)\.([^,]+),and\(\1\.eq\.\3,id\.\2\.([\w-]+)\)\)$/.exec(value);
          expect(match, value).not.toBeNull();
          const [, field, op, at, cursorId] = match!;
          rows = rows.filter(r => (compare(r[field!], at!) || compare(r.id, cursorId!)) * (op === 'gt' ? 1 : -1) > 0);
        }
      } else if (key !== 'select' && key !== 'order' && key !== 'limit' && !key.includes('.')) {
        if (value === 'is.null') rows = rows.filter(r => r[key] == null);
        else if (value === 'not.is.null') rows = rows.filter(r => r[key] != null);
        else if (value.startsWith('eq.')) rows = rows.filter(r => String(r[key]) === value.slice(3));
        else if (value.startsWith('neq.')) rows = rows.filter(r => r[key] !== value.slice(4));
        else if (value.startsWith('gte.')) rows = rows.filter(r => Date.parse(r[key]) >= Date.parse(value.slice(4)));
        else if (value.startsWith('lt.')) rows = rows.filter(r => Date.parse(r[key]) < Date.parse(value.slice(3)));
        else if (value.startsWith('gt.')) rows = rows.filter(r => Number(r[key]) > Number(value.slice(3)));
        else if (value.startsWith('in.(')) rows = rows.filter(r => value.slice(4,-1).split(',').includes(r[key]));
        else throw Error(`Unexpected filter ${key}: ${value}`);
      }
    }
    const order = params.get('order')?.split(',').map(item => item.split('.')) ?? [];
    rows.sort((a, b) => order.reduce((result, [field, direction]) => result || compare(a[field!], b[field!]) * (direction === 'desc' ? -1 : 1), 0));
    if (params.has('limit')) rows = rows.slice(0, Number(params.get('limit')));
    return Response.json(rows);
  });
});

async function call(handler: (req: Request, res: Response) => Promise<unknown>, query: object, role = 'member') {
  const response = { setHeader: vi.fn(), json: vi.fn() };
  await handler({ tenant: { ...tenant, role }, query } as unknown as Request, response as unknown as Response);
  expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  return response.json.mock.calls[0]![0];
}

async function walk(handler: Parameters<typeof call>[0], query: object, field = 'items') {
  let cursor: string | undefined;
  const ids = new Set<string>();
  const rows: Row[] = [];
  do {
    const page = await call(handler, { ...query, cursor });
    expect(page[field].length).toBeLessThanOrEqual(25);
    if (page.nextCursor) expect(page[field]).toHaveLength(25);
    for (const row of page[field]) { expect(ids.has(row.id)).toBe(false); ids.add(row.id); rows.push(row); }
    if (rows.length > 1000) throw Error('Paging did not terminate');
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

const session = (n: number, overrides: Row = {}) => ({
  id: id(n), gym_id: scope.gym_id, starts_at: time, ends_at: '2020-11-20T13:00:00Z', status: 'scheduled',
  activity: { name: 'Actividad anterior', is_active: false }, location: { name: 'Antigua', is_active: false, timezone: 'America/Guayaquil' },
  instructor: { managed_full_name: 'Coach', profiles: { full_name: 'Ana' } },
  bookings: [{ ...scope, id: id(n + 10000), status: ['reserved', 'attended', 'cancelled', 'no_show'][n % 4] }], waitlist: [],
  ...overrides,
});

it('classes: own relations and civil month are selected before the limit; ties stay stable across 552 sessions', async () => {
  const own = Array.from({ length: 552 }, (_, i) => session(1000 + i));
  tables.class_schedules = [
    ...own.toReversed(),
    ...Array.from({ length: 520 }, (_, i) => session(i, { starts_at: '2020-11-01T05:00:00.000Z', bookings: [{ ...scope, member_user_id: 'someone-else' }] })),
    session(801, { gym_id: 'foreign' }), session(802, { starts_at: window.to }),
    session(803, { starts_at: '2020-11-01T04:59:59.999Z' }),
    session(804, { bookings: [], waitlist: [{ ...scope, status: 'expired' }] }),
    session(805, { bookings: [], waitlist: [{ ...scope, status: 'waiting' }, { ...scope, status: 'offered', member_user_id: 'foreign' }] }),
  ];
  const rows = await walk(listMemberClassHistory, window);
  expect(rows.map(r => r.id)).toEqual([id(805), ...own.map(r => r.id)]);
  expect(rows[0]!.myWaitlist).toMatchObject({ status: 'waiting' });
  expect(new Set(rows.slice(1).map(r => r.myBooking.status))).toEqual(new Set(['reserved', 'attended', 'cancelled', 'no_show']));
  expect(requests[0]!.searchParams.get('limit')).toBe('26');
  expect(requests[1]!.searchParams.getAll('or').at(-1)).toContain(time);
  expect(requests.every(url => url.pathname.endsWith('/class_schedules'))).toBe(true);
  const previous = await walk(listMemberClassHistory, { from: '2020-10-01T05:00:00Z', to: window.from });
  expect(previous.map(r => r.id)).toEqual([id(803)]);
});

it('classes: retains inactive references, cancelled future session, and economic terms with scoped payment evidence', async () => {
  const activeWindow = { from: '2099-11-01T05:00:00Z', to: '2099-12-01T05:00:00Z' };
  const starts_at = '2099-11-20T12:00:00Z';
  const terms = { version: 1, billing_mode: 'additional_fee', agreed_amount: 20, currency: 'USD', contracted_at: time, cancelled_at: time, evidence_state: 'verified', source: 'reservation', payment_evidence_id: id(72) };
  tables.class_schedules = [session(7, { starts_at, status: 'cancelled', bookings: [{ ...scope, id: id(80), status: 'cancelled', economic_versions: [terms] }] }), session(8, { starts_at })];
  tables.member_payments = [{ ...scope, id: id(72), amount: 20, currency: 'USD', status: 'refunded' }, { ...scope, id: id(72), amount: 900, status: 'confirmed', member_user_id: 'foreign' }];
  const rows = await walk(listMemberClassHistory, activeWindow);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: id(7), activity: { is_active: false }, location: { is_active: false }, instructor: { name: 'Ana' },
    myBooking: { economic_terms: { agreed_amount: 20, currency: 'USD' }, payment_state: 'refunded', payment_summary: { amount: 20 } } });
  expect(rows[0]!.myBooking.economic_terms).not.toHaveProperty('payment_evidence_id');
});

it('payments: membership and other histories stay disjoint; 133 receipts, tied timestamps and multi-page state filters', async () => {
  const payment = (n: number, overrides = {}) => ({ ...scope, id: id(n), membership_id: id(800), paid_at: time, receipt_number: n, receipt_verification_token: id(n + 900), status: ['confirmed','voided','refunded','pending','failed'][n % 5], ...overrides });
  const own = Array.from({ length: 133 }, (_, i) => payment(i));
  tables.member_payments = [...own, payment(501, { membership_id: null }), payment(502, { gym_id: 'foreign' }), payment(503, { member_user_id: 'another' })];
  const all = await walk(listMyPayments, { kind: 'membership' }, 'payments');
  expect(all).toEqual(own.toReversed());
  const filtered = await walk(listMyPayments, { kind: 'membership', status: 'confirmed' }, 'payments');
  expect(filtered).toEqual(all.filter(p => p.status === 'confirmed'));
  expect(filtered.length).toBeGreaterThan(25);
  expect((await walk(listMyPayments, { kind: 'other' }, 'payments')).map(p => p.id)).toEqual([id(501)]);
});

it('requests: drafts and foreign rows never consume slots; includes closed states and keeps the pending request independent', async () => {
  const row = (n: number, status: string, overrides = {}) => ({ ...scope, id: id(n), status, created_at: time, ...overrides });
  const own = [row(0, 'pending'), ...Array.from({ length: 120 }, (_, i) => row(i + 1, ['approved', 'rejected', 'cancelled'][i % 3]!))];
  tables.membership_payment_requests = [...own, ...Array.from({ length: 110 }, (_, i) => row(200 + i, 'draft')), row(400, 'approved', { gym_id: 'foreign' }), row(401, 'approved', { member_user_id: 'foreign' })];
  expect(await walk(listMyMembershipPaymentRequests, {})).toEqual(own.toReversed());
  expect(await walk(listMyMembershipPaymentRequests, { status: 'rejected' })).toEqual(own.toReversed().filter(r => r.status === 'rejected'));
  tables.gyms = [{ id: scope.gym_id, name: 'Gym', timezone: 'America/Guayaquil' }];
  // Supabase's single-object response for the one open row and gym details.
  const fetch = transport.getMockImplementation()!;
  transport.mockImplementation(async (input, init) => {
    const result = await fetch(input, init);
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/gyms')) return Response.json((await result.json())[0]);
    return result;
  });
  const start = requests.length;
  expect(await call(getMyMembershipPayments, { view: 'summary' })).toMatchObject({ activeRequest: own[0] });
  expect(requests.slice(start).some(url => url.pathname.endsWith('/member_payments'))).toBe(false);
});

it('validates the role, cursor and filters before querying; a database error is not an empty page', async () => {
  await expect(call(listMemberClassHistory, window, 'staff')).rejects.toMatchObject({ statusCode: 403 });
  await expect(call(listMemberClassHistory, { ...window, from: '2020-01-01T00:00:00Z' })).rejects.toMatchObject({ statusCode: 400 });
  await expect(call(listMyPayments, { kind: 'membership', cursor: 'a' })).rejects.toMatchObject({ statusCode: 400 });
  await expect(call(listMyMembershipPaymentRequests, { status: 'draft' })).rejects.toMatchObject({ statusCode: 400 });
  expect(transport).not.toHaveBeenCalled();
  transport.mockResolvedValueOnce(Response.json({ message: 'history unavailable', code: 'XX000' }, { status: 500 }));
  await expect(call(listMyPayments, { kind: 'membership' })).rejects.toThrow();
});
