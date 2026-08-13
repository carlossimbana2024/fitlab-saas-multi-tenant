import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../services/api';

type GymUser = { id: string; gym_id: string; role: 'owner' | 'staff' | 'member'; status: string; default_location_id?: string | null; profiles?: { full_name?: string; phone?: string | null; avatar_url?: string | null }; staff_permissions?: Array<{ permission_key: string; access_mode: 'allowed' | 'requires_pin' | 'denied' }> };
type Session = { user: { id: string; email?: string }; gymUser: GymUser | null; onboardingRequired?: boolean };
type AuthValue = { session: Session | null; loading: boolean; login: (email: string, password: string) => Promise<void>; logout: () => Promise<void>; refresh: () => Promise<void> };
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async (throwOnError = false) => { try { setSession((await api.get<Session>('/auth/me')).data); } catch (error) { setSession(null); if (throwOnError) throw error; } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  const login = async (email: string, password: string) => { await api.post('/auth/login', { email, password }); await load(true); };
  const logout = async () => { await api.post('/auth/logout'); setSession(null); };
  return <AuthContext.Provider value={useMemo(() => ({ session, loading, login, logout, refresh: () => load() }), [session, loading])}>{children}</AuthContext.Provider>;
}

export function useAuth() { const value = useContext(AuthContext); if (!value) throw new Error('AuthProvider missing'); return value; }
