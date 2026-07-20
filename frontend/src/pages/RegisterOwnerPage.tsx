import { zodResolver } from '@hookform/resolvers/zod';
import { Building2, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { ThemeToggle } from '../components/ThemeToggle';
import { api, apiErrorMessage } from '../services/api';

const schema = z.object({
  fullName: z.string().trim().min(2, 'Ingresa tu nombre completo'),
  email: z.string().email('Ingresa un correo válido'),
  password: z.string().min(8, 'Mínimo 8 caracteres'),
  confirmPassword: z.string(),
  acceptsTerms: z.literal(true, { message: 'Debes aceptar los términos' }),
  acceptsPrivacy: z.literal(true, { message: 'Debes aceptar la política de privacidad' }),
}).refine((value) => value.password === value.confirmPassword, { path: ['confirmPassword'], message: 'Las contraseñas no coinciden' });
type Form = z.infer<typeof schema>;

export function RegisterOwnerPage() {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(schema) });
  const submit = async ({ confirmPassword: _confirmPassword, ...values }: Form) => {
    try {
      setError('');
      const { data } = await api.post<{ message: string }>('/auth/register-owner', values);
      setMessage(data.message);
    } catch (cause) { setError(apiErrorMessage(cause)); }
  };

  return <div className="invite-page"><div className="login-tools"><ThemeToggle/></div><form className="invite-card owner-register-card" onSubmit={handleSubmit(submit)}>
    <img src="/fitlab-logo.png" alt="FitLab"/><div><p className="eyebrow">NUEVO GIMNASIO</p><h1>Crea tu cuenta</h1><p className="muted">Registro exclusivo para propietarios. Miembros y staff ingresan mediante invitación.</p></div>
    {message && <div className="alert success">{message}</div>}
    {error && <div className="alert error">{error}</div>}
    {!message && <>
      <label>Nombre completo<input autoComplete="name" {...register('fullName')}/>{errors.fullName && <small>{errors.fullName.message}</small>}</label>
      <label>Correo electrónico<input type="email" autoComplete="email" {...register('email')}/>{errors.email && <small>{errors.email.message}</small>}</label>
      <label>Contraseña<input type="password" autoComplete="new-password" {...register('password')}/>{errors.password && <small>{errors.password.message}</small>}</label>
      <label>Confirmar contraseña<input type="password" autoComplete="new-password" {...register('confirmPassword')}/>{errors.confirmPassword && <small>{errors.confirmPassword.message}</small>}</label>
      <label className="legal-check"><input type="checkbox" {...register('acceptsTerms')}/><span>Acepto los <Link to="/legal/terms" target="_blank">términos de uso</Link>.</span></label>
      <label className="legal-check"><input type="checkbox" {...register('acceptsPrivacy')}/><span>Acepto la <Link to="/legal/privacy" target="_blank">política de privacidad</Link>.</span></label>
      {(errors.acceptsTerms || errors.acceptsPrivacy) && <small>Debes aceptar ambos documentos para continuar.</small>}
      <button className="primary" disabled={isSubmitting}>{isSubmitting ? <><LoaderCircle className="spin"/>Creando…</> : <><Building2/>Crear gimnasio</>}</button>
    </>}
    <Link className="back-link" to="/login">Volver al inicio de sesión</Link>
  </form></div>;
}
