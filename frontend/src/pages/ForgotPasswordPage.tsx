import { ArrowLeft, LoaderCircle, Mail } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';
import { api, apiErrorMessage } from '../services/api';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError('');
    try {
      const result = await api.post<{ message: string }>('/auth/request-password-reset', { email });
      setMessage(result.data.message);
    } catch (caught) { setError(apiErrorMessage(caught)); }
    finally { setLoading(false); }
  };
  return <div className="invite-page"><div className="login-tools"><ThemeToggle/></div><form className="invite-card" onSubmit={submit}><img src="/fitlab-logo.png" alt="FitLab"/><p className="eyebrow">RECUPERA TU ACCESO</p><h1>Olvidé mi contraseña</h1><p className="muted">Te enviaremos un enlace seguro si el correo está registrado.</p>{message && <div className="alert success">{message}</div>}{error && <div className="alert error">{error}</div>}<label>Correo electrónico<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email"/></label><button className="primary" disabled={loading || Boolean(message)}>{loading ? <><LoaderCircle className="spin"/>Enviando…</> : <><Mail/>Enviar enlace</>}</button><Link className="back-link" to="/login"><ArrowLeft/>Volver al inicio de sesión</Link></form></div>;
}
