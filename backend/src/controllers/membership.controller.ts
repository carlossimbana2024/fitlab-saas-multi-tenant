import type { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { cancelMembershipSchema, manualCheckoutSchema } from '../validators/membership.validator.js';

export async function listMemberships(request: Request, response: Response) {
  let query = request.supabase!.from('memberships').select(
    'id,gym_id,member_user_id,plan_id,status,price_at_purchase,currency,attendance_mode_snapshot,weekly_target_snapshot,created_at,cancelled_at,cancellation_reason,plans(name,price,currency),membership_periods(id,starts_on,ends_on,status,payment_id,charged_amount,currency)',
  ).order('created_at', { ascending: false }).limit(100);
  if (typeof request.query.memberUserId === 'string') query = query.eq('member_user_id', request.query.memberUserId);
  const { data, error } = await query;
  if (error) throw fromSupabaseError(error);
  response.json({ memberships: data });
}

export async function manualCheckout(request: Request, response: Response) {
  const input = manualCheckoutSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_CHECKOUT_INPUT', 'Los datos del cobro no son válidos.', input.error.flatten());

  const { data, error } = await supabaseAdmin.rpc('register_manual_membership_checkout', {
    target_gym_id: request.tenant!.gymId,
    target_location_id: input.data.locationId,
    target_member_user_id: input.data.memberUserId,
    target_plan_id: input.data.planId,
    target_registered_by: request.tenant!.gymUserId,
    selected_payment_method: input.data.paymentMethod,
    supplied_external_reference: input.data.externalReference ?? null,
    supplied_notes: input.data.notes ?? null,
    target_membership_id: input.data.membershipId ?? null,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  const checkout = Array.isArray(data) ? data[0] : undefined;
  if (!checkout) throw new AppError(500, 'CHECKOUT_EMPTY_RESULT', 'El cobro no devolvió un resultado.');
  response.status(201).json({ checkout });
}

export async function cancelMembership(request: Request, response: Response) {
  const membershipId = typeof request.params.id === 'string' ? request.params.id : undefined;
  const input = cancelMembershipSchema.safeParse(request.body);
  if (!membershipId || !input.success) {
    throw new AppError(400, 'INVALID_MEMBERSHIP_CANCELLATION', 'Debes indicar una membresía y un motivo válido.');
  }
  const { data, error } = await supabaseAdmin.rpc('cancel_membership_backend', {
    target_gym_id: request.tenant!.gymId,
    target_membership_id: membershipId,
    target_cancelled_by: request.tenant!.gymUserId,
    supplied_reason: input.data.reason,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  const membership = Array.isArray(data) ? data[0] : undefined;
  if (!membership) throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'La membresía no existe o ya fue cancelada.');
  response.json({ membership });
}
