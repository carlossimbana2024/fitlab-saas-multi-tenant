import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({ supabaseAdmin: db }));
import { acceptClassWaitlistOffer, joinClassWaitlist, leaveClassWaitlist } from '../src/controllers/activity.controller.js';
import { fromSupabaseError } from '../src/utils/supabaseError.js';

const id = '00000000-0000-4000-8000-000000000001';
const booking = '00000000-0000-4000-8000-000000000002';
const server_time = '2026-10-26T12:00:00Z';
const request = (body: any = {}) => ({ params: { id }, tenant: { gymId: 'trusted-gym', gymUserId: 'trusted-member', role: 'member' }, body } as any);
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() } as any);
beforeEach(() => db.rpc.mockReset());

describe('FIT-MEMBER-005 waitlist API delegates exclusively to SQL', () => {
  it('join returns the real SQL FIFO position and ignores spoofed tenant/member/price', async () => {
    db.rpc.mockResolvedValue({ data: [{ waitlist_id: id, waitlist_position: 7 }], error: null });
    const res = response();
    await joinClassWaitlist(request({ gymId: 'foreign', memberUserId: 'other', price: 0 }), res);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('join_class_waitlist_backend', {
      target_gym_id: 'trusted-gym', target_class_schedule_id: id,
      target_member_user_id: 'trusted-member', target_actor_gym_user_id: 'trusted-member',
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ waitlist: { waitlist_id: id, waitlist_position: 7 } });
  });
  it.each(['cancelled', 'rejected', 'expired'])('leaving/rejecting keeps SQL result %s and never creates a booking', async state => {
    db.rpc.mockResolvedValue({ data: { id, state }, error: null });
    const res = response();
    await leaveClassWaitlist(request({ reason: ' No asistiré ', memberUserId: 'other' }), res);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('leave_class_waitlist_backend', {
      target_gym_id: 'trusted-gym', target_waitlist_id: id,
      target_actor_gym_user_id: 'trusted-member', supplied_reason: 'No asistiré',
    });
    expect(res.json).toHaveBeenCalledWith({ waitlist: { id, state } });
  });
  it('validates leave reasons before calling SQL', async () => {
    await expect(leaveClassWaitlist(request({ reason: 'x'.repeat(501) }), response())).rejects.toMatchObject({ statusCode: 400 });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each([false, true])('accepts using the SQL-created booking, including idempotent repeat %s', async already_accepted => {
    const result = { accepted: true, booking_id: booking, already_accepted, server_time };
    db.rpc.mockResolvedValue({ data: result, error: null });
    const res = response();
    await acceptClassWaitlistOffer(request({ memberUserId: 'other', gymId: 'foreign', amount: 0 }), res);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('accept_class_waitlist_offer_backend', {
      target_gym_id: 'trusted-gym', target_offer_id: id, target_actor_gym_user_id: 'trusted-member',
    });
    expect(res.json).toHaveBeenCalledWith(result);
  });
  it.each(['CLASS_WAITLIST_OFFER_EXPIRED', 'CLASS_WAITLIST_OFFER_UNAVAILABLE', 'CLASS_WAITLIST_OFFERS_DISABLED',
    'CLASS_CAPACITY_REACHED', 'CLASS_WAITLIST_PRIORITY_REQUIRED', 'CLASS_WAITLIST_MEMBER_INELIGIBLE',
    'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING', 'PAST_CLASS_CANNOT_BE_BOOKED'])('preserves functional conflict %s, without compensating writes', async code => {
    db.rpc.mockResolvedValue({ data: { accepted: false, code, server_time }, error: null });
    const res = response();
    await expect(acceptClassWaitlistOffer(request(), res)).rejects.toMatchObject({ statusCode: 409, code });
    expect(res.json).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects a foreign offer using the RPC ownership result', async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: 'CLASS_WAITLIST_OFFER_NOT_FOUND' } });
    await expect(acceptClassWaitlistOffer(request(), response())).rejects.toMatchObject({ statusCode: 404, code: 'CLASS_WAITLIST_OFFER_NOT_FOUND' });
  });
  it.each([null, {}, { accepted: true }, { accepted: false, code: 'CLASS_WAITLIST_OFFER_EXPIRED' }])('does not treat malformed RPC result as success', async data => {
    db.rpc.mockResolvedValue({ data, error: null });
    await expect(acceptClassWaitlistOffer(request(), response())).rejects.toMatchObject({ statusCode: 503, code: 'CLASS_WAITLIST_RESPONSE_INVALID' });
  });
  it.each([joinClassWaitlist, leaveClassWaitlist, acceptClassWaitlistOffer])('rejects non-member actors and invalid IDs before RPC', async action => {
    const req = request(); req.tenant.role = 'owner';
    await expect(action(req, response())).rejects.toMatchObject({ statusCode: 403 });
    req.tenant.role = 'member'; req.params.id = 'invalid';
    await expect(action(req, response())).rejects.toMatchObject({ statusCode: 403 });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each(['40P01', '40001'])('maps transaction %s to an explicit retry conflict', code => {
    expect(fromSupabaseError({ code, message: 'database transaction error' })).toMatchObject({ statusCode: 409, code: 'DATABASE_TRANSACTION_RETRY_REQUIRED' });
  });
});
