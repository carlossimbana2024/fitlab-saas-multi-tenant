import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Ban, CalendarCheck, CreditCard, Edit3, Flame, LoaderCircle, Mail, RotateCcw, Save, Search, Trash2, UserPlus, Users, WalletCards, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';

type Profile = { full_name?: string; phone?: string; avatar_url?: string };
type Member = {
  id: string;
  status: 'invited' | 'active' | 'suspended' | 'inactive';
  account_mode: 'portal' | 'managed';
  invitation_id?: string | null;
  default_location_id?: string | null;
  managed_full_name?: string | null;
  managed_phone?: string | null;
  managed_birth_date?: string | null;
  managed_guardian_name?: string | null;
  managed_guardian_phone?: string | null;
  managed_notes?: string | null;
  joined_at?: string | null;
  profiles?: Profile | null;
  invitation?: { email?: string; status?: string; expires_at?: string } | null;
};
type Location = { id: string; name: string; is_main: boolean };
type Membership = { id: string; status: string; price_at_purchase: number; currency: string; plans?: { name?: string }; membership_periods?: Array<{ starts_on: string; ends_on: string; status: string }> };
type Payment = { id: string; amount: number; currency: string; payment_method: string; status: string; paid_at: string };
type Attendance = { id: string; attendance_date: string; checked_in_at: string; source: string; status: string };
type Streak = { status: string; current_streak: number; longest_streak: number; last_attendance_date?: string | null };
type MemberSummary = { coverageStatus: 'active' | 'expired' | 'none'; planName?: string | null; startsOn?: string | null; endsOn?: string | null; currency: string; totalCharged: number; totalPaid: number; outstanding: number };
type MemberDetail = { member: Member; memberships: Membership[]; payments: Payment[]; attendances: Attendance[]; streak: Streak | null; summary: MemberSummary };
type MembersPayload = { members: Member[]; retiredMembers: Member[]; locations: Location[] };
type MemberForm = {
  mode: 'portal' | 'managed';
  fullName: string;
  email: string;
  phone: string;
  birthDate: string;
  guardianName: string;
  guardianPhone: string;
  notes: string;
  defaultLocationId: string;
};

const emptyMemberForm: MemberForm = { mode: 'portal', fullName: '', email: '', phone: '', birthDate: '', guardianName: '', guardianPhone: '', notes: '', defaultLocationId: '' };
const statusLabel: Record<Member['status'], string> = { active: 'Activo', invited: 'Invitado', suspended: 'Suspendido', inactive: 'Retirado' };
const coverageLabel: Record<MemberSummary['coverageStatus'], string> = { active: 'Vigente', expired: 'Vencida', none: 'Sin membresía' };

const memberName = (member?: Member) => member?.profiles?.full_name ?? member?.managed_full_name ?? 'Sin nombre';
const memberPhone = (member?: Member) => member?.profiles?.phone ?? member?.managed_phone ?? 'Sin teléfono';

function formFromMember(member: Member): MemberForm {
  return {
    mode: member.account_mode,
    fullName: memberName(member),
    email: member.invitation?.email ?? '',
    phone: member.profiles?.phone ?? member.managed_phone ?? '',
    birthDate: member.managed_birth_date ?? '',
    guardianName: member.managed_guardian_name ?? '',
    guardianPhone: member.managed_guardian_phone ?? '',
    notes: member.managed_notes ?? '',
    defaultLocationId: member.default_location_id ?? '',
  };
}

export function MembersPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [directoryView, setDirectoryView] = useState<'current' | 'retired'>('current');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [inviteForm, setInviteForm] = useState<MemberForm>(emptyMemberForm);
  const [editForm, setEditForm] = useState<MemberForm>(emptyMemberForm);
  const [conversionEmail, setConversionEmail] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  // Esta consulta devuelve un objeto con directorios y sucursales. No debe
  // compartir cache con Dashboard/Asistencias/Membresias, donde ['members']
  // contiene exclusivamente Member[].
  const members = useQuery({ queryKey: ['members-directory'], queryFn: async () => (await api.get<MembersPayload>('/members')).data });
  const detail = useQuery({ queryKey: ['member-detail', selectedId], queryFn: async () => (await api.get<MemberDetail>(`/members/${selectedId}`)).data, enabled: Boolean(selectedId) });
  const directory = directoryView === 'current' ? members.data?.members ?? [] : members.data?.retiredMembers ?? [];
  const visibleMembers = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('es');
    if (!needle) return directory;
    return directory.filter((member) => `${memberName(member)} ${memberPhone(member)} ${member.invitation?.email ?? ''}`.toLocaleLowerCase('es').includes(needle));
  }, [directory, search]);
  const canManage = session?.gymUser?.role === 'owner' || session?.gymUser?.staff_permissions?.some((permission) => permission.permission_key === 'members.manage' && permission.access_mode !== 'denied');

  useEffect(() => {
    if (detail.data?.member) setEditForm(formFromMember(detail.data.member));
  }, [detail.data?.member]);

  const refresh = async () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['members-directory'] }),
    queryClient.invalidateQueries({ queryKey: ['members'] }),
    queryClient.invalidateQueries({ queryKey: ['member-detail', selectedId] }),
  ]);
  const invite = useMutation({
    mutationFn: async () => inviteForm.mode === 'portal'
      ? api.post('/members/invite', { fullName: inviteForm.fullName, email: inviteForm.email, phone: inviteForm.phone.trim() || null, defaultLocationId: inviteForm.defaultLocationId || null })
      : api.post('/members/managed', {
          fullName: inviteForm.fullName,
          phone: inviteForm.phone.trim() || null,
          birthDate: inviteForm.birthDate || null,
          guardianName: inviteForm.guardianName.trim() || null,
          guardianPhone: inviteForm.guardianPhone.trim() || null,
          notes: inviteForm.notes.trim() || null,
          defaultLocationId: inviteForm.defaultLocationId || null,
        }),
    onSuccess: async () => {
      setInviteOpen(false);
      setMessage(inviteForm.mode === 'portal' ? `Invitación enviada a ${inviteForm.email}.` : `${inviteForm.fullName} fue registrado sin cuenta.`);
      setInviteForm(emptyMemberForm);
      await refresh();
    },
  });
  const save = useMutation({
    mutationFn: async () => api.put(`/members/${selectedId}`, {
      fullName: editForm.fullName,
      phone: editForm.phone.trim() || null,
      birthDate: editForm.birthDate || null,
      guardianName: editForm.guardianName.trim() || null,
      guardianPhone: editForm.guardianPhone.trim() || null,
      notes: editForm.notes.trim() || null,
      defaultLocationId: editForm.defaultLocationId || null,
    }),
    onSuccess: async () => { setEditing(false); setMessage('Datos del miembro actualizados.'); await refresh(); },
  });
  const changeStatus = useMutation({
    mutationFn: async (status: 'active' | 'suspended') => api.patch(`/members/${selectedId}/status`, { status }),
    onSuccess: async (_response, status) => { setMessage(status === 'active' ? 'Miembro reactivado.' : 'Miembro suspendido.'); await refresh(); },
  });
  const retire = useMutation({
    mutationFn: async () => api.delete(`/members/${selectedId}`),
    onSuccess: async () => { setSelectedId(null); setDirectoryView('retired'); setMessage('Miembro retirado. Su historial se conserva íntegramente.'); await refresh(); },
  });
  const reinstate = useMutation({
    mutationFn: async () => api.post(`/members/${selectedId}/reinstate`),
    onSuccess: async () => { setDirectoryView('current'); setMessage('Miembro reincorporado con su historial anterior.'); await refresh(); },
  });
  const convert = useMutation({
    mutationFn: async () => api.post(`/members/${selectedId}/convert-to-portal`, { email: conversionEmail }),
    onSuccess: async () => { setConvertOpen(false); setConversionEmail(''); setMessage('Invitación enviada. La misma ficha e historial pasarán al portal cuando el miembro active su cuenta.'); await refresh(); },
  });
  const revoke = useMutation({
    mutationFn: async (invitationId: string) => api.delete(`/members/invitations/${invitationId}`),
    onSuccess: async () => { setSelectedId(null); setMessage('La invitación fue revocada.'); await refresh(); },
  });
  const mutationError = save.error ?? changeStatus.error ?? retire.error ?? reinstate.error ?? convert.error ?? revoke.error;

  return <div className="page">
    <div className="page-heading"><div><p className="eyebrow">COMUNIDAD</p><h1>Miembros</h1><p>Administra acceso, datos, cobertura e historial de cada persona.</p></div>{canManage && <button className="primary" onClick={() => { setMessage(''); setInviteOpen(true); }}><UserPlus size={18}/>Nuevo miembro</button>}</div>
    {message && <div className="alert success">{message}</div>}
    <section className="panel member-directory">
      <div className="directory-tabs"><button className={directoryView === 'current' ? 'active' : ''} onClick={() => { setDirectoryView('current'); setSelectedId(null); }}><Users/>Actuales <span>{members.data?.members.length ?? 0}</span></button><button className={directoryView === 'retired' ? 'active' : ''} onClick={() => { setDirectoryView('retired'); setSelectedId(null); }}><Archive/>Retirados <span>{members.data?.retiredMembers.length ?? 0}</span></button></div>
      <div className="table-tools"><div className="search"><Search/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nombre, teléfono o correo…"/></div><span>{visibleMembers.length} miembros</span></div>
      {members.isLoading ? <div className="empty"><LoaderCircle className="spin"/>Cargando miembros…</div> : visibleMembers.length ? <div className="member-list">{visibleMembers.map((member) => <button className="member-row member-button" key={member.id} onClick={() => { setEditing(false); setSelectedId(member.id); }}><span className="avatar">{memberName(member).slice(0, 2).toUpperCase()}</span><div><strong>{memberName(member)}</strong><small>{memberPhone(member)}{member.account_mode === 'managed' ? ' · Sin cuenta' : member.invitation?.email ? ` · ${member.invitation.email}` : ''}</small></div><span className={`badge ${member.status}`}>{statusLabel[member.status]}</span></button>)}</div> : <div className="empty">{directoryView === 'current' ? <Users/> : <Archive/>}<strong>{directoryView === 'current' ? 'No hay resultados' : 'No hay miembros retirados'}</strong><span>{search ? 'Prueba con otro dato.' : directoryView === 'current' ? 'Registra al primer miembro para empezar.' : 'Los miembros retirados aparecerán aquí sin perder su historial.'}</span></div>}
    </section>

    {inviteOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setInviteOpen(false); }}><section className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">NUEVO MIEMBRO</p><h2>{inviteForm.mode === 'portal' ? 'Invitar con cuenta' : 'Registrar sin cuenta'}</h2></div><button className="icon-button" onClick={() => setInviteOpen(false)}><X/></button></div><form className="checkout-form" onSubmit={(event: FormEvent) => { event.preventDefault(); invite.mutate(); }}><label>Tipo de acceso<select value={inviteForm.mode} onChange={(event) => setInviteForm({ ...emptyMemberForm, mode: event.target.value as MemberForm['mode'] })}><option value="portal">Cuenta y portal por correo</option><option value="managed">Administrado sin correo</option></select></label><label>Nombre completo<input required minLength={2} maxLength={150} value={inviteForm.fullName} onChange={(event) => setInviteForm({ ...inviteForm, fullName: event.target.value })}/></label>{inviteForm.mode === 'portal' && <label>Correo electrónico<input required type="email" value={inviteForm.email} onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })}/></label>}<label>Teléfono opcional<input maxLength={40} value={inviteForm.phone} onChange={(event) => setInviteForm({ ...inviteForm, phone: event.target.value })}/></label><LocationField locations={members.data?.locations ?? []} value={inviteForm.defaultLocationId} onChange={(defaultLocationId) => setInviteForm({ ...inviteForm, defaultLocationId })}/>{inviteForm.mode === 'managed' && <><label>Fecha de nacimiento opcional<input type="date" max={new Date().toISOString().slice(0, 10)} value={inviteForm.birthDate} onChange={(event) => setInviteForm({ ...inviteForm, birthDate: event.target.value })}/></label><label>Representante opcional<input maxLength={150} value={inviteForm.guardianName} onChange={(event) => setInviteForm({ ...inviteForm, guardianName: event.target.value })}/></label><label>Teléfono del representante<input maxLength={40} value={inviteForm.guardianPhone} onChange={(event) => setInviteForm({ ...inviteForm, guardianPhone: event.target.value })}/></label><label className="wide">Notas opcionales<textarea maxLength={1000} value={inviteForm.notes} onChange={(event) => setInviteForm({ ...inviteForm, notes: event.target.value })}/></label></>}<p className="form-note">{inviteForm.mode === 'portal' ? 'El miembro recibirá un correo seguro para crear su contraseña.' : 'No tendrá credenciales. El personal gestionará sus pagos y asistencias.'}</p>{invite.isError && <div className="alert error">{apiErrorMessage(invite.error)}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={() => setInviteOpen(false)}>Cancelar</button><button className="primary" disabled={invite.isPending}>{invite.isPending ? <><LoaderCircle className="spin"/>Guardando…</> : inviteForm.mode === 'portal' ? 'Enviar invitación' : 'Registrar miembro'}</button></div></form></section></div>}

    {selectedId && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}><section className="modal member-detail" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">FICHA DEL MIEMBRO</p><h2>{memberName(detail.data?.member)}</h2><span className={`badge ${detail.data?.member.status}`}>{detail.data?.member ? statusLabel[detail.data.member.status] : ''}</span>{detail.data?.member.account_mode === 'managed' && <span className="badge">Sin cuenta</span>}</div><button className="icon-button" onClick={() => setSelectedId(null)}><X/></button></div>{detail.isLoading ? <div className="empty"><LoaderCircle className="spin"/>Cargando ficha…</div> : detail.isError ? <div className="alert error">{apiErrorMessage(detail.error)}</div> : detail.data && <>
      {editing ? <MemberEditForm form={editForm} setForm={setEditForm} locations={members.data?.locations ?? []} pending={save.isPending} error={save.error} onCancel={() => { setEditing(false); setEditForm(formFromMember(detail.data!.member)); }} onSubmit={() => save.mutate()}/> : <MemberDetailContent data={detail.data}/>}
      {mutationError && !editing && <div className="alert error member-action-error">{apiErrorMessage(mutationError)}</div>}
      {canManage && !editing && <div className="member-lifecycle-actions">
        {detail.data.member.status !== 'invited' && <button className="ghost" onClick={() => setEditing(true)}><Edit3/>Editar datos</button>}
        {detail.data.member.status === 'active' && <button className="ghost" disabled={changeStatus.isPending} onClick={() => changeStatus.mutate('suspended')}><Ban/>Suspender</button>}
        {detail.data.member.status === 'suspended' && <button className="ghost" disabled={changeStatus.isPending} onClick={() => changeStatus.mutate('active')}><RotateCcw/>Reactivar</button>}
        {detail.data.member.status === 'inactive' && <button className="primary" disabled={reinstate.isPending} onClick={() => reinstate.mutate()}><RotateCcw/>Reincorporar</button>}
        {detail.data.member.account_mode === 'managed' && detail.data.member.status === 'active' && <button className="secondary" onClick={() => setConvertOpen(true)}><Mail/>Dar acceso al portal</button>}
        {detail.data.member.status !== 'invited' && detail.data.member.status !== 'inactive' && <button className="danger-button" disabled={retire.isPending} onClick={() => { if (window.confirm(`¿Retirar a ${memberName(detail.data!.member)}? Su historial se conservará.`)) retire.mutate(); }}><Trash2/>Retirar</button>}
        {detail.data.member.status === 'invited' && detail.data.member.invitation_id && <button className="danger-button" disabled={revoke.isPending} onClick={() => revoke.mutate(detail.data!.member.invitation_id!)}>Revocar invitación</button>}
      </div>}
    </>}</section></div>}

    {convertOpen && detail.data?.member && <div className="modal-backdrop conversion-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !convert.isPending) setConvertOpen(false); }}><section className="modal confirm-remove" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">ACCESO AL PORTAL</p><h2>Convertir sin duplicar</h2></div><button className="icon-button" disabled={convert.isPending} onClick={() => setConvertOpen(false)}><X/></button></div><div className="security-note"><Mail/><p><strong>{memberName(detail.data.member)}</strong> conservará la misma ficha, membresías, pagos, asistencias y antigüedad. Solo añadiremos su cuenta de acceso.</p></div><form className="checkout-form single" onSubmit={(event) => { event.preventDefault(); convert.mutate(); }}><label>Correo electrónico<input required type="email" value={conversionEmail} onChange={(event) => setConversionEmail(event.target.value)} placeholder="miembro@correo.com"/></label>{convert.isError && <div className="alert error">{apiErrorMessage(convert.error)}</div>}<div className="modal-actions"><button type="button" className="ghost" disabled={convert.isPending} onClick={() => setConvertOpen(false)}>Cancelar</button><button className="primary" disabled={convert.isPending}>{convert.isPending ? <><LoaderCircle className="spin"/>Enviando…</> : <><Mail/>Enviar invitación</>}</button></div></form></section></div>}
  </div>;
}

function LocationField({ locations, value, onChange }: { locations: Location[]; value: string; onChange: (value: string) => void }) {
  return <label>Sucursal predeterminada<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Sin sucursal predeterminada</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name}{location.is_main ? ' · Principal' : ''}</option>)}</select></label>;
}

function MemberEditForm({ form, setForm, locations, pending, error, onCancel, onSubmit }: { form: MemberForm; setForm: (form: MemberForm) => void; locations: Location[]; pending: boolean; error: unknown; onCancel: () => void; onSubmit: () => void }) {
  return <form className="checkout-form member-edit-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><label>Nombre completo<input required minLength={2} maxLength={150} value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })}/></label><label>Teléfono<input maxLength={40} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })}/></label><label>Fecha de nacimiento<input type="date" max={new Date().toISOString().slice(0, 10)} value={form.birthDate} onChange={(event) => setForm({ ...form, birthDate: event.target.value })}/></label><LocationField locations={locations} value={form.defaultLocationId} onChange={(defaultLocationId) => setForm({ ...form, defaultLocationId })}/><label>Representante<input maxLength={150} value={form.guardianName} onChange={(event) => setForm({ ...form, guardianName: event.target.value })}/></label><label>Teléfono del representante<input maxLength={40} value={form.guardianPhone} onChange={(event) => setForm({ ...form, guardianPhone: event.target.value })}/></label><label className="wide">Notas<textarea maxLength={1000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })}/></label>{Boolean(error) && <div className="alert error">{apiErrorMessage(error)}</div>}<div className="modal-actions"><button type="button" className="ghost" disabled={pending} onClick={onCancel}>Cancelar</button><button className="primary" disabled={pending}>{pending ? <LoaderCircle className="spin"/> : <Save/>}Guardar cambios</button></div></form>;
}

function MemberDetailContent({ data }: { data: MemberDetail }) {
  const summary = data.summary;
  return <div className="detail-content">
    <div className="member-personal-summary"><div><span>Teléfono</span><strong>{memberPhone(data.member)}</strong></div><div><span>Nacimiento</span><strong>{data.member.managed_birth_date ?? 'No registrado'}</strong></div><div><span>Representante</span><strong>{data.member.managed_guardian_name ?? 'No registrado'}</strong></div><div><span>Sucursal</span><strong>{data.member.default_location_id ? 'Asignada' : 'Sin asignar'}</strong></div></div>
    <div className="detail-stats member-financial-stats"><article><CreditCard/><span>Membresía</span><strong>{summary.planName ?? coverageLabel[summary.coverageStatus]}</strong><small>{summary.endsOn ? `${coverageLabel[summary.coverageStatus]} · vence ${summary.endsOn}` : coverageLabel[summary.coverageStatus]}</small></article><article><WalletCards/><span>Saldo pendiente</span><strong>{Number(summary.outstanding).toFixed(2)} {summary.currency}</strong><small>Pagado: {Number(summary.totalPaid).toFixed(2)} {summary.currency}</small></article><article><Flame/><span>Racha actual</span><strong>{data.streak?.current_streak ?? 0}</strong><small>Récord: {data.streak?.longest_streak ?? 0}</small></article><article><CalendarCheck/><span>Asistencias</span><strong>{data.attendances.filter((item) => item.status === 'valid').length}</strong><small>Últimos 50 registros</small></article></div>
    {data.member.managed_notes && <div className="member-notes"><strong>Notas</strong><p>{data.member.managed_notes}</p></div>}
    <div className="detail-columns"><section><h3>Pagos recientes</h3>{data.payments.length ? data.payments.slice(0, 5).map((payment) => <div className="mini-row" key={payment.id}><div><strong>{Number(payment.amount).toFixed(2)} {payment.currency}</strong><small>{payment.payment_method}</small></div><span className={`badge ${payment.status}`}>{payment.status}</span></div>) : <p className="muted">No hay pagos registrados.</p>}</section><section><h3>Asistencias recientes</h3>{data.attendances.length ? data.attendances.slice(0, 5).map((attendance) => <div className="mini-row" key={attendance.id}><div><strong>{attendance.attendance_date}</strong><small>{attendance.source === 'staff' ? 'Manual' : 'QR'}</small></div><span className={`badge ${attendance.status}`}>{attendance.status}</span></div>) : <p className="muted">No hay asistencias registradas.</p>}</section></div>
  </div>;
}
