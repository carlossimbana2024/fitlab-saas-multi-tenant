import type { SupabaseClient, User } from '@supabase/supabase-js';

declare global {
  namespace Express {
    interface Request {
      accessToken?: string;
      authUser?: User;
      supabase?: SupabaseClient;
      tenant?: {
        gymUserId: string;
        gymId: string;
        role: 'owner' | 'staff' | 'member';
        status: string;
        defaultLocationId: string | null;
        timezone: string;
      };
    }
  }
}

export {};
