import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, CheckCircle2, Clock3, Flame, LoaderCircle, MapPin, RotateCcw, Search, UserCheck, X } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';

type ReceptionMember = {
  id: string;
  name: string;
  phone: string | null;
  status: 'invited' | 'active' | 'suspended' | 'inactive';
  accountMode: 'portal' | 'managed';
  location: { id: string; name: string; isActive: boolean } | null;
  membership: {
    id: string;
    status: string;
    planName: string;
    coverageStatus: 'active' | 'scheduled' | 'expired' | 'none';
    startsOn: string;
    endsOn: string;
  } | null;
  attendanceToday: { id: string; checkedInAt: string; source: string } | null;
  canCheckIn: boolean;
  blockCode: string | null;
  blockMessage: string;
};
type Attendance = {
  id: string;
  member_user_id: string;
  memberName: string;
  attendance_date: string;
  checked_in_at: string;
  source: string;
  status: 'valid' | 'voided';
  currentStreak: number;
  void_reason?: string | null;
};
type ReceptionOverview = {
  today: string;
  receptionLocation: { id: string; name: string; is_active: boolean } | null;
  members: ReceptionMember[];
  attendances: Attendance[];
  bestStreak: number;
};

const statusLabels: Record<ReceptionMember['status'], string> = {
  active: 'Activo',
  invited: 'Invitado',
  suspended: 'Suspendido',
  inactive: 'Retirado',
};

function attendanceError(error: unknown) {
  const value = error as { response?: { data?: { error?: { code?: string; message?: string } } } };
  const payload = value.response?.data?.error;
  if (payload?.code === 'RESOURCE_ALREADY_EXISTS') return 'Este miembro ya tiene una asistencia válida registrada hoy.';
  return payload?.message ?? apiErrorMessage(error);
}

function checkInTime(value: string) {
  return new Date(value).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' });
}

export function AttendancesPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [voidTarget, setVoidTarget] = useState<Attendance | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const role = session?.gymUser?.role;
  const hasPermission = (key: string) => role === 'owner' || Boolean(session?.gymUser?.staff_permissions?.some((permission) => permission.permission_key === key && permission.access_mode !== 'denied'));
  const canRegister = hasPermission('attendance.register');
  const canVoid = hasPermission('attendance.void');

  const reception = useQuery({
    queryKey: ['attendance-reception'],
    queryFn: async () => (await api.get<ReceptionOverview>('/attendances/reception')).data,
  });
  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['attendance-reception'] });
  const registerAttendance = useMutation({
    mutationFn: async (member: ReceptionMember) => api.post('/attendances/staff', {
      locationId: reception.data?.receptionLocation?.id,
      memberUserId: member.id,
      membershipId: member.membership?.id,
    }),
    onSuccess: async (_result, member) => {
      setSuccessMessage(`Asistencia de ${member.name} registrada correctamente.`);
      setSearch('');
      await refresh();
      searchInput.current?.focus();
    },
  });
  const voidAttendance = useMutation({
    mutationFn: async () => api.patch(`/attendances/${voidTarget?.id}/void`, { reason: voidReason }),
    onSuccess: async () => {
      setVoidTarget(null);
      setVoidReason('');
      await refresh();
    },
  });

  const visibleMembers = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('es');
    const phoneNeedle = search.replace(/\D/g, '');
    return (reception.data?.members ?? []).filter((member) => {
      if (!needle) return true;
      const phone = member.phone?.replace(/\D/g, '') ?? '';
      return member.name.toLocaleLowerCase('es').includes(needle)
        || Boolean(phoneNeedle && phone.includes(phoneNeedle));
    }).slice(0, 20);
  }, [reception.data?.members, search]);
  const validAttendances = reception.data?.attendances.filter((attendance) => attendance.status === 'valid') ?? [];
  const locationReady = Boolean(reception.data?.receptionLocation?.is_active);

  return <div className="page attendance-page">
    <div className="page-heading"><div><p className="eyebrow">OPERACIÓN DE RECEPCIÓN</p><h1>Asistencias</h1><p>Busca por nombre o teléfono y registra una llegada en un solo paso.</p></div><button className="primary" onClick={() => searchInput.current?.focus()}><Search size={18}/>Buscar llegada</button></div>
    {successMessage && <div className="alert success reception-success"><span><CheckCircle2/> {successMessage}</span><button className="icon-button" onClick={() => setSuccessMessage('')}><X/></button></div>}
    {!locationReady && !reception.isLoading && <div className="alert warning">Tu usuario no tiene una sucursal predeterminada activa. Debes asignarla antes de registrar asistencias.</div>}
    {reception.isError && <div className="alert error">{apiErrorMessage(reception.error)}</div>}

    <section className="panel reception-panel">
      <div className="panel-title"><div><h2>Recepción rápida</h2><p>{reception.data?.receptionLocation ? `Registrando en ${reception.data.receptionLocation.name}` : 'Selecciona una sucursal predeterminada'}</p></div><UserCheck/></div>
      <div className="reception-search"><Search/><input ref={searchInput} autoFocus value={search} onChange={(event) => { setSearch(event.target.value); setSuccessMessage(''); registerAttendance.reset(); }} placeholder="Nombre o teléfono del miembro" aria-label="Buscar miembro por nombre o teléfono"/>{search && <button className="icon-button" onClick={() => { setSearch(''); searchInput.current?.focus(); }} aria-label="Limpiar búsqueda"><X/></button>}</div>
      {registerAttendance.isError && <div className="alert error reception-error">{attendanceError(registerAttendance.error)}</div>}
      {reception.isLoading ? <div className="empty"><LoaderCircle className="spin"/><strong>Preparando recepción…</strong></div> : visibleMembers.length ? <div className="reception-results">{visibleMembers.map((member) => {
        const isRegistering = registerAttendance.isPending && registerAttendance.variables?.id === member.id;
        const canSubmit = canRegister && locationReady && member.canCheckIn && Boolean(member.membership?.id);
        return <article className={`reception-member ${member.canCheckIn ? 'ready' : 'blocked'}`} key={member.id}>
          <span className="avatar">{member.name.slice(0, 2).toUpperCase()}</span>
          <div className="reception-identity"><strong>{member.name}</strong><small>{member.phone || 'Sin teléfono'}{member.accountMode === 'managed' ? ' · Sin cuenta' : ''}</small><span className={`badge ${member.status}`}>{statusLabels[member.status]}</span></div>
          <div className="reception-location"><small>SUCURSAL</small><strong><MapPin/>{member.location?.name ?? 'Sin asignar'}</strong></div>
          <div className="reception-membership"><small>MEMBRESÍA</small><strong>{member.membership?.planName ?? 'Sin membresía'}</strong><span>{member.membership?.coverageStatus === 'active' ? `Vigente hasta ${member.membership.endsOn}` : member.membership?.coverageStatus === 'scheduled' ? `Inicia ${member.membership.startsOn}` : member.membership?.coverageStatus === 'expired' ? `Venció ${member.membership.endsOn}` : 'Sin cobertura'}</span></div>
          <div className={`reception-decision ${member.canCheckIn ? 'allowed' : ''}`}><span>{member.attendanceToday ? <Clock3/> : member.canCheckIn ? <CheckCircle2/> : <X/>}{member.blockMessage}</span>{member.attendanceToday && <small>Entrada: {checkInTime(member.attendanceToday.checkedInAt)}</small>}</div>
          <button className={canSubmit ? 'primary compact' : 'small-button'} disabled={!canSubmit || registerAttendance.isPending} onClick={() => registerAttendance.mutate(member)}>{isRegistering ? <LoaderCircle className="spin"/> : member.attendanceToday ? <CheckCircle2/> : <UserCheck/>}{isRegistering ? 'Registrando…' : member.attendanceToday ? 'Registrado hoy' : !canRegister ? 'Sin permiso' : 'Registrar entrada'}</button>
        </article>;
      })}</div> : <div className="empty"><Search/><strong>No encontramos coincidencias</strong><span>Comprueba el nombre o los dígitos del teléfono.</span></div>}
      {!search && (reception.data?.members.length ?? 0) > visibleMembers.length && <p className="reception-hint">Mostrando los primeros 20 miembros. Escribe un nombre o teléfono para encontrar a los demás.</p>}
    </section>

    <div className="attendance-summary"><div className="stat-card"><span className="stat-icon green"><CalendarCheck/></span><div><p>Asistencias válidas hoy</p><strong>{validAttendances.length}</strong></div></div><div className="stat-card"><span className="stat-icon orange"><Flame/></span><div><p>Mejor racha</p><strong>{reception.data?.bestStreak ?? 0}</strong></div></div></div>
    <section className="panel"><div className="panel-title"><div><h2>Registros de hoy</h2><p>Las anulaciones permanecen visibles para auditoría.</p></div><span>{reception.data?.attendances.length ?? 0} registros</span></div>
      {reception.isLoading ? <div className="empty"><LoaderCircle className="spin"/><strong>Cargando asistencias…</strong></div> : reception.data?.attendances.length ? <div className="attendance-list">{reception.data.attendances.map((attendance) => <article className={`attendance-row ${attendance.status}`} key={attendance.id}><span className="avatar">{attendance.memberName.slice(0, 2).toUpperCase()}</span><div><strong>{attendance.memberName}</strong><small>{checkInTime(attendance.checked_in_at)} · {attendance.source === 'staff' ? 'Registro manual' : 'QR'}</small></div><div className="streak-cell"><Flame size={17}/><strong>{attendance.currentStreak}</strong><small>racha</small></div><span className={`badge ${attendance.status}`}>{attendance.status === 'valid' ? 'Válida' : 'Anulada'}</span>{canVoid && attendance.status === 'valid' ? <button className="icon-button" title="Anular asistencia" onClick={() => setVoidTarget(attendance)}><RotateCcw size={17}/></button> : <span/>}</article>)}</div> : <div className="empty"><CalendarCheck/><strong>Aún no hay asistencias hoy</strong><span>Busca al primer miembro en recepción.</span></div>}
    </section>

    {voidTarget && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">CORRECCIÓN</p><h2>Anular asistencia</h2></div><button className="icon-button" onClick={() => setVoidTarget(null)}><X/></button></div><form className="checkout-form single" onSubmit={(event: FormEvent) => { event.preventDefault(); voidAttendance.mutate(); }}><p>La asistencia de <strong>{voidTarget.memberName}</strong> dejará de contar para la racha.</p><label>Motivo<textarea required minLength={3} maxLength={500} value={voidReason} onChange={(event) => setVoidReason(event.target.value)} placeholder="Ejemplo: registro realizado por error"/></label>{voidAttendance.isError && <div className="alert error">{attendanceError(voidAttendance.error)}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={() => setVoidTarget(null)}>Cancelar</button><button className="primary" disabled={voidReason.trim().length < 3 || voidAttendance.isPending}>{voidAttendance.isPending ? 'Anulando…' : 'Confirmar anulación'}</button></div></form></section></div>}
  </div>;
}
