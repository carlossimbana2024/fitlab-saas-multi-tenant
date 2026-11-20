import { KeyRound, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import axios from 'axios';
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { api, apiErrorMessage, registerAdminPinElevationHandler } from '../services/api';
import { type AdminPinGrant } from '../services/adminPinElevation';
import { createAdminPinQueue, type AdminPinQueue } from '../services/adminPinQueue';

const permissionNames: Record<string, string> = {
  'members.view': 'Ver miembros',
  'members.manage': 'Gestionar miembros',
  'attendance.register': 'Registrar asistencias',
  'attendance.void': 'Anular asistencias',
  'payments.register': 'Registrar pagos',
  'payments.void': 'Anular pagos',
  'finances.view': 'Ver finanzas',
  'products.manage': 'Gestionar productos',
  'inventory.adjust': 'Ajustar inventario',
  'sales.register': 'Registrar ventas',
  'sales.void': 'Anular ventas',
  'classes.manage': 'Gestionar clases',
  'classes.bookings_manage': 'Gestionar reservas',
  'classes.attendance_manage': 'Controlar asistencia de clases',
  'shifts.manage': 'Gestionar turnos',
  'reports.view': 'Ver reportes',
  'calendar.manage': 'Gestionar calendario',
  'settings.manage': 'Gestionar configuración',
};

export function AdminPinDialog() {
  const [queue] = useState(createAdminPinQueue);
  const pending = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  useLayoutEffect(() => {
    const unregister = registerAdminPinElevationHandler(queue.enqueue);
    return () => {
      unregister();
      queue.cancelAll();
    };
  }, [queue]);
  if (!pending) return null;
  return <PinPrompt key={pending.id} queue={queue} pending={pending}/>;
}

function PinPrompt({ queue, pending }: { queue: AdminPinQueue; pending: NonNullable<ReturnType<AdminPinQueue['getSnapshot']>> }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const submitting = useRef(false);
  const cancel = () => queue.cancelAll();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.signal.aborted || submitting.current || !/^\d{4,12}$/.test(pin)) return;
    submitting.current = true;
    setLoading(true);
    setError('');
    try {
      const response = await api.post<AdminPinGrant>('/permissions/elevate', {
        permission: pending.permission,
        pin,
      }, { signal: pending.signal, timeout: 15_000 });
      queue.resolve(pending, response.data);
    } catch (cause) {
      if (pending.signal.aborted) return;
      if (axios.isAxiosError(cause) && cause.response?.status === 429) queue.cancelAll(cause);
      else if (axios.isAxiosError(cause) && cause.response?.data?.error?.code === 'INVALID_ADMIN_PIN') {
        setPin('');
        setError(apiErrorMessage(cause));
      } else queue.reject(pending, cause);
    } finally {
      submitting.current = false;
      if (!pending.signal.aborted) setLoading(false);
    }
  };

  return <div className="modal-backdrop pin-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
    <section className="modal pin-dialog" role="dialog" aria-modal="true" aria-labelledby="pin-dialog-title">
      <div className="modal-heading"><div><p className="eyebrow">AUTORIZACIÓN ADMINISTRATIVA</p><h2 id="pin-dialog-title">Esta acción requiere PIN</h2></div><button className="icon-button" type="button" aria-label="Cancelar autorizaciones pendientes" onClick={cancel}><X/></button></div>
      <div className="security-note"><ShieldCheck/><p>El owner debe ingresar el PIN para autorizar una sola vez: <strong>{permissionNames[pending.permission] ?? pending.permission}</strong>.</p></div>
      <form className="pin-form" onSubmit={submit}><label>PIN administrativo<input autoFocus required disabled={loading} type="password" inputMode="numeric" autoComplete="off" pattern="\d{4,12}" minLength={4} maxLength={12} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}/></label>{error && <div className="alert error" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={cancel}>Cancelar</button><button className="primary" disabled={loading || !/^\d{4,12}$/.test(pin)}>{loading ? <><LoaderCircle className="spin"/>Validando…</> : <><KeyRound/>Autorizar una vez</>}</button></div></form>
    </section>
  </div>;
}
