import { LoaderCircle, LockKeyhole } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { ThemeToggle } from '../components/ThemeToggle';
import { api } from '../services/api';

function invitationTokens() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  if (accessToken && refreshToken) {
    sessionStorage.setItem('fitlab_invite_access_token', accessToken);
    sessionStorage.setItem('fitlab_invite_refresh_token', refreshToken);
    window.history.replaceState(null, '', window.location.pathname);
  }
  return {
    accessToken: accessToken ?? sessionStorage.getItem('fitlab_invite_access_token') ?? '',
    refreshToken: refreshToken ?? sessionStorage.getItem('fitlab_invite_refresh_token') ?? '',
    error: hash.get('error_description'),
  };
}

export function AcceptInvitePage() {
  const tokens = useMemo(invitationTokens, []);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState(tokens.error ? decodeURIComponent(tokens.error.replace(/\+/g, ' ')) : '');
  const [loading, setLoading] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) return setError('Las contraseñas no coinciden.');
    setLoading(true); setError('');
    try {
      await api.post('/auth/accept-invite', { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, password });
      sessionStorage.removeItem('fitlab_invite_access_token');
      sessionStorage.removeItem('fitlab_invite_refresh_token');
      window.location.assign('/portal');
    } catch (caught) {
      const value = caught as { response?: { data?: { error?: { message?: string } } } };
      setError(value.response?.data?.error?.message ?? 'No se pudo aceptar la invitación.');
    } finally { setLoading(false); }
  };
  const validLink = Boolean(tokens.accessToken && tokens.refreshToken);
  return <div className="invite-page"><div className="login-tools"><ThemeToggle/></div><form className="invite-card" onSubmit={submit}><img src="/fitlab-logo.png" alt="FitLab"/><p className="eyebrow">BIENVENIDO A FITLAB</p><h1>Activa tu cuenta</h1><p className="muted">Crea una contraseña para acceder al portal de tu gimnasio.</p>{!validLink && <div className="alert error">El enlace no contiene una invitación válida. Solicita una nueva invitación al gimnasio.</div>}{error && validLink && <div className="alert error">{error}</div>}<label>Nueva contraseña<input required type="password" minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password"/></label><label>Confirmar contraseña<input required type="password" minLength={8} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password"/></label><button className="primary" disabled={!validLink || loading}>{loading ? <><LoaderCircle className="spin"/>Activando…</> : <><LockKeyhole/>Activar cuenta</>}</button></form></div>;
}
