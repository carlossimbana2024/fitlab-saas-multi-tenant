import { z } from 'zod';

export const paymentRequestMethods = ['bank_transfer', 'deposit', 'other'] as const;
export const membershipPaymentSettingsSchema = z.object({
  enabled: z.boolean(),
  instructions: z.string().trim().max(2000),
  methods: z.array(z.enum(paymentRequestMethods)).min(1).max(3).refine((v) => new Set(v).size === v.length),
}).strict().refine((v) => !v.enabled || v.instructions.length >= 3, { message: 'Indica dónde y cómo pagar.' });

export const prepareMembershipPaymentSchema = z.object({
  planId: z.string().uuid(),
  channel: z.enum(['fitlab', 'whatsapp']),
  contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']).optional(),
}).strict().refine((v) => v.channel !== 'fitlab' || Boolean(v.contentType));

export const submitMembershipPaymentSchema = z.object({
  channel: z.enum(['fitlab', 'whatsapp']),
  amount: z.number().positive().max(9999999999).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.00001),
  paidOn: z.string().date(),
  method: z.enum(paymentRequestMethods),
  reference: z.string().trim().max(200).optional(),
  comment: z.string().trim().max(1000).optional(),
}).strict();

export const reviewMembershipPaymentSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'revision_requested']),
  reason: z.string().trim().min(3).max(500),
  bankVerified: z.boolean().default(false),
}).strict().refine((v) => v.decision !== 'approved' || v.bankVerified, { message: 'Confirma primero el ingreso en la cuenta del gimnasio.' });
