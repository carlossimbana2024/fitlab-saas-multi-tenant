import type { Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { voidPaymentSchema } from '../validators/membership.validator.js';

export async function listPayments(request: Request, response: Response) {
  let query = request.supabase!.from('member_payments').select(
    'id,location_id,member_user_id,membership_id,amount,currency,payment_method,status,external_reference,notes,registered_by,paid_at,voided_at,voided_by,void_reason',
  ).order('paid_at', { ascending: false }).limit(100);
  if (typeof request.query.memberUserId === 'string') query = query.eq('member_user_id', request.query.memberUserId);
  const { data, error } = await query;
  if (error) throw fromSupabaseError(error);
  response.json({ payments: data });
}

export async function voidPayment(request: Request, response: Response) {
  const id = request.params.id;
  if (typeof id !== 'string') throw new AppError(400, 'INVALID_ID', 'El identificador no es válido.');
  const input = voidPaymentSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_VOID_INPUT', 'Debes indicar un motivo válido.');

  const { data, error } = await request.supabase!.from('member_payments').update({
    status: 'voided', voided_at: new Date().toISOString(),
    voided_by: request.tenant!.gymUserId, void_reason: input.data.reason,
  }).eq('id', id).eq('status', 'confirmed').select('id,status,voided_at,voided_by,void_reason').maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'El pago no existe o no puede anularse.');
  response.json({ payment: data });
}
