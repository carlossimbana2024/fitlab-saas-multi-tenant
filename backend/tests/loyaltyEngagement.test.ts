import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc, config } = vi.hoisted(() => ({ rpc: vi.fn(), config: { CRON_SECRET: 'x'.repeat(32), LOYALTY_DELIVERY_URL: undefined as string | undefined, LOYALTY_DELIVERY_TOKEN: undefined as string | undefined } }));
vi.mock('../src/config/supabase.js', () => ({ supabaseAdmin: { rpc } }));
vi.mock('../src/config/env.js', () => ({ env: config }));
import { attachReferral, getEngagement, getAnalytics, savePreferences, readNotification } from '../src/controllers/loyalty.controller.js';
import { evaluateLoyaltyCron } from '../src/controllers/cron.controller.js';
import { runLoyaltyAutomation } from '../src/services/loyaltyAutomation.js';
import { promotionSchema } from '../src/validators/loyalty.validator.js';
const g = '00000000-0000-4000-8000-000000000001';
const m = '00000000-0000-4000-8000-000000000002';
const p = '00000000-0000-4000-8000-000000000003';
const req = (body = {}, params = {}, role = 'member') => ({ tenant: { gymId: g, gymUserId: m, role }, body, params }) as unknown as Request;
const res = () => { const r = { json: vi.fn(), status: vi.fn(), set: vi.fn() }; r.status.mockReturnValue(r); r.set.mockReturnValue(r); return r as unknown as Response; };
beforeEach(() => { vi.unstubAllGlobals(); rpc.mockReset(); rpc.mockResolvedValue({ data: null, error: null }); config.LOYALTY_DELIVERY_URL = undefined; config.LOYALTY_DELIVERY_TOKEN = undefined; });
describe('engagement security and automation', () => {
 it('keeps engagement private to the authenticated member', async () => {
  await getEngagement(req({ gymId: p, memberId: p }), res());
  expect(rpc).toHaveBeenCalledWith('loyalty_engagement_backend', { g, actor: m, member: m });
  await expect(getEngagement(req({}, { memberId: p }), res())).rejects.toMatchObject({ statusCode: 403 });
 });
 it('rejects tenant injection and validates referral codes', async () => {
  await expect(attachReferral(req({ promotionId: p, code: 'ABCDEF0123456789', gymId: p }), res())).rejects.toMatchObject({ statusCode: 400 });
  await attachReferral(req({ promotionId: p, code: 'ABCDEF0123456789' }), res());
  expect(rpc).toHaveBeenCalledWith('attach_loyalty_referral_backend', { g, actor: m, member: m, promotion: p, supplied_code: 'ABCDEF0123456789' });
 });
 it('requires explicit boolean consent and disallows staff identities', async () => {
  await expect(savePreferences(req({ email: 'true', whatsapp: false }), res())).rejects.toBeDefined();
  await expect(savePreferences(req({ email: true, whatsapp: true }, {}, 'staff'), res())).rejects.toBeDefined();
  await savePreferences(req({ email: false, whatsapp: false }), res());
  expect(rpc).toHaveBeenCalledWith('loyalty_preferences_backend', { g, actor: m, email: false, whatsapp: false });
 });
 it('scopes read markers and validates analytics periods', async () => {
  await readNotification(req({}, { id: p }), res());
  expect(rpc).toHaveBeenCalledWith('read_loyalty_notification_backend', { g, actor: m, notification: p });
  await expect(getAnalytics({ ...req(), query: { month: '2026-99' } } as unknown as Request, res())).rejects.toBeDefined();
 });
 it('validates referral campaign limits', () => {
  const input = { name: 'Referidos', locationId: p, startsOn: '2026-10-01', endsOn: '2026-10-31', redeemUntil: '2026-11-30', ruleType: 'referral', target: 1, rewardType: 'discount', rewardValue: 20, maxRewards: 2 };
  expect(promotionSchema.safeParse(input).success).toBe(true);
  for (const delta of [{ target: 2 }, { maxRewards: 1 }, { minimumPayment: 0 }, { inactiveDays: 1 }, { autoAward: 'true' }]) expect(promotionSchema.safeParse({ ...input, ...delta }).success).toBe(false);
 });
 it('rejects unauthenticated cron execution', async () => {
  await expect(evaluateLoyaltyCron({ get: () => undefined } as unknown as Request, res())).rejects.toMatchObject({ statusCode: 401 });
  expect(rpc).not.toHaveBeenCalled();
 });
 it('never claims external deliveries without a configured provider', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await runLoyaltyAutomation()).toMatchObject({ done: true, externalDeliveryConfigured: false });
  expect(rpc).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
 });
 it('uses stable delivery idempotency and acknowledges with the lease token', async () => {
  config.LOYALTY_DELIVERY_URL = 'https://adapter.invalid/send'; config.LOYALTY_DELIVERY_TOKEN = 'y'.repeat(32);
  rpc.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: [{ id: p, lease_token: m, recipient: 'test@invalid.test', channel: 'email', title: 'Logro', body: 'Prueba', gym_id: g }], error: null });
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch);
  expect(await runLoyaltyAutomation()).toMatchObject({ delivered: 1 });
  expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { 'Idempotency-Key': p } });
  expect(rpc).toHaveBeenLastCalledWith('finish_loyalty_delivery_backend', { delivery: p, token: m, success: true, error_code: null });
 });
});
