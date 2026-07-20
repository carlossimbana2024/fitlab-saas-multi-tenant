import { z } from 'zod';

const uuid = z.string().uuid();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dayMode = z.enum(['required', 'bonus', 'closed']);
const day = z.object({ weekday: z.number().int().min(1).max(7), dayMode, opensAt: time.nullish(), closesAt: time.nullish() }).superRefine((value, context) => {
  if (value.dayMode !== 'closed' && (!value.opensAt || !value.closesAt)) context.addIssue({ code: 'custom', message: 'Los días abiertos requieren hora de apertura y cierre.' });
});

export const scheduleSchema = z.object({ locationId: uuid, days: z.array(day).length(7).refine((days) => new Set(days.map((item) => item.weekday)).size === 7, 'Los siete días deben ser únicos.') });
export const exceptionSchema = z.object({ locationId: uuid, calendarDate: z.string().date(), dayMode, opensAt: time.nullish(), closesAt: time.nullish(), reason: z.string().trim().max(250).nullish() }).superRefine((value, context) => {
  if (value.dayMode !== 'closed' && (!value.opensAt || !value.closesAt)) context.addIssue({ code: 'custom', message: 'Una apertura especial requiere horario.' });
});
