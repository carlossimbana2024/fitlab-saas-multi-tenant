import 'dotenv/config';
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  FRONTEND_ORIGINS: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  COOKIE_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(32).optional(),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_test_'),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
  STRIPE_PRICE_ID: z.string().startsWith('price_'),
  STRIPE_SUCCESS_URL: z.string().url(),
  STRIPE_CANCEL_URL: z.string().url(),
  TRIAL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  SUBSCRIPTION_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(5),
  INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  HF_TOKEN: z.string().startsWith('hf_').optional(),
  HF_MODEL: z.string().min(1).default('Qwen/Qwen3-8B'),
  HF_PROVIDER: z.string().min(1).default('auto'),
});

const parsed = environmentSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  throw new Error('INVALID_ENVIRONMENT_CONFIGURATION');
}

export const env = {
  ...parsed.data,
  frontendOrigins: parsed.data.FRONTEND_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};
