import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, LoaderCircle, MapPin, QrCode } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';
import { AttendanceQrScanner } from '../components/AttendanceQrScanner';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';
import { attendanceTokenFromHash } from '../utils/attendanceQr';
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
  const navigate = useNavigate();
  // El fragmento no viaja a Vercel, al servidor ni en el encabezado Referer.
  const token = attendanceTokenFromHash(location.hash);
  const memberId = session?.gymUser?.role === 'member' ? session.gymUser.id : null;
  if (loading) return <div className="splash">Cargando FitLab…</div>;
  if (!session && token) return <Navigate to="/login" replace state={{ returnTo: `/check-in#token=${token}` }}/>;
  return <main className="qr-checkin-page"><section className="panel qr-checkin-card">
    <div className="qr-checkin-tools"><img src="/fitlab-logo.png" alt="FitLab"/><ThemeToggle/></div>
    <p className="eyebrow">ASISTENCIA AL GIMNASIO</p>
    {!session ? <><h1>Escanea tu asistencia</h1><div className="qr-checkin-info"><QrCode size={48}/><p>Inicia sesión con tu cuenta de miembro para usar el escáner interno. También puedes escanear el cartel con la cámara de tu celular.</p><Link className="primary full-width" to="/login" state={{ returnTo: '/check-in' }}>Iniciar sesión</Link></div></>
      : !memberId ? <><h1>Asistencia de miembros</h1><div className="alert error">Este registro requiere una cuenta de miembro. Has ingresado con una cuenta administrativa.</div></>
      : token ? <QrAttendanceConfirmation key={`${memberId}:${token}`} token={token} memberId={memberId} memberName={session.gymUser?.profiles?.full_name ?? ''} onRescan={() => navigate('/check-in', { replace: true })}/>
      : <><h1>Escanea tu asistencia</h1>{location.hash && <p className="alert error" role="alert">El enlace de asistencia no es válido. Escanea nuevamente el cartel de tu sucursal.</p>}<AttendanceQrScanner key={memberId} onToken={value => navigate(`/check-in#token=${value}`, { replace: true })}/></>}
    <Link className="qr-back" to={session ? '/' : '/login'}>{memberId ? 'Volver a mi portal' : 'Volver a FitLab'}</Link>
  </section></main>;
}

/** External camera links and the internal scanner share exactly this operation.
 * A keyed instance prevents a late response from a former QR/member showing here.
 */
function QrAttendanceConfirmation({ token, memberId, memberName, onRescan }: { token: string; memberId: string; memberName: string; onRescan: () => void }) {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<CheckIn | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const submitting = useRef(false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    setPreview(null);
    setError('');
    if (!navigator.onLine) { setBusy(false); setError('Conéctate a internet y pulsa Volver a comprobar.'); return; }
    const controller = new AbortController();
    setBusy(true);
    api.post<CheckIn>('/attendances/qr/preview', { token }, { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setPreview(data); })
      .catch((cause) => { if (!controller.signal.aborted) setError(apiErrorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [memberId, token, attempt]);
  const confirm = useMutation({
    networkMode: 'always',
    retry: false,
    mutationFn: async () => {
      if (!navigator.onLine) throw new Error('Conéctate a internet para confirmar. No se guardarán asistencias pendientes para enviarlas después.');
      return (await api.post<CheckIn>('/attendances/qr/check-in', { token })).data;
    },
    onSuccess: () => {
      for (const key of ['my-attendances', 'my-streak', 'my-weekly-progress', 'my-progress', 'member-community', 'member-community-rankings', 'member-social-profile', 'loyalty-engagement', 'member-training-social']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    onSettled: () => { submitting.current = false; },
  });
  const result = confirm.data ?? preview;
  const registered = Boolean(result?.attendance);
  const dateLabel = result ? new Intl.DateTimeFormat('es-EC', { dateStyle: 'full', timeZone: result.timezone }).format(new Date(result.server_time)) : '';
  return <>
    <h1>{registered ? 'Entrada registrada' : 'Confirma tu llegada'}</h1>
    {!online && <p className="alert error" role="alert">Sin conexión. No se puede confirmar una nueva asistencia. No se enviará automáticamente al reconectar.</p>}
    {busy ? <p role="status"><LoaderCircle className="spin"/> Comprobando tu acceso…</p>
      : error ? <><div role="alert" className="alert error">{error}</div><button className="ghost" onClick={() => setAttempt((value) => value + 1)}>Volver a comprobar</button></>
      : result && <>
        <p>{memberName}</p><h2>{result.gym_name}</h2>
        <p className="qr-location"><MapPin/>{registered ? result.attendance!.location_name : result.location_name}</p><p className="muted">{dateLabel}</p>
        {registered ? <div className="alert success" role="status"><CheckCircle2/><div><strong>{result.already_registered ? 'Ya habías registrado tu asistencia hoy.' : '¡Tu asistencia fue registrada!'} </strong><p>{result.attendance!.location_name} · {new Intl.DateTimeFormat('es-EC', { timeStyle: 'short', timeZone: result.timezone }).format(new Date(result.attendance!.checked_in_at))}</p><span>Se cuenta una sola asistencia al día.{result.already_registered ? ' No se creó otra entrada ni se cambió su sucursal.' : ''}</span></div></div>
          : <><div className="qr-coverage"><strong>{result.membership?.plan_name}</strong><span>Cobertura hasta {result.membership?.ends_on}</span></div><p>Confirma cuando estés físicamente en esta sucursal. Al registrar se comprobarán el horario de atención y tu cobertura.</p>
            {confirm.isError && <div role="alert" className="alert error">{apiErrorMessage(confirm.error)} Puedes reintentar: tu asistencia no se duplicará.</div>}
            <button type="button" className="primary full-width" disabled={confirm.isPending || !online} onClick={() => { if (submitting.current || !navigator.onLine) return; submitting.current = true; confirm.mutate(); }}>{confirm.isPending ? <LoaderCircle className="spin"/> : <CheckCircle2/>}{confirm.isPending ? 'Registrando…' : 'Confirmar asistencia'}</button></>}
      </>}
    {!registered && <button type="button" className="ghost full-width qr-rescan" disabled={confirm.isPending} onClick={onRescan}><QrCode/>Escanear otro QR</button>}
  </>;
}
