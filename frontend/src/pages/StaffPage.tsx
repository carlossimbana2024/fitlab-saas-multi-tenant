import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, Ban, CheckCircle2, KeyRound, LoaderCircle, Mail, RotateCcw, Save, Search, ShieldCheck, Trash2, UserPlus, UsersRound, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiErrorMessage } from '../services/api';

type AccessMode = 'allowed' | 'requires_pin' | 'denied';
type Permission = { permission_key: string; access_mode: AccessMode };
type CatalogPermission = { key: string; name: string; description?: string | null; supports_pin_elevation: boolean; is_sensitive: boolean };
type StaffMember = {
  id: string;
  status: 'invited' | 'active' | 'suspended' | 'inactive';
  default_location_id?: string | null;
  joined_at?: string | null;
  invitation_id?: string | null;
  profiles?: { full_name?: string; phone?: string | null; avatar_url?: string | null } | null;
  permissions?: Permission[];
  invitation?: { email?: string; status?: string; expires_at?: string } | null;
};
type Location = { id: string; name: string; is_main: boolean };
type StaffPayload = { staff: StaffMember[]; removedStaff: StaffMember[]; permissionCatalog: CatalogPermission[]; locations: Location[] };

const statusLabels = { invited: 'Invitación pendiente', active: 'Activo', suspended: 'Suspendido', inactive: 'Retirado' };
const accessLabels: Record<AccessMode, string> = { allowed: 'Permitido', requires_pin: 'Requiere PIN', denied: 'Denegado' };
const emptyInvite = { fullName: '', email: '', phone: '', defaultLocationId: '' };

function staffName(staff?: StaffMember) {
  return staff?.profiles?.full_name ?? 'Empleado';
}

export function StaffPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [reinstateOpen, setReinstateOpen] = useState(false);
  const [directoryView, setDirectoryView] = useState<'current' | 'removed'>('current');
  const [inviteForm, setInviteForm] = useState(emptyInvite);
  const [matrix, setMatrix] = useState<Record<string, AccessMode>>({});
  const [message, setMessage] = useState('');
  const staffQuery = useQuery({
    queryKey: ['staff'],
    queryFn: async () => (await api.get<StaffPayload>('/staff')).data,
  });
  const allStaff = [...(staffQuery.data?.staff ?? []), ...(staffQuery.data?.removedStaff ?? [])];
  const selected = allStaff.find((item) => item.id === selectedId) ?? null;
  const visibleStaff = useMemo(() => {
    const directory = directoryView === 'current' ? staffQuery.data?.staff ?? [] : staffQuery.data?.removedStaff ?? [];
    const needle = search.trim().toLocaleLowerCase('es');
    if (!needle) return directory;
    return directory.filter((item) =>
      `${staffName(item)} ${item.invitation?.email ?? ''} ${item.profiles?.phone ?? ''}`.toLocaleLowerCase('es').includes(needle),
    );
  }, [directoryView, search, staffQuery.data?.removedStaff, staffQuery.data?.staff]);

  useEffect(() => {
    if (!selected || !staffQuery.data) return;
    const current = new Map((selected.permissions ?? []).map((item) => [item.permission_key, item.access_mode]));
    setMatrix(Object.fromEntries(staffQuery.data.permissionCatalog.map((permission) => [permission.key, current.get(permission.key) ?? 'denied'])));
  }, [selected, staffQuery.data]);

  const refreshStaff = async () => queryClient.invalidateQueries({ queryKey: ['staff'] });
  const invite = useMutation({
    mutationFn: async () => api.post('/staff/invite', {
      fullName: inviteForm.fullName,
      email: inviteForm.email,
      phone: inviteForm.phone.trim() || null,
      defaultLocationId: inviteForm.defaultLocationId || null,
    }),
    onSuccess: async () => {
      setInviteOpen(false);
      setMessage(`Invitación enviada a ${inviteForm.email}.`);
      setInviteForm(emptyInvite);
      await refreshStaff();
    },
  });
  const savePermissions = useMutation({
    mutationFn: async () => api.put(`/staff/${selectedId}/permissions`, { permissions: matrix }),
    onSuccess: async () => { setMessage(`Permisos de ${staffName(selected ?? undefined)} guardados.`); await refreshStaff(); },
  });
  const updateStatus = useMutation({
    mutationFn: async (status: 'active' | 'suspended') => api.patch(`/staff/${selectedId}/status`, { status }),
    onSuccess: async (_response, status) => { setMessage(status === 'active' ? 'Acceso del empleado reactivado.' : 'Acceso del empleado suspendido.'); await refreshStaff(); },
  });
  const revoke = useMutation({
    mutationFn: async () => api.delete(`/staff/invitations/${selected?.invitation_id}`),
    onSuccess: async () => { setSelectedId(null); setMessage('La invitación del empleado fue revocada.'); await refreshStaff(); },
  });
  const remove = useMutation({
    mutationFn: async () => api.delete(`/staff/${selectedId}`),
    onSuccess: async () => {
      setRemoveOpen(false);
      setSelectedId(null);
      setMessage('El empleado fue retirado y ya no tiene acceso a FitLab.');
      await refreshStaff();
    },
  });
  const reinstate = useMutation({
    mutationFn: async () => api.post(`/staff/${selectedId}/reinstate`),
    onSuccess: async () => {
      const reinstatedName = staffName(selected ?? undefined);
      setReinstateOpen(false);
      setDirectoryView('current');
      setMessage(`${reinstatedName} fue reincorporado. Configura sus permisos antes de que vuelva a operar.`);
      await refreshStaff();
    },
  });

  if (staffQuery.isLoading) return <div className="splash"><LoaderCircle className="spin"/></div>;
  if (staffQuery.isError) return <div className="page"><div className="alert error">{apiErrorMessage(staffQuery.error)}</div></div>;

  const mutationError = savePermissions.error ?? updateStatus.error ?? revoke.error ?? remove.error ?? reinstate.error;
  return <div className="page staff-page">
    <div className="page-heading"><div><p className="eyebrow">EQUIPO DEL GIMNASIO</p><h1>Personal</h1><p>Invita empleados y controla exactamente qué puede hacer cada cuenta.</p></div><button className="primary" onClick={() => { setMessage(''); setInviteOpen(true); }}><UserPlus size={18}/>Invitar empleado</button></div>
    {message && <div className="alert success">{message}</div>}
    <div className="staff-layout">
      <section className="panel staff-directory">
        <div className="directory-tabs"><button className={directoryView === 'current' ? 'active' : ''} onClick={() => { setDirectoryView('current'); setSelectedId(null); }}><UsersRound/>Actuales <span>{staffQuery.data?.staff.length ?? 0}</span></button><button className={directoryView === 'removed' ? 'active' : ''} onClick={() => { setDirectoryView('removed'); setSelectedId(null); }}><Archive/>Retirados <span>{staffQuery.data?.removedStaff.length ?? 0}</span></button></div>
        <div className="table-tools"><div className="search"><Search/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar empleado…"/></div><span>{visibleStaff.length} empleados</span></div>
        {visibleStaff.length ? <div className="member-list">{visibleStaff.map((staff) => <button className={`member-row member-button ${selectedId === staff.id ? 'selected' : ''}`} key={staff.id} onClick={() => { setMessage(''); setSelectedId(staff.id); }}><span className="avatar">{staffName(staff).slice(0, 2).toUpperCase()}</span><div><strong>{staffName(staff)}</strong><small>{staff.invitation?.email ?? staff.profiles?.phone ?? 'Cuenta de personal'}</small></div><span className={`badge ${staff.status}`}>{statusLabels[staff.status]}</span></button>)}</div> : <div className="empty">{directoryView === 'current' ? <UsersRound/> : <Archive/>}<strong>{directoryView === 'current' ? 'Aún no hay empleados' : 'No hay personal retirado'}</strong><span>{directoryView === 'current' ? 'Invita al primer empleado y configura sus permisos.' : 'Los empleados eliminados aparecerán aquí para poder reincorporarlos.'}</span></div>}
      </section>

      <section className="panel permission-panel">
        {!selected ? <div className="empty"><ShieldCheck/><strong>Selecciona un empleado</strong><span>{directoryView === 'current' ? 'Aquí podrás configurar su matriz de acceso.' : 'Aquí podrás revisar y reincorporar una cuenta existente.'}</span></div> : selected.status === 'inactive' ? <>
          <div className="panel-title"><div><p className="eyebrow">PERSONAL RETIRADO</p><h2>{staffName(selected)}</h2><p>{selected.invitation?.email}</p></div><span className="badge inactive">Retirado</span></div>
          <div className="security-note"><Archive/><p>Esta cuenta conserva su correo, contraseña e historial, pero actualmente no puede acceder a las operaciones del gimnasio.</p></div>
          {mutationError && <div className="alert error">{apiErrorMessage(mutationError)}</div>}
          <div className="staff-actions"><button className="primary" disabled={reinstate.isPending} onClick={() => setReinstateOpen(true)}><RotateCcw/>Reincorporar empleado</button></div>
        </> : <>
          <div className="panel-title"><div><p className="eyebrow">MATRIZ DE PERMISOS</p><h2>{staffName(selected)}</h2><p>{selected.invitation?.email}</p></div><span className={`badge ${selected.status}`}>{statusLabels[selected.status]}</span></div>
          {selected.status === 'invited' && <div className="security-note"><Mail/><p>El empleado debe abrir el correo de invitación y crear su contraseña. Puedes dejar sus permisos preparados desde ahora.</p></div>}
          {selected.status === 'suspended' && <div className="security-note"><Ban/><p>Esta cuenta no puede iniciar operaciones mientras permanezca suspendida.</p></div>}
          <div className="permission-legend"><span><CheckCircle2/>Permitido</span><span><KeyRound/>Requiere PIN</span><span><Ban/>Denegado</span></div>
          <div className="permission-matrix">{staffQuery.data?.permissionCatalog.map((permission) => <article key={permission.key}><div><strong>{permission.name}</strong><small>{permission.description || permission.key}{permission.is_sensitive ? ' · Acción sensible' : ''}</small></div><select aria-label={`Permiso ${permission.name}`} value={matrix[permission.key] ?? 'denied'} onChange={(event) => setMatrix({ ...matrix, [permission.key]: event.target.value as AccessMode })}><option value="allowed">{accessLabels.allowed}</option>{permission.supports_pin_elevation && <option value="requires_pin">{accessLabels.requires_pin}</option>}<option value="denied">{accessLabels.denied}</option></select></article>)}</div>
          {mutationError && <div className="alert error">{apiErrorMessage(mutationError)}</div>}
          {savePermissions.isSuccess && !message && <div className="alert success">Permisos guardados.</div>}
          <div className="staff-actions">
            {selected.status === 'invited' && <button className="danger-button" disabled={revoke.isPending} onClick={() => revoke.mutate()}>Revocar invitación</button>}
            {selected.status === 'active' && <button className="ghost" disabled={updateStatus.isPending} onClick={() => updateStatus.mutate('suspended')}>Suspender acceso</button>}
            {selected.status === 'suspended' && <button className="ghost" disabled={updateStatus.isPending} onClick={() => updateStatus.mutate('active')}>Reactivar acceso</button>}
            {selected.status !== 'invited' && <button className="danger-button" disabled={remove.isPending} onClick={() => setRemoveOpen(true)}><Trash2/>Eliminar empleado</button>}
            <button className="primary" disabled={savePermissions.isPending} onClick={() => savePermissions.mutate()}>{savePermissions.isPending ? <LoaderCircle className="spin"/> : <Save/>}Guardar permisos</button>
          </div>
        </>}
      </section>
    </div>

    {inviteOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setInviteOpen(false); }}><section className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">NUEVA CUENTA STAFF</p><h2>Invitar empleado</h2></div><button className="icon-button" onClick={() => setInviteOpen(false)}><X/></button></div><form className="checkout-form" onSubmit={(event: FormEvent) => { event.preventDefault(); invite.mutate(); }}><label>Nombre completo<input required minLength={2} maxLength={150} value={inviteForm.fullName} onChange={(event) => setInviteForm({ ...inviteForm, fullName: event.target.value })}/></label><label>Correo electrónico<input required type="email" value={inviteForm.email} onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })}/></label><label>Teléfono opcional<input maxLength={40} value={inviteForm.phone} onChange={(event) => setInviteForm({ ...inviteForm, phone: event.target.value })}/></label><label>Sucursal predeterminada<select value={inviteForm.defaultLocationId} onChange={(event) => setInviteForm({ ...inviteForm, defaultLocationId: event.target.value })}><option value="">Sin sucursal predeterminada</option>{staffQuery.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}{location.is_main ? ' · Principal' : ''}</option>)}</select></label><p className="form-note">Supabase enviará un enlace seguro. El empleado creará su propia contraseña; FitLab nunca la conoce ni la envía al owner.</p>{invite.isError && <div className="alert error">{apiErrorMessage(invite.error)}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={() => setInviteOpen(false)}>Cancelar</button><button className="primary" disabled={invite.isPending}>{invite.isPending ? <><LoaderCircle className="spin"/>Enviando…</> : <><Mail/>Enviar invitación</>}</button></div></form></section></div>}
    {removeOpen && selected && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !remove.isPending) setRemoveOpen(false); }}><section className="modal confirm-remove" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">RETIRAR ACCESO</p><h2>Eliminar empleado</h2></div><button className="icon-button" disabled={remove.isPending} onClick={() => setRemoveOpen(false)}><X/></button></div><div className="danger-note"><AlertTriangle/><p><strong>{staffName(selected)}</strong> perderá inmediatamente el acceso y todos sus permisos quedarán denegados. Se conservará el historial de operaciones y auditoría.</p></div>{remove.isError && <div className="alert error">{apiErrorMessage(remove.error)}</div>}<div className="modal-actions"><button className="ghost" disabled={remove.isPending} onClick={() => setRemoveOpen(false)}>Cancelar</button><button className="danger-button" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? <><LoaderCircle className="spin"/>Eliminando…</> : <><Trash2/>Eliminar acceso</>}</button></div></section></div>}
    {reinstateOpen && selected?.status === 'inactive' && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !reinstate.isPending) setReinstateOpen(false); }}><section className="modal confirm-remove" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">REINCORPORAR PERSONAL</p><h2>Restaurar acceso</h2></div><button className="icon-button" disabled={reinstate.isPending} onClick={() => setReinstateOpen(false)}><X/></button></div><div className="security-note"><RotateCcw/><p><strong>{staffName(selected)}</strong> volverá a usar su mismo correo y contraseña. Todos sus permisos comenzarán en <strong>Denegado</strong>.</p></div>{reinstate.isError && <div className="alert error">{apiErrorMessage(reinstate.error)}</div>}<div className="modal-actions"><button className="ghost" disabled={reinstate.isPending} onClick={() => setReinstateOpen(false)}>Cancelar</button><button className="primary" disabled={reinstate.isPending} onClick={() => reinstate.mutate()}>{reinstate.isPending ? <><LoaderCircle className="spin"/>Reincorporando…</> : <><RotateCcw/>Reincorporar</>}</button></div></section></div>}
  </div>;
}
