import { useRef, useState, type FormEvent } from 'react';
import { api } from '../services/api';
import { ProfileDialog } from './ProfileDialog';

type AccountProfile = { fullName: string; phone: string };
type Step = 'saved' | 'failed' | null;
const emptyPasswords = () => ({ current: '', next: '', confirmation: '' });
const normalized = (profile: AccountProfile) => ({ fullName: profile.fullName.trim(), phone: profile.phone.trim() });
const same = (a: AccountProfile, b: AccountProfile) => a.fullName === b.fullName && a.phone === b.phone;

function passwordFailure(error: unknown) {
  const code = (error as { response?: { data?: { error?: { code?: string } } } })?.response?.data?.error?.code;
  if (code === 'CURRENT_PASSWORD_INVALID') return 'La contraseña actual no es correcta. Vuelve a ingresarla.';
  if (['AUTH_REQUIRED', 'INVALID_SESSION', 'INVALID_REFRESH_TOKEN', 'REFRESH_TOKEN_REQUIRED'].includes(code ?? '')) {
    return 'Necesitas iniciar sesión nuevamente antes de cambiar tu contraseña.';
  }
  return 'No pudimos confirmar el cambio de contraseña. Vuelve a ingresar los campos para reintentar. Si perdiste la conexión, comprueba qué contraseña funciona antes de repetirlo.';
}

/** Two independent writes, with an explicit checkpoint only after server confirmation. */
export function MemberAccountDialog({ initialProfile, onClose, onIdentitySaved, onProfileSaved }: {
  initialProfile: AccountProfile; onClose: () => void; onIdentitySaved: () => Promise<void>; onProfileSaved: (profile: AccountProfile) => void;
}) {
  const [profile, setProfile] = useState(initialProfile);
  const confirmed = useRef(normalized(initialProfile));
  const [passwords, setPasswords] = useState(emptyPasswords);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [profileResult, setProfileResult] = useState<Step>(null);
  const [passwordResult, setPasswordResult] = useState<Step>(null);
  const [message, setMessage] = useState('');
  const [syncWarning, setSyncWarning] = useState(false);
  const [noChanges, setNoChanges] = useState(false);
  const reconcile = async () => {
    try { await onIdentitySaved(); setSyncWarning(false); }
    catch { setSyncWarning(true); } // A read/cache failure must not undo a confirmed write.
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current) return;
    setMessage(''); setNoChanges(false);
    const supplied = Boolean(passwords.current || passwords.next || passwords.confirmation);
    if (supplied) {
      if (!passwords.current || !passwords.next || !passwords.confirmation) { setMessage('Completa los tres campos de contraseña.'); return; }
      if (passwords.next !== passwords.confirmation) { setMessage('Las contraseñas nuevas no coinciden.'); return; }
      if ([passwords.current, passwords.next].some(value => value.length < 8 || value.length > 128)) { setMessage('Las contraseñas deben tener entre 8 y 128 caracteres.'); return; }
      if (passwords.current === passwords.next) { setMessage('La nueva contraseña debe ser diferente de la actual.'); return; }
    }
    const candidate = normalized(profile);
    if (candidate.fullName.length < 2 || candidate.fullName.length > 150 || candidate.phone.length > 30) { setMessage('Revisa el nombre y el teléfono.'); return; }
    const profileChanged = !same(candidate, confirmed.current);
    if (!profileChanged && !supplied) {
      if (passwordResult === 'failed') setMessage('El cambio de contraseña sigue pendiente. Ingresa nuevamente los tres campos para reintentar.');
      else setNoChanges(true);
      return;
    }
    lock.current = true; setBusy(true);
    let profileCommitted = false;
    let step: 'profile' | 'password' = 'profile';
    try {
      if (profileChanged) {
        setProfileResult(null);
        await api.put('/members/me/profile', { fullName: candidate.fullName, phone: candidate.phone || null });
        confirmed.current = candidate; setProfile(candidate); setProfileResult('saved'); profileCommitted = true;
        onProfileSaved(candidate);
      }
      if (supplied) {
        step = 'password'; setPasswordResult(null);
        await api.put('/auth/change-password', { currentPassword: passwords.current, newPassword: passwords.next });
        setPasswordResult('saved'); setPasswords(emptyPasswords());
      }
    } catch (error) {
      setPasswords(emptyPasswords());
      if (step === 'password') { setPasswordResult('failed'); setMessage(passwordFailure(error)); }
      else { setProfileResult('failed'); setMessage('No pudimos confirmar el guardado de tus datos de cuenta. No se intentó cambiar la contraseña.'); }
    } finally {
      if (profileCommitted) await reconcile();
      lock.current = false; setBusy(false);
    }
  };
  return <ProfileDialog title="Editar cuenta" busy={busy} onClose={() => { if (!lock.current) onClose(); }}>
    <form className="profile-modal" onSubmit={submit}><fieldset disabled={busy} className="checkout-form single" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label>Nombre completo<input required minLength={2} maxLength={150} value={profile.fullName} onChange={event => { setProfile({ ...profile, fullName: event.target.value }); setProfileResult(null); }}/></label>
      <label>Teléfono<input maxLength={30} value={profile.phone} onChange={event => { setProfile({ ...profile, phone: event.target.value }); setProfileResult(null); }}/></label>
      <div className="form-divider"><strong>Actualizar contraseña</strong><span>Déjalo vacío si no deseas cambiarla.</span></div>
      <label>Contraseña actual<input type="password" minLength={8} maxLength={128} autoComplete="current-password" value={passwords.current} onChange={event => { setPasswords({ ...passwords, current: event.target.value }); setPasswordResult(null); }}/></label>
      <label>Nueva contraseña<input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={passwords.next} onChange={event => { setPasswords({ ...passwords, next: event.target.value }); setPasswordResult(null); }}/></label>
      <label>Confirmar nueva contraseña<input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={passwords.confirmation} onChange={event => { setPasswords({ ...passwords, confirmation: event.target.value }); setPasswordResult(null); }}/></label>
      {busy && <p role="status">Guardando los cambios pendientes…</p>}
      {profileResult === 'saved' && <p role="status" className="alert success">Datos de cuenta guardados.</p>}
      {passwordResult === 'saved' && <p role="status" className="alert success">Contraseña actualizada.</p>}
      {message && <p role="alert" className="alert error">{message}</p>}
      {noChanges && <p role="status">No hay cambios pendientes.</p>}
      {syncWarning && <div role="alert" className="alert warning">Tus datos se guardaron, pero no pudimos actualizar todas las vistas. <button type="button" onClick={async () => { if (lock.current) return; lock.current = true; setBusy(true); try { await reconcile(); } finally { lock.current = false; setBusy(false); } }}>Actualizar datos visibles</button></div>}
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>{profileResult === 'saved' || passwordResult === 'saved' ? 'Cerrar' : 'Cancelar'}</button><button className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar cambios'}</button></div>
    </fieldset></form>
  </ProfileDialog>;
}
