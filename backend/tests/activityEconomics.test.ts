import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { classBookingEconomics, type ClassTermsRow } from '../src/utils/classBookingEconomics.js';
import { fromSupabaseError } from '../src/utils/supabaseError.js';
import { React, MemoryRouter, renderToStaticMarkup, pageComponents, ClassBookingConditions } from './helpers/class-economics-render.js';
import { activityStateFixture } from './helpers/activity-state-fixture.js';
const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({ supabaseAdmin: db }));
import { getClassReceipt, listActivities, reserveClassForMember, reserveClassForSelf } from '../src/controllers/activity.controller.js';

const term = (overrides: Partial<ClassTermsRow> = {}): ClassTermsRow => ({
  version: 1, billing_mode: 'additional_fee', agreed_amount: 5, currency: 'USD',
  contracted_at: '2026-10-20T12:00:00Z', cancelled_at: null, evidence_state: 'verified',
  source: 'reservation', payment_evidence_id: null, ...overrides,
});
const unknown = term({ billing_mode: null, agreed_amount: null, currency: null, evidence_state: 'unknown', source: 'historical_unknown' });
describe('FIT-MEMBER-004 economic facts', () => {
  it('keeps separate versions and uses the latest without mutating the historical quote', () => {
    const old = term({ cancelled_at: '2026-10-20T13:00:00Z' });
    const current = term({ version: 2, agreed_amount: 8 });
    const result = classBookingEconomics({ status: 'reserved' }, [old, current]);
    expect(result.economic_terms?.agreed_amount).toBe(8);
    expect(result.economic_history.map(t => t.agreed_amount)).toEqual([8, 5]);
    expect(old.agreed_amount).toBe(5);
    expect(result.can_collect_payment).toBe(true);
  });
  it.each([5, 8, 10])('keeps the agreed amount %s', price => {
    expect(classBookingEconomics({ status: 'reserved' }, [term({ agreed_amount: price })]).economic_terms?.agreed_amount).toBe(price);
  });
  it('keeps included terms without requiring a currency inferred from catalog', () => {
    expect(classBookingEconomics({ status: 'reserved' }, [term({ billing_mode: 'included', agreed_amount: 0, currency: null, evidence_state: 'partial' })]))
      .toMatchObject({ payment_state: 'included', can_collect_payment: false });
  });
  it.each(['reserved','attended','cancelled','no_show'])('preserves unknown %s history without inventing a quote', status => {
    expect(classBookingEconomics({ status }, [unknown])).toMatchObject({
      payment_state: 'resolution_required', can_collect_payment: false,
      economic_terms: { agreed_amount: null, billing_mode: null, currency: null },
    });
  });
  it('keeps a confirmed old payment when original terms are unknown', () => {
    expect(classBookingEconomics({ status: 'reserved', payment_id: 'payment' }, [unknown], { amount: 8, currency: 'USD', status: 'confirmed' }))
      .toMatchObject({ payment_state: 'confirmed', can_collect_payment: false, economic_terms: { agreed_amount: null }, payment_summary: { amount: 8, currency: 'USD' } });
  });
  it('does not equate money actually charged with the agreed quote', () => {
    expect(classBookingEconomics({ status: 'attended', payment_id: 'p' }, [term()], { amount: 8, currency: 'USD', status: 'refunded' }))
      .toMatchObject({ economic_terms: { agreed_amount: 5 }, payment_summary: { amount: 8 }, payment_state: 'refunded', can_collect_payment: false });
  });
  it('does not label a missing payment record as confirmed', () => {
    expect(classBookingEconomics({ status: 'reserved', payment_id: 'p' }, [unknown]))
      .toMatchObject({ payment_state: 'registered', can_collect_payment: false });
  });
  it('maps unresolved and manipulated charges to explicit conflicts', () => {
    for (const code of ['CLASS_TERMS_RESOLUTION_REQUIRED','CLASS_PAYMENT_TERMS_MISMATCH']) {
      expect(fromSupabaseError({ message: code })).toMatchObject({ statusCode: 409, code });
    }
  });
});

let tables: Record<string, any[]>;
const scheduleId = '00000000-0000-4000-8000-000000000001';
const memberId = '00000000-0000-4000-8000-000000000002';
beforeEach(() => {
  tables = {
    extra_classes: [{ id: 'activity', gym_id: 'gym', name: 'Boxeo', is_active: true, billing_mode: 'additional_fee', price: 99, currency: 'USD', capacity: 10 }],
    gym_locations: [{ id: 'branch', gym_id: 'gym', name: 'Centro', is_active: true }],
    class_schedules: [{ id: scheduleId, gym_id: 'gym', extra_class_id: 'activity', location_id: 'branch', instructor_user_id: 'coach', starts_at: new Date(Date.now()+86400000).toISOString(), status: 'scheduled' }],
    class_bookings: [{ id: 'own', gym_id: 'gym', class_schedule_id: scheduleId, member_user_id: memberId, status: 'reserved', economic_versions: [term()] }],
    staff_permissions: [{ gym_id: 'gym', staff_user_id: 'coach', permission_key: 'classes.attendance_manage', access_mode: 'allowed' }],
  };
  db.rpc.mockReset(); db.rpc.mockImplementation(async(name:string,args:any)=>({
    data:name==='get_class_waitlist_state_backend' ? activityStateFixture(tables,args) : {},error:null,
  }));
  db.from.mockImplementation((table: string) => {
    let rows = [...(tables[table] ?? [])]; let head = false;
    const q: any = {
      select: (_fields: string, options?: { head?: boolean }) => { head=Boolean(options?.head); return q; },
      eq: (k: string,v: unknown) => { rows=rows.filter(r=>r[k]===v); return q; },
      in: (k: string,v: unknown[]) => { rows=rows.filter(r=>v.includes(r[k])); return q; },
      order: () => q, limit: () => q, gte: () => q, lte: () => q,
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: any) => Promise.resolve({ data: head ? null : rows, count: head ? rows.length : null, error: null }).then(resolve),
    }; return q;
  });
});
async function list(role='member') {
  const response = { json: vi.fn() };
  await listActivities({ query: {}, tenant: { role, gymId: 'gym', gymUserId: role==='member' ? memberId : role==='staff' ? 'coach' : 'owner' }, supabase: db } as unknown as Request, response as unknown as Response);
  return response.json.mock.calls[0]![0];
}
describe('economic contract in the real controller', () => {
  it('returns original price 5 with current catalog 99 and excludes others and other gyms', async () => {
    tables.class_bookings!.push({ ...tables.class_bookings![0], id: 'PRIVATE_OTHER', member_user_id: 'other', economic_versions: [term({ agreed_amount: 123 })] },
      { ...tables.class_bookings![0], id: 'PRIVATE_FOREIGN', gym_id: 'foreign' });
    const result = await list();
    expect(result.schedules[0]).toMatchObject({ activity: { price: 99 }, occupied: 2, myBooking: { economic_terms: { agreed_amount: 5 }, payment_state: 'pending' } });
    expect(result.bookings).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_OTHER|PRIVATE_FOREIGN|payment_evidence_id|economic_versions/);
  });
  it.each(['included','additional_fee'])('catalog mode %s does not determine an existing booking mode', async mode => {
    tables.extra_classes![0].billing_mode=mode;
    tables.class_bookings![0].economic_versions=[term({ billing_mode: mode==='included' ? 'additional_fee' : 'included', agreed_amount: mode==='included' ? 5 : 0 })];
    expect((await list()).schedules[0].myBooking.payment_state).toBe(mode==='included' ? 'pending' : 'included');
  });
  it('keeps paid old unknown bookings confirmed and does not invent terms', async () => {
    tables.class_bookings![0].economic_versions=[unknown]; tables.class_bookings![0].payment_id='p';
    tables.member_payments=[{ id:'p',gym_id:'gym',amount:8,currency:'USD',status:'confirmed' }];
    expect((await list()).schedules[0].myBooking).toMatchObject({ economic_terms: { agreed_amount:null }, payment_summary:{amount:8},payment_state:'confirmed',can_collect_payment:false });
  });
  it('returns unresolved conditions instead of current included catalog for a missing snapshot', async () => {
    tables.extra_classes![0].billing_mode='included'; tables.class_bookings![0].economic_versions=[];
    expect((await list()).schedules[0].myBooking).toMatchObject({ economic_terms:null,payment_state:'resolution_required',can_collect_payment:false });
  });
  it('exposes version history to reception and payment status alone to the assigned coach', async () => {
    tables.class_bookings![0].economic_versions=[term(),term({version:2,agreed_amount:8})];
    expect((await list('owner')).bookings[0].economic_history).toHaveLength(2);
    const coached=(await list('staff')).bookings[0];
    expect(coached.payment_state).toBe('pending');
    expect(coached).not.toHaveProperty('economic_history');
    expect(coached).not.toHaveProperty('payment_summary');
  });
  it('ignores price/currency sent by the client in reception and member booking requests', async () => {
    const response:any={status:vi.fn().mockReturnThis(),json:vi.fn()};
    const request:any={params:{id:scheduleId},tenant:{gymId:'gym',gymUserId:memberId,role:'member'},body:{memberUserId:memberId,price:0,currency:'EUR',payment:{method:'cash',amount:0,currency:'EUR'}}};
    await reserveClassForMember(request,response);
    expect(db.rpc.mock.calls[0]![0]).toBe('reserve_paid_class_backend');
    expect(db.rpc.mock.calls[0]![1]).not.toHaveProperty('amount');
    expect(JSON.stringify(db.rpc.mock.calls[0]![1])).not.toMatch(/EUR|price|amount/);
    await reserveClassForSelf(request,response);
    expect(db.rpc.mock.calls[1]![0]).toBe('reserve_member_class_backend');
    expect(Object.keys(db.rpc.mock.calls[1]![1])).toEqual(['target_gym_id','target_class_schedule_id','target_member_user_id','target_actor_gym_user_id']);
  });
  it('receipt keeps the charged amount separate from the original quote and current catalog', async () => {
    tables.class_bookings![0].id=scheduleId; tables.class_bookings![0].payment_id='p';
    tables.extra_classes![0].billing_mode='included'; tables.extra_classes![0].price=0;
    tables.member_payments=[{id:'p',gym_id:'gym',amount:8,currency:'USD',status:'confirmed',registered_by:'owner'}];
    tables.gyms=[{id:'gym',name:'Gym'}];
    tables.gym_users=[{id:memberId,gym_id:'gym',managed_full_name:'Member'},{id:'owner',gym_id:'gym',managed_full_name:'Owner'},{id:'coach',gym_id:'gym',managed_full_name:'Coach'}];
    const response:any={json:vi.fn()};
    await getClassReceipt({params:{id:scheduleId},tenant:{role:'member',gymId:'gym',gymUserId:memberId}} as unknown as Request,response);
    expect(response.json.mock.calls[0][0].receipt).toMatchObject({amount:8,economic_terms:{agreed_amount:5},activity:{billing_mode:'additional_fee'}});
  });
  it('receipt still rejects another member in the same gym', async () => {
    tables.class_bookings![0].id=scheduleId; tables.class_bookings![0].payment_id='p';
    await expect(getClassReceipt({params:{id:scheduleId},tenant:{role:'member',gymId:'gym',gymUserId:'other'}} as unknown as Request,{} as Response))
      .rejects.toMatchObject({statusCode:404});
  });
});

const {ClassCard}=pageComponents('MemberPortalPage.tsx','function classReferenceIssue','function ProgressView',['ClassCard']);
const {Roster}=pageComponents('ActivitiesPage.tsx','function Roster',undefined,['Roster']);
const render=(Component:any,props:any)=>renderToStaticMarkup(React.createElement(MemoryRouter,null,React.createElement(Component,props)));
function schedule(mode='additional_fee',price=99) {
  return {id:scheduleId,starts_at:'2026-10-22T18:00:00Z',ends_at:'2026-10-22T19:00:00Z',status:'scheduled',available:8,capacity:10,occupied:2,activity:{name:'Boxeo',billing_mode:mode,price,currency:'USD',is_active:true},location:{name:'Centro',is_active:true}};
}
const amount=(value:number)=>new Intl.NumberFormat('es-EC',{style:'currency',currency:'USD'}).format(value);
describe('member and reception rendering',()=>{
  it.each(['additional_fee','included'])('member keeps a contracted price when current catalog is %s',mode=>{
    const booking={id:'b',status:'reserved',...classBookingEconomics({status:'reserved'},[term()])};
    const html=render(ClassCard,{schedule:{...schedule(mode),myBooking:booking}});
    expect(html).toContain(amount(5)); expect(html).not.toContain(amount(99)); expect(html).toContain('Pago pendiente en recepción');
  });
  it('included booking does not become a payment obligation',()=>{
    const booking={id:'b',status:'reserved',...classBookingEconomics({status:'reserved'},[term({billing_mode:'included',agreed_amount:0})])};
    const html=render(ClassCard,{schedule:{...schedule(),myBooking:booking}});
    expect(html).toContain('Incluida en tu membresía'); expect(html).not.toContain(amount(99)); expect(html).not.toContain('Pago pendiente');
  });
  it('unknown paid booking shows actual payment and uncertainty without catalog substitution',()=>{
    const booking={id:'b',status:'reserved',payment_id:'p',...classBookingEconomics({status:'reserved',payment_id:'p'},[unknown],{amount:8,currency:'USD',status:'confirmed'})};
    const html=render(ClassCard,{schedule:{...schedule(),myBooking:booking}});
    expect(html).toContain(amount(8));expect(html).toContain('Condiciones originales no verificadas');expect(html).not.toContain(amount(99));
    expect(html).toContain('Cancela en recepción');
  });
  it('historical unknown class remains visible after deactivation',()=>{
    const s=schedule();s.activity.is_active=false;
    const html=render(ClassCard,{schedule:{...s,myBooking:{id:'b',status:'reserved',...classBookingEconomics({status:'reserved'},[unknown])}}});
    expect(html).toContain('Boxeo'); expect(html).toContain('Condiciones originales no verificadas');expect(html).not.toContain(amount(99));
  });
  it.each(['attended','no_show'])('completed participation %s never shows a new catalog quote or reserve action',status=>{
    const booking={id:'b',status,...classBookingEconomics({status},[term()])};
    const html=render(ClassCard,{schedule:{...schedule(),myBooking:booking}});
    expect(html).toContain(amount(5));expect(html).not.toContain(amount(99));expect(html).not.toContain('Reservar · pagar');
  });
  it('reception offers payment from the snapshot even if catalog is now included',()=>{
    const booking={id:'b',member:{name:'Member'},status:'reserved',member_user_id:memberId,...classBookingEconomics({status:'reserved'},[term()])};
    const html=render(Roster,{schedule:schedule('included'),bookings:[booking],canBook:true,canRegisterPayment:true});
    expect(html).toContain('Registrar pago');expect(html).toContain(amount(5));expect(html).not.toContain(amount(99));
  });
  it('reception does not offer automatic payment for unknown historical terms',()=>{
    const booking={id:'b',member:{name:'Member'},status:'reserved',...classBookingEconomics({status:'reserved'},[unknown])};
    const html=render(Roster,{schedule:schedule(),bookings:[booking],canBook:true,canRegisterPayment:true});
    expect(html).not.toContain('Registrar pago');expect(html).toContain('pendientes de resolución');
  });
  it('shows both contracting episodes including the cancelled one',()=>{
    const html=render(ClassBookingConditions,{booking:classBookingEconomics({status:'reserved'},[term({cancelled_at:'2026-10-20T13:00:00Z'}),term({version:2,agreed_amount:8})])});
    expect(html).toContain('Contratación 1');expect(html).toContain('Contratación 2');expect(html).toContain('Cancelada');expect(html).toContain(amount(5));expect(html).toContain(amount(8));
  });
});
