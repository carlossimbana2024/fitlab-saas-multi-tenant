import { z } from 'zod';

const uuid = z.string().uuid();

export const manualCheckoutSchema = z.object({
  locationId: uuid,
  memberUserId: uuid,
  planId: uuid,
  membershipId: uuid.nullish(),
  paymentMethod: z.enum(['cash', 'bank_transfer', 'external_card', 'external_deuna', 'other']),
  externalReference: z.string().trim().min(1).max(200).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

export const createPlanSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullish(),
  price: z.coerce.number().min(0).max(9999999999),
  durationUnit: z.enum(['days', 'weeks', 'months']),
  durationValue: z.coerce.number().int().min(1).max(120),
  attendanceMode: z.enum(['daily', 'weekly']),
  weeklyTarget: z.coerce.number().int().min(1).max(7).nullish(),
  allowsExtraClasses: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.attendanceMode === 'weekly' && value.weeklyTarget == null) context.addIssue({ code: 'custom', path: ['weeklyTarget'], message: 'La meta semanal es obligatoria.' });
});

export const voidPaymentSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  fullName: z.string().trim().min(2).max(150),
  phone: z.string().trim().max(40).nullish(),
  defaultLocationId: uuid.nullish(),
});

export const managedMemberSchema = z.object({
  fullName: z.string().trim().min(2).max(150),
  phone: z.string().trim().min(3).max(40).nullish(),
  birthDate: z.string().date().nullish(),
  guardianName: z.string().trim().min(2).max(150).nullish(),
  guardianPhone: z.string().trim().min(3).max(40).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  defaultLocationId: uuid.nullish(),
});
