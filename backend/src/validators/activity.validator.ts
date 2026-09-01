import { z } from 'zod';

const uuid = z.string().uuid();
const paymentMethod = z.enum(['cash', 'bank_transfer', 'external_card', 'external_deuna', 'other']);

export const activitySchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).nullish(),
  billingMode: z.enum(['included', 'additional_fee']),
  price: z.coerce.number().min(0).max(9999999999),
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  capacity: z.coerce.number().int().min(1).max(10000),
  durationMinutes: z.coerce.number().int().min(10).max(1440),
  isActive: z.boolean().optional().default(true),
}).superRefine((value, context) => {
  if (value.billingMode === 'included' && value.price !== 0) {
    context.addIssue({ code: 'custom', path: ['price'], message: 'Una actividad incluida debe tener precio cero.' });
  }
  if (value.billingMode === 'additional_fee' && value.price <= 0) {
    context.addIssue({ code: 'custom', path: ['price'], message: 'Una actividad de pago debe tener un precio mayor que cero.' });
  }
});

export const classScheduleSchema = z.object({
  activityId: uuid,
  locationId: uuid,
  instructorUserId: uuid.nullish(),
  startsAt: z.string().datetime({ offset: true }),
  capacityOverride: z.coerce.number().int().min(1).max(10000).nullish(),
});

export const managedClassBookingSchema = z.object({
  memberUserId: uuid,
  payment: z.object({
    method: paymentMethod,
    externalReference: z.string().trim().max(200).nullish(),
    notes: z.string().trim().max(1000).nullish(),
  }).nullish(),
});

export const bookingCancellationSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const classAttendanceSchema = z.object({
  status: z.enum(['attended', 'no_show']),
});

export const activitiesListSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  locationId: uuid.optional(),
  includeInactive: z.union([z.literal('true'), z.literal('false')])
    .transform((value) => value === 'true').optional().default('false'),
});
