import { KeyRound, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api, apiErrorMessage, registerAdminPinElevationHandler } from '../services/api';

type PendingElevation = {
  permission: string;
  resolve: (token: string) => void;
  reject: (error: Error) => void;
};

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
  const [pending, setPending] = useState<PendingElevation | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => registerAdminPinElevationHandler((permission) => new Promise<string>((resolve, reject) => {
    setPin('');
    setError('');
    setPending({ permission, resolve, reject });
  })), []);

  const cancel = () => {
    pending?.reject(new Error('La autorización por PIN fue cancelada.'));
    setPending(null);
    setPin('');
    setError('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!pending) return;
    setLoading(true);
    setError('');
    try {
      const response = await api.post<{ token: string }>('/permissions/elevate', {
        permission: pending.permission,
        pin,
      });
      pending.resolve(response.data.token);
      setPending(null);
      setPin('');
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  if (!pending) return null;
  return <div className="modal-backdrop pin-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !loading) cancel(); }}>
    <section className="modal pin-dialog" role="dialog" aria-modal="true" aria-labelledby="pin-dialog-title">
      <div className="modal-heading"><div><p className="eyebrow">AUTORIZACIÓN ADMINISTRATIVA</p><h2 id="pin-dialog-title">Esta acción requiere PIN</h2></div><button className="icon-button" type="button" disabled={loading} onClick={cancel}><X/></button></div>
      <div className="security-note"><ShieldCheck/><p>El owner debe ingresar el PIN para autorizar una sola vez: <strong>{permissionNames[pending.permission] ?? pending.permission}</strong>.</p></div>
      <form className="pin-form" onSubmit={submit}><label>PIN administrativo<input autoFocus required type="password" inputMode="numeric" autoComplete="off" pattern="\d{4,12}" minLength={4} maxLength={12} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}/></label>{error && <div className="alert error">{error}</div>}<div className="modal-actions"><button type="button" className="ghost" disabled={loading} onClick={cancel}>Cancelar</button><button className="primary" disabled={loading || !/^\d{4,12}$/.test(pin)}>{loading ? <><LoaderCircle className="spin"/>Validando…</> : <><KeyRound/>Autorizar una vez</>}</button></div></form>
    </section>
  </div>;
}
