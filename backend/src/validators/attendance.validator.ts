import { z } from 'zod';

const uuid = z.string().uuid();

export const qrAttendanceSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export const manageAttendanceQrSchema = z.object({
  locationId: uuid,
  action: z.enum(['generate', 'revoke']),
}).strict();

export const staffAttendanceSchema = z.object({
  locationId: uuid,
  memberUserId: uuid,
  membershipId: uuid,
});

export const voidAttendanceSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const attendanceListSchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  memberUserId: uuid.optional(),
});
