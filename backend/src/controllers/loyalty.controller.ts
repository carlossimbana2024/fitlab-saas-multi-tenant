import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { promotionSchema, promotionStatusSchema, rewardReasonSchema } from '../validators/loyalty.validator.js';

function parameter(request: Request, key: string) {
  const result = z.string().uuid().safeParse(request.params[key]);
  if (!result.success) throw new AppError(400, 'INVALID_ID', 'Identificador no válido.');
  return result.data;
}
function context(request: Request) {
  return { g: request.tenant!.gymId, actor: request.tenant!.gymUserId };
}
function member(request: Request) {
  if (request.params.memberId) {
    if (request.tenant!.role !== 'owner') throw new AppError(403, 'OWNER_REQUIRED', 'Solo el owner puede consultar a otro miembro.');
    return parameter(request, 'memberId');
  }
  if (request.tenant!.role !== 'member') throw new AppError(403, 'MEMBER_REQUIRED', 'Esta opción pertenece al portal del miembro.');
  return request.tenant!.gymUserId;
}
export async function listPromotions(request: Request, response: Response) {
  const { data, error } = await supabaseAdmin.from('gym_promotions').select('*').eq('gym_id', request.tenant!.gymId).order('created_at', { ascending: false });
  if (error) throw fromSupabaseError(error);
  response.json({ promotions: data });
}
export async function savePromotion(request: Request, response: Response) {
  const input = promotionSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_PROMOTION', 'Revisa las condiciones de la promoción.', input.error.flatten());
  const { data, error } = await supabaseAdmin.rpc('save_promotion_backend', { ...context(request), promotion: request.params.id ? parameter(request, 'id') : null, input: input.data });
  if (error) throw fromSupabaseError(error);
  response.status(request.params.id ? 200 : 201).json({ promotion: data });
}
export async function changePromotionStatus(request: Request, response: Response) {
  const input = promotionStatusSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_STATUS', 'Estado no válido.');
  const { data, error } = await supabaseAdmin.rpc('set_promotion_status_backend', { ...context(request), promotion: parameter(request, 'id'), new_status: input.data.status });
  if (error) throw fromSupabaseError(error);
  response.json({ promotion: data });
}
export async function getLoyalty(request: Request, response: Response) {
  const { data, error } = await supabaseAdmin.rpc('member_loyalty_backend', { ...context(request), member: member(request) });
  if (error) throw fromSupabaseError(error);
  response.set('Cache-Control', 'no-store').json(data);
}
export async function claimReward(request: Request, response: Response) {
  const { data, error } = await supabaseAdmin.rpc('claim_reward_backend', { ...context(request), member: member(request), promotion: parameter(request, 'id') });
  if (error) throw fromSupabaseError(error);
  response.json({ reward: { id: data.id, status: data.status } });
}
export async function redeemProduct(request: Request, response: Response) {
  const { data, error } = await supabaseAdmin.rpc('redeem_product_reward_backend', { ...context(request), reward: parameter(request, 'id') });
  if (error) throw fromSupabaseError(error);
  response.json({ redemption: data });
}
export async function revokeReward(request: Request, response: Response) {
  const input = rewardReasonSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_REASON', 'Escribe un motivo de 3 a 500 caracteres.');
  const { error } = await supabaseAdmin.rpc('revoke_reward_backend', { ...context(request), reward: parameter(request, 'id'), reason: input.data.reason });
  if (error) throw fromSupabaseError(error);
  response.json({ revoked: true });
}
