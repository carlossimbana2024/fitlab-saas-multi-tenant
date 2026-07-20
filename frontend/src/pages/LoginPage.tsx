import { zodResolver } from '@hookform/resolvers/zod';
import { Dumbbell, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../services/api';

const schema = z.object({
  email: z.string().email('Ingresa un correo válido'),
  password: z.string().min(8, 'Mínimo 8 caracteres'),
});
type Form = z.infer<typeof schema>;

export function LoginPage() {
  const { login, session } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(schema) });
  if (session) return <Navigate to="/" replace/>;

  const submit = async (values: Form) => {
    try { setError(''); await login(values.email, values.password); navigate('/'); }
    catch (cause) { setError(apiErrorMessage(cause)); }
  };

  return <div className="login-page">
    <section className="login-visual"><img src="/fitlab-logo.png" alt="FitLab"/><div><p className="eyebrow">GESTIÓN QUE ENTRENA CONTIGO</p><h1>Tu gimnasio, más fuerte cada día.</h1><p>Miembros, pagos, asistencias y rachas en un solo lugar.</p></div></section>
    <section className="login-panel"><div className="login-tools"><ThemeToggle/></div><form className="login-card" onSubmit={handleSubmit(submit)}>
      <div className="login-icon"><Dumbbell/></div><p className="eyebrow">BIENVENIDO A FITLAB</p><h2>Inicia sesión</h2><p className="muted">Accede al panel de tu gimnasio.</p>
      {error && <div className="alert error">{error}</div>}
      <label>Correo electrónico<input type="email" autoComplete="email" placeholder="owner@fitlab.com" {...register('email')}/>{errors.email && <small>{errors.email.message}</small>}</label>
      <label>Contraseña<input type="password" autoComplete="current-password" placeholder="••••••••" {...register('password')}/>{errors.password && <small>{errors.password.message}</small>}</label>
      <Link className="password-link" to="/forgot-password">¿Olvidaste tu contraseña?</Link>
      <button className="primary" disabled={isSubmitting}>{isSubmitting ? <><LoaderCircle className="spin"/>Ingresando…</> : 'Ingresar a FitLab'}</button>
      <Link className="owner-register-link" to="/register-owner">¿Administras un gimnasio? Crear gimnasio</Link>
      <span className="secure-note">Sesión protegida mediante cookies HTTP-only</span>
    </form></section>
  </div>;
}
