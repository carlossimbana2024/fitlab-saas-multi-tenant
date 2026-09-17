import { z } from 'zod';

export const promotionSchema = z.object({
  name: z.string().trim().min(3).max(100),
  description: z.string().trim().max(500).default(''),
  locationId: z.string().uuid(),
  startsOn: z.string().date(), endsOn: z.string().date(), redeemUntil: z.string().date(),
  ruleType: z.enum(['attendance_count', 'required_streak', 'perfect_attendance', 'recovery', 'referral']),
  autoAward: z.boolean().default(false),
  inactiveDays: z.number().int().min(7).max(180).default(14),
  minimumPayment: z.number().min(0.01).max(999999).default(1),
  target: z.number().int().min(1).max(366),
  rewardType: z.enum(['discount', 'free_period', 'product']),
  rewardValue: z.number().int().min(1).max(99),
  productId: z.string().uuid().nullable().default(null),
  maxRewards: z.number().int().min(1).max(10000),
}).strict().superRefine((value, ctx) => {
  if (value.ruleType === 'referral' && (value.target !== 1 || value.maxRewards < 2))
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'Referidos requiere meta 1 y al menos dos premios.' });
  const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86400000;
  if (value.endsOn < value.startsOn || days(value.endsOn, value.startsOn) > 365 || value.redeemUntil < value.endsOn || days(value.redeemUntil, value.endsOn) > 180)
    ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'Revisa el período y la fecha límite de canje.' });
  if ((value.rewardType === 'product') !== Boolean(value.productId) || (value.rewardType === 'product' && value.rewardValue > 10) || (value.rewardType === 'free_period' && value.rewardValue > 3))
    ctx.addIssue({ code: 'custom', path: ['rewardValue'], message: 'La recompensa no es válida.' });
});
export const promotionStatusSchema = z.object({ status: z.enum(['active', 'paused', 'closed']) }).strict();
export const rewardReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
