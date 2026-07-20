import { LoaderCircle, LockKeyhole } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { ThemeToggle } from '../components/ThemeToggle';
import { api, apiErrorMessage } from '../services/api';

function recoveryTokens() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  const type = hash.get('type');
  if (accessToken && refreshToken && type === 'recovery') {
    sessionStorage.setItem('fitlab_recovery_access_token', accessToken);
    sessionStorage.setItem('fitlab_recovery_refresh_token', refreshToken);
    window.history.replaceState(null, '', window.location.pathname);
  }
  return {
    accessToken: accessToken ?? sessionStorage.getItem('fitlab_recovery_access_token') ?? '',
    refreshToken: refreshToken ?? sessionStorage.getItem('fitlab_recovery_refresh_token') ?? '',
    validType: type === 'recovery' || Boolean(sessionStorage.getItem('fitlab_recovery_access_token')),
    error: hash.get('error_description'),
  };
}

export function ResetPasswordPage() {
  const tokens = useMemo(recoveryTokens, []);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState(tokens.error ? decodeURIComponent(tokens.error.replace(/\+/g, ' ')) : '');
  const [loading, setLoading] = useState(false);
  const validLink = Boolean(tokens.accessToken && tokens.refreshToken && tokens.validType);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) return setError('Las contraseñas no coinciden.');
    setLoading(true); setError('');
    try {
      await api.post('/auth/reset-password', { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, password });
      sessionStorage.removeItem('fitlab_recovery_access_token');
      sessionStorage.removeItem('fitlab_recovery_refresh_token');
      window.location.assign('/');
    } catch (caught) { setError(apiErrorMessage(caught)); }
    finally { setLoading(false); }
  };
  return <div className="invite-page"><div className="login-tools"><ThemeToggle/></div><form className="invite-card" onSubmit={submit}><img src="/fitlab-logo.png" alt="FitLab"/><p className="eyebrow">SEGURIDAD DE LA CUENTA</p><h1>Nueva contraseña</h1><p className="muted">Elige una contraseña de al menos 8 caracteres.</p>{!validLink && <div className="alert error">El enlace no es válido o ya expiró. Solicita uno nuevo.</div>}{error && validLink && <div className="alert error">{error}</div>}<label>Nueva contraseña<input required type="password" minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password"/></label><label>Confirmar contraseña<input required type="password" minLength={8} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password"/></label><button className="primary" disabled={!validLink || loading}>{loading ? <><LoaderCircle className="spin"/>Guardando…</> : <><LockKeyhole/>Guardar contraseña</>}</button></form></div>;
}
