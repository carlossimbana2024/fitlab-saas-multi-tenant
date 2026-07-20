import { z } from 'zod';

const uuid = z.string().uuid();

export const qrAttendanceSchema = z.object({
  locationId: uuid.optional(),
  membershipId: uuid.optional(),
});

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
