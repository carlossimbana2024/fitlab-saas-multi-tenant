import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({ supabaseAdmin: { rpc } }));
import { claimReward, getLoyalty, savePromotion } from '../src/controllers/loyalty.controller.js';
import { manualCheckout } from '../src/controllers/membership.controller.js';
import { promotionSchema } from '../src/validators/loyalty.validator.js';
import { requireOwner } from '../src/middlewares/requireOwner.js';

const gym = '00000000-0000-4000-8000-000000000001';
const actor = '00000000-0000-4000-8000-000000000002';
const id = '00000000-0000-4000-8000-000000000003';
const request = (role = 'member', params = {}, body = {}) => ({ tenant: { gymId: gym, gymUserId: actor, role }, params, body }) as unknown as Request;
const response = () => { const res = { json: vi.fn(), status: vi.fn(), set: vi.fn() }; res.status.mockReturnValue(res); res.set.mockReturnValue(res); return res as unknown as Response; };
const input = { name: 'Constancia', locationId: id, startsOn: '2026-10-01', endsOn: '2026-10-31', redeemUntil: '2026-11-30', ruleType: 'attendance_count', target: 12, rewardType: 'discount', rewardValue: 30, maxRewards: 25 };

beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({ data: {}, error: null }); });

describe('fidelización: validación y autorización', () => {
  it('valida las tres recompensas sin aceptar precios, permisos o tenant del cliente', () => {
    expect(promotionSchema.safeParse(input).success).toBe(true);
    expect(promotionSchema.safeParse({ ...input, rewardType: 'free_period', rewardValue: 1 }).success).toBe(true);
    expect(promotionSchema.safeParse({ ...input, rewardType: 'product', productId: id, rewardValue: 2 }).success).toBe(true);
    for (const invalid of [{ gymId: gym }, { target: -1 }, { rewardValue: 100 }, { rewardType: 'free_period', rewardValue: 4 }, { rewardType: 'product', productId: null }, { endsOn: '2026-09-01' }, { redeemUntil: '2028-01-01' }, { startsOn: '2026-02-30' }, { productId: id }])
      expect(promotionSchema.safeParse({ ...input, ...invalid }).success).toBe(false);
  });
  it('ignora la identidad enviada al reclamar: usa exclusivamente tenant y miembro autenticados', async () => {
    await claimReward(request('member', { id }, { gymId: id, memberId: id, actor: id, progress: 999 }), response());
    expect(rpc).toHaveBeenCalledWith('claim_reward_backend', { g: gym, actor, member: actor, promotion: id });
  });
  it('rechaza consultar otro miembro desde el portal o usando un rol de personal', async () => {
    await expect(getLoyalty(request('member', { memberId: id }), response())).rejects.toMatchObject({ statusCode: 403 });
    await expect(getLoyalty(request('staff'), response())).rejects.toMatchObject({ statusCode: 403 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('permite al owner consultar al miembro y deja la validación de pertenencia también en SQL', async () => {
    await getLoyalty(request('owner', { memberId: id }), response());
    expect(rpc).toHaveBeenCalledWith('member_loyalty_backend', { g: gym, actor, member: id });
  });
  it('valida UUID y entrada antes de contactar la base', async () => {
    await expect(claimReward(request('member', { id: 'invalid' }), response())).rejects.toBeDefined();
    await expect(savePromotion(request('owner', {}, { ...input, gymId: id }), response())).rejects.toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rechaza el canje por personal incluso con permiso de cobro', async () => {
    await expect(manualCheckout(request('staff', {}, { locationId: id, memberUserId: id, planId: id, membershipId: id, rewardId: id, paymentMethod: 'cash' }), response())).rejects.toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('transmite el identificador de recompensa pero no importes suministrados por el navegador', async () => {
    rpc.mockResolvedValue({ data: [{ receipt_number: null }], error: null });
    await manualCheckout(request('owner', {}, { locationId: id, memberUserId: id, planId: id, membershipId: id, rewardId: id, paymentMethod: 'cash', amount: 0, discount: 100 }), response());
    expect(rpc.mock.calls[0][1]).toMatchObject({ target_gym_id: gym, target_registered_by: actor, supplied_reward_id: id });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('amount');
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('discount');
  });
  it('exige owner para las rutas administrativas además del JWT y tenant', () => {
    const routes = readFileSync(join(import.meta.dirname, '../src/routes/loyalty.routes.ts'), 'utf8');
    expect(routes).toContain('loyaltyRouter.use(verifyJWT, tenantContext)');
    expect(routes.indexOf('loyaltyRouter.use(requireOwner)')).toBeLessThan(routes.indexOf("loyaltyRouter.get('/promotions'"));
    for (const role of ['staff', 'member']) expect(() => requireOwner(request(role), response(), vi.fn())).toThrow();
    const next = vi.fn(); requireOwner(request('owner'), response(), next); expect(next).toHaveBeenCalledOnce();
  });
  it('mantiene las protecciones de idempotencia y privacidad en SQL', () => {
    const sql = readFileSync(join(import.meta.dirname, '../../supabase/migrations/0039_loyalty_rewards.sql'), 'utf8');
    expect(sql).toContain('unique (promotion_id,member_user_id)');
    expect(sql).toContain('reward_id uuid not null unique');
    expect(sql).toContain("source <> 'extra_class'");
    expect(sql).toContain('protect_promotion_terms');
    expect(sql).toContain('protect_reward_history');
    expect(sql).toContain('for share');
  });
});
