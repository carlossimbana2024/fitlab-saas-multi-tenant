import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

const authOptions = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
} as const;

export const supabasePublic = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_PUBLISHABLE_KEY,
  authOptions,
);

export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SECRET_KEY,
  authOptions,
);

export function createUserSupabaseClient(accessToken: string) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    ...authOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
