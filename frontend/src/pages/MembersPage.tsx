import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, CreditCard, Flame, LoaderCircle, Search, UserPlus, Users, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';

type Profile = { full_name?: string; phone?: string; avatar_url?: string };
type Member = {
  id: string;
  status: string;
  account_mode: 'portal' | 'managed';
  invitation_id?: string | null;
  managed_full_name?: string | null;
  managed_phone?: string | null;
  managed_birth_date?: string | null;
  managed_guardian_name?: string | null;
  managed_guardian_phone?: string | null;
  managed_notes?: string | null;
  joined_at?: string;
  profiles?: Profile | null;
};
type Membership = { id: string; status: string; price_at_purchase: number; currency: string; plans?: { name?: string }; membership_periods?: Array<{ starts_on: string; ends_on: string; status: string }> };
type Payment = { id: string; amount: number; currency: string; payment_method: string; status: string; paid_at: string };
type Attendance = { id: string; attendance_date: string; checked_in_at: string; source: string; status: string };
type Streak = { status: string; current_streak: number; longest_streak: number; last_attendance_date?: string | null };
type MemberDetail = { member: Member; memberships: Membership[]; payments: Payment[]; attendances: Attendance[]; streak: Streak | null };
type MemberForm = {
  mode: 'portal' | 'managed';
  fullName: string;
  email: string;
  phone: string;
  birthDate: string;
  guardianName: string;
  guardianPhone: string;
  notes: string;
};

const emptyMemberForm: MemberForm = { mode: 'portal', fullName: '', email: '', phone: '', birthDate: '', guardianName: '', guardianPhone: '', notes: '' };
const statusLabel: Record<string, string> = { active: 'Activo', invited: 'Invitado', suspended: 'Suspendido', inactive: 'Inactivo' };

const memberName = (member?: Member) => member?.profiles?.full_name ?? member?.managed_full_name ?? 'Sin nombre';
const memberPhone = (member?: Member) => member?.profiles?.phone ?? member?.managed_phone ?? 'Sin teléfono';

function apiMessage(error: unknown) {
  const value = error as { response?: { data?: { error?: { message?: string } } } };
  return value.response?.data?.error?.message ?? 'No se pudo completar la operación.';
}

export function MembersPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState<MemberForm>(emptyMemberForm);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [invitedMessage, setInvitedMessage] = useState('');
  const members = useQuery({ queryKey: ['members'], queryFn: async () => (await api.get<{ members: Member[] }>('/members')).data.members });
  const detail = useQuery({ queryKey: ['member-detail', selectedId], queryFn: async () => (await api.get<MemberDetail>(`/members/${selectedId}`)).data, enabled: Boolean(selectedId) });
  const visibleMembers = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('es');
    if (!needle) return members.data ?? [];
    return (members.data ?? []).filter((member) => `${memberName(member)} ${memberPhone(member)}`.toLocaleLowerCase('es').includes(needle));
  }, [members.data, search]);
  const invite = useMutation({
    mutationFn: async () => inviteForm.mode === 'portal'
      ? api.post('/members/invite', { fullName: inviteForm.fullName, email: inviteForm.email, phone: inviteForm.phone.trim() || null, defaultLocationId: session?.gymUser?.default_location_id ?? null })
      : api.post('/members/managed', {
          fullName: inviteForm.fullName,
          phone: inviteForm.phone.trim() || null,
          birthDate: inviteForm.birthDate || null,
          guardianName: inviteForm.guardianName.trim() || null,
          guardianPhone: inviteForm.guardianPhone.trim() || null,
          notes: inviteForm.notes.trim() || null,
          defaultLocationId: session?.gymUser?.default_location_id ?? null,
        }),
    onSuccess: async () => {
      setInviteOpen(false);
      setInvitedMessage(inviteForm.mode === 'portal' ? `Invitación enviada a ${inviteForm.email}.` : `${inviteForm.fullName} fue registrado sin cuenta.`);
      setInviteForm(emptyMemberForm);
      await queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });
  const revoke = useMutation({
    mutationFn: async (invitationId: string) => api.delete(`/members/invitations/${invitationId}`),
    onSuccess: async () => {
      setSelectedId(null);
      setInvitedMessage('La invitación fue revocada.');
      await queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });

  return <div className="page"><div className="page-heading"><div><p className="eyebrow">COMUNIDAD</p><h1>Miembros</h1><p>Administra las personas que forman parte de tu gimnasio.</p></div><button className="primary" onClick={() => setInviteOpen(true)}><UserPlus size={18}/>Nuevo miembro</button></div>
    {invitedMessage && <div className="alert success">{invitedMessage}</div>}
    <section className="panel"><div className="table-tools"><div className="search"><Search/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nombre o teléfono…"/></div><span>{visibleMembers.length} miembros</span></div>{members.isLoading ? <div className="empty"><LoaderCircle className="spin"/>Cargando miembros…</div> : visibleMembers.length ? <div className="member-list">{visibleMembers.map((member) => <button className="member-row member-button" key={member.id} onClick={() => setSelectedId(member.id)}><span className="avatar">{memberName(member).slice(0, 2).toUpperCase()}</span><div><strong>{memberName(member)}</strong><small>{memberPhone(member)}{member.account_mode === 'managed' ? ' · Sin cuenta' : ''}</small></div><span className={`badge ${member.status}`}>{statusLabel[member.status] ?? member.status}</span></button>)}</div> : <div className="empty"><Users/><strong>No hay resultados</strong><span>{search ? 'Prueba con otro nombre o teléfono.' : 'Registra al primer miembro para empezar.'}</span></div>}</section>

    {inviteOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setInviteOpen(false); }}><section className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">NUEVO MIEMBRO</p><h2>{inviteForm.mode === 'portal' ? 'Invitar con cuenta' : 'Registrar sin cuenta'}</h2></div><button className="icon-button" onClick={() => setInviteOpen(false)}><X/></button></div><form className="checkout-form" onSubmit={(event: FormEvent) => { event.preventDefault(); invite.mutate(); }}><label>Tipo de acceso<select value={inviteForm.mode} onChange={(event) => setInviteForm({ ...emptyMemberForm, mode: event.target.value as MemberForm['mode'] })}><option value="portal">Cuenta y portal por correo</option><option value="managed">Administrado sin correo</option></select></label><label>Nombre completo<input required minLength={2} maxLength={150} value={inviteForm.fullName} onChange={(event) => setInviteForm({ ...inviteForm, fullName: event.target.value })}/></label>{inviteForm.mode === 'portal' && <label>Correo electrónico<input required type="email" value={inviteForm.email} onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })}/></label>}<label>Teléfono opcional<input maxLength={40} value={inviteForm.phone} onChange={(event) => setInviteForm({ ...inviteForm, phone: event.target.value })}/></label>{inviteForm.mode === 'managed' && <><label>Fecha de nacimiento opcional<input type="date" max={new Date().toISOString().slice(0, 10)} value={inviteForm.birthDate} onChange={(event) => setInviteForm({ ...inviteForm, birthDate: event.target.value })}/></label><label>Representante opcional<input maxLength={150} value={inviteForm.guardianName} onChange={(event) => setInviteForm({ ...inviteForm, guardianName: event.target.value })}/></label><label>Teléfono del representante<input maxLength={40} value={inviteForm.guardianPhone} onChange={(event) => setInviteForm({ ...inviteForm, guardianPhone: event.target.value })}/></label><label className="wide">Notas opcionales<textarea maxLength={1000} value={inviteForm.notes} onChange={(event) => setInviteForm({ ...inviteForm, notes: event.target.value })}/></label></>}<p className="form-note">{inviteForm.mode === 'portal' ? 'Supabase enviará un correo para que el miembro configure su acceso. FitLab no crea ni conoce su contraseña.' : 'El miembro no tendrá credenciales ni acceso al portal. El personal gestionará sus pagos y asistencias.'}</p>{invite.isError && <div className="alert error">{apiMessage(invite.error)}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={() => setInviteOpen(false)}>Cancelar</button><button className="primary" disabled={invite.isPending}>{invite.isPending ? <><LoaderCircle className="spin"/>Guardando…</> : inviteForm.mode === 'portal' ? 'Enviar invitación' : 'Registrar miembro'}</button></div></form></section></div>}

    {selectedId && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}><section className="modal member-detail" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">FICHA DEL MIEMBRO</p><h2>{memberName(detail.data?.member)}</h2><span className={`badge ${detail.data?.member.status}`}>{statusLabel[detail.data?.member.status ?? ''] ?? detail.data?.member.status}</span>{detail.data?.member.account_mode === 'managed' && <span className="badge">Sin cuenta</span>}</div><button className="icon-button" onClick={() => setSelectedId(null)}><X/></button></div>{detail.isLoading ? <div className="empty"><LoaderCircle className="spin"/>Cargando ficha…</div> : detail.isError ? <div className="alert error">{apiMessage(detail.error)}</div> : detail.data && <><MemberDetailContent data={detail.data}/>{detail.data.member.status === 'invited' && detail.data.member.invitation_id && <div className="modal-actions"><button className="danger-button" disabled={revoke.isPending} onClick={() => revoke.mutate(detail.data!.member.invitation_id!)}>Revocar invitación</button></div>}{revoke.isError && <div className="alert error">{apiMessage(revoke.error)}</div>}</>}</section></div>}
  </div>;
}

function MemberDetailContent({ data }: { data: MemberDetail }) {
  const activeMembership = data.memberships.find((membership) => membership.status === 'active');
  const period = activeMembership?.membership_periods?.find((item) => item.status === 'active') ?? activeMembership?.membership_periods?.[0];
  return <div className="detail-content"><div className="detail-stats"><article><CreditCard/><span>Membresía</span><strong>{activeMembership?.plans?.name ?? 'Sin membresía activa'}</strong><small>{period ? `${period.starts_on} → ${period.ends_on}` : 'Sin cobertura'}</small></article><article><Flame/><span>Racha actual</span><strong>{data.streak?.current_streak ?? 0}</strong><small>Récord: {data.streak?.longest_streak ?? 0}</small></article><article><CalendarCheck/><span>Asistencias</span><strong>{data.attendances.filter((item) => item.status === 'valid').length}</strong><small>Últimos registros</small></article></div><div className="detail-columns"><section><h3>Pagos recientes</h3>{data.payments.length ? data.payments.slice(0, 5).map((payment) => <div className="mini-row" key={payment.id}><div><strong>{Number(payment.amount).toFixed(2)} {payment.currency}</strong><small>{payment.payment_method}</small></div><span className={`badge ${payment.status}`}>{payment.status}</span></div>) : <p className="muted">No hay pagos registrados.</p>}</section><section><h3>Asistencias recientes</h3>{data.attendances.length ? data.attendances.slice(0, 5).map((attendance) => <div className="mini-row" key={attendance.id}><div><strong>{attendance.attendance_date}</strong><small>{attendance.source === 'staff' ? 'Manual' : 'QR'}</small></div><span className={`badge ${attendance.status}`}>{attendance.status}</span></div>) : <p className="muted">No hay asistencias registradas.</p>}</section></div></div>;
}
