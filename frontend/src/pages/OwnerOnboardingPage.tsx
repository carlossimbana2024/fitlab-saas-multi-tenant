import { zodResolver } from '@hookform/resolvers/zod';
import { Building2, LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';

const schema = z.object({ gymName: z.string().trim().min(2, 'Ingresa el nombre del gimnasio'), locationName: z.string().trim().min(2, 'Ingresa el nombre de la sucursal'), address: z.string().trim().max(250), city: z.string().trim().min(2, 'Ingresa la ciudad') });
type Form = z.infer<typeof schema>;
function recoveryTokens() { const values = new URLSearchParams(window.location.hash.replace(/^#/, '')); return { accessToken: values.get('access_token') ?? '', refreshToken: values.get('refresh_token') ?? '' }; }

export function OwnerOnboardingPage() {
  const tokens = useMemo(recoveryTokens, []); const { refresh } = useAuth(); const navigate = useNavigate();
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { locationName: 'Sucursal Principal', city: 'Quito', address: '' } });
  const submit = async (values: Form) => { try {
    setError('');
    const verification = tokens.accessToken && tokens.refreshToken ? tokens : {};
    await api.post('/auth/complete-owner-onboarding', { ...verification, ...values, timezone: 'America/Guayaquil' });
    window.history.replaceState(null, '', '/owner/confirm');
    await refresh();
    navigate('/dashboard', { replace: true });
  } catch (cause) { setError(apiErrorMessage(cause)); } };
  return <div className="invite-page"><div className="login-tools"><ThemeToggle/></div><form className="invite-card owner-register-card" onSubmit={handleSubmit(submit)}>
    <img src="/fitlab-logo.png" alt="FitLab"/><div><p className="eyebrow">CORREO VERIFICADO</p><h1>Configura tu gimnasio</h1><p className="muted">Al terminar comenzará tu prueba gratuita de 30 días.</p></div>
    {error && <div className="alert error">{error}</div>}
    <label>Nombre del gimnasio<input {...register('gymName')}/>{errors.gymName && <small>{errors.gymName.message}</small>}</label>
    <label>Nombre de la primera sucursal<input {...register('locationName')}/>{errors.locationName && <small>{errors.locationName.message}</small>}</label>
    <label>Dirección opcional<input {...register('address')}/></label>
    <label>Ciudad<input {...register('city')}/>{errors.city && <small>{errors.city.message}</small>}</label>
    <div className="trial-note"><Building2/><span><strong>30 días gratis</strong><small>Sin tarjeta y sin eliminar tus datos al terminar.</small></span></div>
    <button className="primary" disabled={isSubmitting}>{isSubmitting ? <><LoaderCircle className="spin"/>Configurando…</> : 'Iniciar prueba gratuita'}</button>
    <Link className="back-link" to="/login">Volver al inicio</Link>
  </form></div>;
}
