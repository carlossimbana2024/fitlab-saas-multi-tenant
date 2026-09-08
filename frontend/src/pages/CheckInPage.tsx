import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, LoaderCircle, MapPin, QrCode } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';
import '../styles/attendanceQr.css';

type CheckIn = {
  gym_name: string; location_name: string; timezone: string; today: string; server_time: string;
  membership: { plan_name: string; ends_on: string } | null;
  already_registered: boolean;
  attendance: { id: string; checked_in_at: string; location_name: string } | null;
};

export function CheckInPage() {
  const { session, loading } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();
  // El fragmento no viaja a Vercel, al servidor ni en el encabezado Referer.
  const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
  const validToken = /^[A-Za-z0-9_-]{43}$/.test(token);
  const [preview, setPreview] = useState<CheckIn | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const memberId = session?.gymUser?.role === 'member' ? session.gymUser.id : null;
  useEffect(() => {
    setPreview(null);
    setError('');
    if (!memberId || !validToken) return;
    const controller = new AbortController();
    setBusy(true);
    api.post<CheckIn>('/attendances/qr/preview', { token }, { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setPreview(data); })
      .catch((cause) => { if (!controller.signal.aborted) setError(apiErrorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [memberId, token, validToken, attempt]);
  const confirm = useMutation({
    mutationFn: async () => (await api.post<CheckIn>('/attendances/qr/check-in', { token })).data,
    onSuccess: () => {
      for (const key of ['my-attendances', 'my-streak', 'my-weekly-progress']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
  if (loading) return <div className="splash">Cargando FitLab…</div>;
  if (!session && validToken) return <Navigate to="/login" replace state={{ returnTo: `/check-in${location.hash}` }}/>;
  const result = confirm.data ?? preview;
  const registered = Boolean(result?.attendance);
  const dateLabel = result ? new Intl.DateTimeFormat('es-EC', { dateStyle: 'full', timeZone: result.timezone }).format(new Date(result.server_time)) : '';
  return <main className="qr-checkin-page"><section className="panel qr-checkin-card">
    <div className="qr-checkin-tools"><img src="/fitlab-logo.png" alt="FitLab"/><ThemeToggle/></div>
    <p className="eyebrow">ASISTENCIA AL GIMNASIO</p><h1>{registered ? 'Entrada registrada' : 'Confirma tu llegada'}</h1>
    {!validToken ? <div className="qr-checkin-info"><QrCode size={48}/><p>Abre la cámara de tu teléfono y escanea el QR colocado en la entrada de tu sucursal.</p><p>Si no puedes escanearlo, solicita el registro manual en recepción.</p></div>
      : !memberId ? <div className="alert error">Este registro requiere una cuenta de miembro. Has ingresado con una cuenta administrativa.</div>
      : busy ? <p role="status"><LoaderCircle className="spin"/> Comprobando tu acceso…</p>
      : error ? <><div role="alert" className="alert error">{error}</div><button className="ghost" onClick={() => setAttempt((value) => value + 1)}>Volver a comprobar</button></>
      : result && <>
        <p>{session?.gymUser?.profiles?.full_name}</p><h2>{result.gym_name}</h2>
        <p className="qr-location"><MapPin/>{result.location_name}</p><p className="muted">{dateLabel}</p>
        {registered ? <div className="alert success" role="status"><CheckCircle2/><div><strong>{result.already_registered ? 'Ya habías registrado tu asistencia hoy.' : '¡Tu asistencia fue registrada!'} </strong><p>{result.attendance!.location_name} · {new Intl.DateTimeFormat('es-EC', { timeStyle: 'short', timeZone: result.timezone }).format(new Date(result.attendance!.checked_in_at))}</p><span>Se cuenta una sola asistencia al día.</span></div></div>
          : <><div className="qr-coverage"><strong>{result.membership?.plan_name}</strong><span>Cobertura hasta {result.membership?.ends_on}</span></div><p>Confirma cuando estés físicamente en esta sucursal. Al registrar se comprobarán el horario de atención y tu cobertura.</p>
            {confirm.isError && <div role="alert" className="alert error">{apiErrorMessage(confirm.error)} Puedes reintentar: tu asistencia no se duplicará.</div>}
            <button className="primary full-width" disabled={confirm.isPending} onClick={() => confirm.mutate()}>{confirm.isPending ? <LoaderCircle className="spin"/> : <CheckCircle2/>}{confirm.isPending ? 'Registrando…' : 'Confirmar asistencia'}</button></>}
      </>}
    <Link className="qr-back" to={session ? '/' : '/login'}>{memberId ? 'Volver a mi portal' : 'Volver a FitLab'}</Link>
  </section></main>;
}
