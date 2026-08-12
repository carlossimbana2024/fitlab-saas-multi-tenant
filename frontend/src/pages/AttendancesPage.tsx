import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Flame, LoaderCircle, Plus, RotateCcw, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';

type Member = { id: string; account_mode: 'portal' | 'managed'; managed_full_name?: string | null; profiles?: { full_name?: string } | null };
type Membership = { id: string; member_user_id: string; status: string; membership_periods?: Array<{ starts_on: string; ends_on: string; status: string }> };
type Attendance = { id: string; member_user_id: string; attendance_date: string; checked_in_at: string; source: string; counts_toward_streak: boolean; status: 'valid' | 'voided'; void_reason?: string | null };
type Streak = { member_user_id: string; status: string; current_streak: number; longest_streak: number; last_attendance_date?: string | null };
const memberName = (member: Member) => member.profiles?.full_name ?? member.managed_full_name ?? 'Miembro sin nombre';

function todayInGuayaquil() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts();
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function apiMessage(error: unknown) {
  const value = error as { response?: { data?: { error?: { code?: string; message?: string } } } };
  const payload = value.response?.data?.error;
  if (payload?.code === 'RESOURCE_ALREADY_EXISTS') return 'Este miembro ya tiene una asistencia válida registrada hoy.';
  return payload?.message ?? 'No se pudo completar la operación.';
}

export function AttendancesPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const today = todayInGuayaquil();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [memberId, setMemberId] = useState('');
  const [voidTarget, setVoidTarget] = useState<Attendance | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const members = useQuery({ queryKey: ['members'], queryFn: async () => (await api.get<{ members: Member[] }>('/members')).data.members });
  const memberships = useQuery({ queryKey: ['memberships'], queryFn: async () => (await api.get<{ memberships: Membership[] }>('/memberships')).data.memberships });
  const attendances = useQuery({ queryKey: ['attendances', today], queryFn: async () => (await api.get<{ attendances: Attendance[] }>('/attendances', { params: { from: today, to: today } })).data.attendances });
  const streaks = useQuery({ queryKey: ['streaks'], queryFn: async () => (await api.get<{ streaks: Streak[] }>('/attendances/streaks')).data.streaks });
  const memberNames = useMemo(() => new Map((members.data ?? []).map((member) => [member.id, memberName(member)])), [members.data]);
  const eligible = useMemo(() => (members.data ?? []).map((member) => ({ member, membership: (memberships.data ?? []).find((item) => item.member_user_id === member.id && item.status === 'active') })).filter((item) => item.membership), [members.data, memberships.data]);
  const refresh = async () => Promise.all([queryClient.invalidateQueries({ queryKey: ['attendances'] }), queryClient.invalidateQueries({ queryKey: ['streaks'] })]);

  const registerAttendance = useMutation({
    mutationFn: async () => {
      const membership = eligible.find((item) => item.member.id === memberId)?.membership;
      return api.post('/attendances/staff', { locationId: session?.gymUser?.default_location_id, memberUserId: memberId, membershipId: membership?.id });
    },
    onSuccess: async () => { setRegisterOpen(false); setMemberId(''); await refresh(); },
  });
  const voidAttendance = useMutation({
    mutationFn: async () => api.patch(`/attendances/${voidTarget?.id}/void`, { reason: voidReason }),
    onSuccess: async () => { setVoidTarget(null); setVoidReason(''); await refresh(); },
  });

  return <div className="page">
    <div className="page-heading"><div><p className="eyebrow">CONTROL DEL DÍA</p><h1>Asistencias</h1><p>Registros del {today}, según la zona horaria del gimnasio.</p></div><button className="primary" onClick={() => setRegisterOpen(true)} disabled={!session?.gymUser?.default_location_id || !eligible.length}><Plus size={18}/>Registrar asistencia</button></div>
    {!eligible.length && !memberships.isLoading && <div className="alert warning">No hay miembros con membresía activa disponibles para registrar.</div>}
    <div className="attendance-summary"><div className="stat-card"><span className="stat-icon green"><CalendarCheck/></span><div><p>Asistencias válidas hoy</p><strong>{attendances.data?.filter((item) => item.status === 'valid').length ?? 0}</strong></div></div><div className="stat-card"><span className="stat-icon orange"><Flame/></span><div><p>Mejor racha</p><strong>{Math.max(0, ...(streaks.data ?? []).map((item) => item.longest_streak))}</strong></div></div></div>
    <section className="panel"><div className="panel-title"><div><h2>Registros de hoy</h2><p>Las anulaciones permanecen visibles para auditoría.</p></div><span>{attendances.data?.length ?? 0} registros</span></div>
      {attendances.isLoading ? <div className="empty"><LoaderCircle className="spin"/><strong>Cargando asistencias…</strong></div> : attendances.data?.length ? <div className="attendance-list">{attendances.data.map((attendance) => {
        const streak = streaks.data?.find((item) => item.member_user_id === attendance.member_user_id);
        return <article className={`attendance-row ${attendance.status}`} key={attendance.id}><span className="avatar">{memberNames.get(attendance.member_user_id)?.slice(0, 2).toUpperCase() ?? 'FL'}</span><div><strong>{memberNames.get(attendance.member_user_id) ?? 'Miembro'}</strong><small>{new Date(attendance.checked_in_at).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })} · {attendance.source === 'staff' ? 'Registro manual' : 'QR'}</small></div><div className="streak-cell"><Flame size={17}/><strong>{streak?.current_streak ?? 0}</strong><small>racha</small></div><span className={`badge ${attendance.status}`}>{attendance.status === 'valid' ? 'Válida' : 'Anulada'}</span>{attendance.status === 'valid' && <button className="icon-button" title="Anular asistencia" onClick={() => setVoidTarget(attendance)}><RotateCcw size={17}/></button>}</article>;
      })}</div> : <div className="empty"><CalendarCheck/><strong>Aún no hay asistencias hoy</strong><span>Registra la llegada del primer miembro.</span></div>}
    </section>

    {registerOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setRegisterOpen(false); }}><section className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">NUEVA LLEGADA</p><h2>Registrar asistencia</h2></div><button className="icon-button" onClick={() => setRegisterOpen(false)}><X/></button></div><form className="checkout-form single" onSubmit={(event: FormEvent) => { event.preventDefault(); registerAttendance.mutate(); }}><label>Miembro con cobertura activa<select required value={memberId} onChange={(event) => setMemberId(event.target.value)}><option value="">Selecciona un miembro</option>{eligible.map(({ member }) => <option value={member.id} key={member.id}>{memberName(member)}{member.account_mode === 'managed' ? ' · Sin cuenta' : ''}</option>)}</select></label>{registerAttendance.isError && <div className="alert error">{apiMessage(registerAttendance.error)}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={() => setRegisterOpen(false)}>Cancelar</button><button className="primary" disabled={!memberId || registerAttendance.isPending}>{registerAttendance.isPending ? <><LoaderCircle className="spin"/>Registrando…</> : 'Confirmar llegada'}</button></div></form></section></div>}
    {voidTarget && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">CORRECCIÓN</p><h2>Anular asistencia</h2></div><button className="icon-button" onClick={() => setVoidTarget(null)}><X/></button></div><form className="checkout-form single" onSubmit={(event) => { event.preventDefault(); voidAttendance.mutate(); }}><p>La asistencia de <strong>{memberNames.get(voidTarget.member_user_id)}</strong> dejará de contar para la racha.</p><label>Motivo<textarea required minLength={3} maxLength={500} value={voidReason} onChange={(event) => setVoidReason(event.target.value)} placeholder="Ejemplo: registro realizado por error"/></label>{voidAttendance.isError && <div className="alert error">{apiMessage(voidAttendance.error)}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={() => setVoidTarget(null)}>Cancelar</button><button className="primary" disabled={voidReason.trim().length < 3 || voidAttendance.isPending}>{voidAttendance.isPending ? 'Anulando…' : 'Confirmar anulación'}</button></div></form></section></div>}
  </div>;
}
