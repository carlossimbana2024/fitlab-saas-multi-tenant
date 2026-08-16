import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { paymentReversalSchema } from '../validators/membership.validator.js';

const uuid = z.string().uuid();
const paymentFields = 'id,location_id,member_user_id,membership_id,amount,currency,payment_method,status,external_reference,notes,registered_by,paid_at,receipt_number,receipt_issued_at,voided_at,voided_by,void_reason,refunded_at,refunded_by,refund_reason';

function relatedOne<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

function gymUserName(user: { managed_full_name?: string | null; profiles?: { full_name?: string | null } | Array<{ full_name?: string | null }> | null } | undefined) {
  return relatedOne(user?.profiles)?.full_name ?? user?.managed_full_name ?? 'Sin nombre';
}

export async function listPayments(request: Request, response: Response) {
  let query = supabaseAdmin.from('member_payments').select(paymentFields)
    .eq('gym_id', request.tenant!.gymId).not('membership_id', 'is', null)
    .order('paid_at', { ascending: false }).limit(200);
  if (typeof request.query.memberUserId === 'string') query = query.eq('member_user_id', request.query.memberUserId);
  const paymentsResult = await query;
  if (paymentsResult.error) throw fromSupabaseError(paymentsResult.error);
  const payments = paymentsResult.data ?? [];
  const memberIds = [...new Set(payments.map((payment) => payment.member_user_id).filter(Boolean))] as string[];
  const membershipIds = [...new Set(payments.map((payment) => payment.membership_id).filter(Boolean))] as string[];
  const [membersResult, membershipsResult] = await Promise.all([
    memberIds.length
      ? supabaseAdmin.from('gym_users').select('id,managed_full_name,profiles(full_name)').eq('gym_id', request.tenant!.gymId).in('id', memberIds)
      : Promise.resolve({ data: [], error: null }),
    membershipIds.length
      ? supabaseAdmin.from('memberships').select('id,plan_id,plans(name)').eq('gym_id', request.tenant!.gymId).in('id', membershipIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const relatedError = membersResult.error ?? membershipsResult.error;
  if (relatedError) throw fromSupabaseError(relatedError);
  const members = new Map((membersResult.data ?? []).map((member) => [member.id, gymUserName(member)]));
  const memberships = new Map((membershipsResult.data ?? []).map((membership) => [membership.id, relatedOne(membership.plans)?.name ?? 'Plan']));
  response.json({ payments: payments.map((payment) => ({
    ...payment,
    member_name: payment.member_user_id ? members.get(payment.member_user_id) ?? 'Miembro' : 'Miembro',
    plan_name: payment.membership_id ? memberships.get(payment.membership_id) ?? 'Plan' : 'Plan',
  })) });
}

async function reversePayment(request: Request, response: Response, status: 'voided' | 'refunded') {
  const id = typeof request.params.id === 'string' ? request.params.id : undefined;
  const input = paymentReversalSchema.safeParse(request.body);
  if (!id || !uuid.safeParse(id).success || !input.success) {
    throw new AppError(400, 'INVALID_PAYMENT_REVERSAL', 'Debes indicar un pago y un motivo válido.');
  }
  const { data, error } = await supabaseAdmin.rpc('reverse_member_payment_backend', {
    target_gym_id: request.tenant!.gymId,
    target_payment_id: id,
    target_reversed_by: request.tenant!.gymUserId,
    target_reversal_status: status,
    supplied_reason: input.data.reason,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  const payment = Array.isArray(data) ? data[0] : undefined;
  if (!payment) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'El pago no existe o ya no puede revertirse.');
  response.json({ payment });
}

export async function voidPayment(request: Request, response: Response) {
  return reversePayment(request, response, 'voided');
}

export async function refundPayment(request: Request, response: Response) {
  return reversePayment(request, response, 'refunded');
}

export async function getPaymentReceipt(request: Request, response: Response) {
  const id = typeof request.params.id === 'string' ? request.params.id : undefined;
  if (!id || !uuid.safeParse(id).success) throw new AppError(400, 'INVALID_PAYMENT_ID', 'El pago no es válido.');
  const paymentResult = await supabaseAdmin.from('member_payments').select(paymentFields)
    .eq('id', id).eq('gym_id', request.tenant!.gymId).not('membership_id', 'is', null).maybeSingle();
  if (paymentResult.error) throw fromSupabaseError(paymentResult.error);
  const payment = paymentResult.data;
  if (!payment?.receipt_number) throw new AppError(404, 'RECEIPT_NOT_FOUND', 'El recibo no existe.');

  const [gymResult, locationResult, memberResult, membershipResult, periodResult, actorResult] = await Promise.all([
    supabaseAdmin.from('gyms').select('name,legal_name,email,phone,currency').eq('id', request.tenant!.gymId).single(),
    supabaseAdmin.from('gym_locations').select('name,address,city,phone').eq('id', payment.location_id).eq('gym_id', request.tenant!.gymId).single(),
    supabaseAdmin.from('gym_users').select('managed_full_name,managed_phone,profiles(full_name,phone)').eq('id', payment.member_user_id).eq('gym_id', request.tenant!.gymId).single(),
    supabaseAdmin.from('memberships').select('id,plans(name)').eq('id', payment.membership_id).eq('gym_id', request.tenant!.gymId).single(),
    supabaseAdmin.from('membership_periods').select('starts_on,ends_on,charged_amount,currency').eq('payment_id', payment.id).maybeSingle(),
    supabaseAdmin.from('gym_users').select('managed_full_name,profiles(full_name)').eq('id', payment.registered_by).eq('gym_id', request.tenant!.gymId).single(),
  ]);
  const relatedError = gymResult.error ?? locationResult.error ?? memberResult.error ?? membershipResult.error ?? periodResult.error ?? actorResult.error;
  if (relatedError) throw fromSupabaseError(relatedError);
  if (!gymResult.data || !locationResult.data || !memberResult.data || !membershipResult.data || !actorResult.data) {
    throw new AppError(404, 'RECEIPT_CONTEXT_NOT_FOUND', 'No se pudo completar la información del recibo.');
  }
  const member = memberResult.data;
  const membership = membershipResult.data;
  const actor = actorResult.data;
  const memberProfile = relatedOne(member.profiles);
  response.json({ receipt: {
    number: payment.receipt_number,
    issuedAt: payment.receipt_issued_at,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    paymentMethod: payment.payment_method,
    externalReference: payment.external_reference,
    notes: payment.notes,
    voidReason: payment.void_reason,
    refundReason: payment.refund_reason,
    gym: gymResult.data,
    location: locationResult.data,
    member: { name: memberProfile?.full_name ?? member.managed_full_name ?? 'Miembro', phone: memberProfile?.phone ?? member.managed_phone ?? null },
    plan: { name: relatedOne(membership.plans)?.name ?? 'Plan' },
    coverage: periodResult.data,
    registeredBy: { name: gymUserName(actor) },
  } });
}
