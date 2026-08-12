import type { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { createPlanSchema } from '../validators/membership.validator.js';

export async function listPlans(request: Request, response: Response) {
  const includeInactive = request.query.includeInactive === 'true' && request.tenant!.role === 'owner';
  let query = request.supabase!.from('plans')
    .select('id,name,description,price,currency,duration_unit,duration_value,attendance_mode,weekly_target,allows_extra_classes,is_active')
    .order('price', { ascending: true });
  if (!includeInactive) query = query.eq('is_active', true);
  const { data, error } = await query;
  if (error) throw fromSupabaseError(error);
  response.json({ plans: data });
}

export async function createPlan(request: Request, response: Response) {
  const input = createPlanSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_PLAN_INPUT', 'Los datos del plan no son válidos.', input.error.flatten());
  const { data: gym, error: gymError } = await request.supabase!.from('gyms').select('currency').eq('id', request.tenant!.gymId).single();
  if (gymError || !gym) throw new AppError(404, 'GYM_NOT_FOUND', 'No se encontró el gimnasio.');
  const { data, error } = await supabaseAdmin.from('plans').insert({
    gym_id: request.tenant!.gymId,
    name: input.data.name,
    description: input.data.description ?? null,
    price: input.data.price,
    currency: gym.currency,
    duration_unit: input.data.durationUnit,
    duration_value: input.data.durationValue,
    attendance_mode: input.data.attendanceMode,
    weekly_target: input.data.attendanceMode === 'weekly' ? input.data.weeklyTarget : null,
    allows_extra_classes: input.data.allowsExtraClasses,
  }).select('id,name,description,price,currency,duration_unit,duration_value,attendance_mode,weekly_target,allows_extra_classes,is_active').single();
  if (error) throw fromSupabaseError(error);
  response.status(201).json({ plan: data });
}
