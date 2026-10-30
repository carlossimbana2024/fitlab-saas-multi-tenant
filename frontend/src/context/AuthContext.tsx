import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import axios from 'axios';
import { api, sessionRecovery } from '../services/api';
import { isSessionExpired } from '../services/sessionRecovery';
import { useQueryClient } from '@tanstack/react-query';

type GymUser = { id: string; gym_id: string; role: 'owner' | 'staff' | 'member'; status: string; default_location_id?: string | null; profiles?: { full_name?: string; phone?: string | null; avatar_url?: string | null }; staff_permissions?: Array<{ permission_key: string; access_mode: 'allowed' | 'requires_pin' | 'denied' }> };
type Session = { user: { id: string; email?: string }; gymUser: GymUser | null; onboardingRequired?: boolean };
type AuthValue = { session: Session | null; loading: boolean; login: (email: string, password: string) => Promise<void>; logout: () => Promise<void>; refresh: () => Promise<void> };
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const generation = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const clear = () => {
    generation.current++;
    pending.current = null;
    void queryClient.cancelQueries();
    queryClient.clear();
    setSession(null); setUnavailable(false); setLoading(false);
  };
  const load = (throwOnError = false): Promise<void> => {
    if (pending.current) return pending.current;
    const current = generation.current;
    setLoading(true); setUnavailable(false);
    const task = api.get<Session>('/auth/me').then(({ data }) => {
      if (current === generation.current) setSession(data);
    }).catch(error => {
      if (current === generation.current && !axios.isCancel(error)) {
        if (isSessionExpired(error)) clear();
        else setUnavailable(true);
      }
      if (throwOnError) throw error;
    }).finally(() => {
      if (current === generation.current) setLoading(false);
      if (pending.current === task) pending.current = null;
    });
    pending.current = task;
    return task;
  };
  useEffect(() => {
    const unsubscribe = sessionRecovery.subscribe(clear);
    void load();
    return unsubscribe;
  }, []);
  const login = async (email: string, password: string) => {
    const release = await sessionRecovery.boundary();
    try { await api.post('/auth/login', { email, password }); }
    finally { release(); }
    clear(); await load(true);
  };
  const logout = async () => {
    const release = await sessionRecovery.boundary();
    try { await api.post('/auth/logout'); }
    finally { release(); }
    clear();
  };
  return <AuthContext.Provider value={{ session, loading, login, logout, refresh: () => load() }}>
    {unavailable && !session ? <main className="splash"><section role="alert">
      <h1>No pudimos comprobar tu sesión</h1><p>Puede ser un problema temporal de conexión. No hemos cerrado tu sesión.</p>
      <button className="primary" onClick={() => void load()}>Volver a intentar</button>
    </section></main> : children}
  </AuthContext.Provider>;
}

export function useAuth() { const value = useContext(AuthContext); if (!value) throw new Error('AuthProvider missing'); return value; }
