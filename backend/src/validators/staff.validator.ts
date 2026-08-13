import { z } from 'zod';

const uuid = z.string().uuid();
const accessMode = z.enum(['allowed', 'requires_pin', 'denied']);

export const inviteStaffSchema = z.object({
  email: z.string().email(),
  fullName: z.string().trim().min(2).max(150),
  phone: z.string().trim().max(40).nullish(),
  defaultLocationId: uuid.nullish(),
});

export const updateStaffPermissionsSchema = z.object({
  permissions: z.record(accessMode).refine((value) => Object.keys(value).length > 0, {
    message: 'Selecciona al menos un permiso.',
  }),
});

export const updateStaffStatusSchema = z.object({
  status: z.enum(['active', 'suspended']),
});
