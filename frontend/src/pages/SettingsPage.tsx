import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Image, ImagePlus, KeyRound, LoaderCircle, Mail, MapPin, MessageCircle, Phone, RotateCcw, Save, ShieldCheck, Upload } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';
import { AttendanceQrSettings } from '../components/AttendanceQrSettings';

type Gym = { id: string; name: string; email: string | null; phone: string | null; whatsapp_phone: string | null; logo_url: string | null; timezone: string; currency: string };
type Location = { id: string; name: string; address: string | null; city: string; email: string | null; phone: string | null; whatsapp_phone: string | null; timezone: string; is_main: boolean; is_active: boolean };
type Settings = { gym: Gym; locations: Location[] };

export function SettingsPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: async () => (await api.get<Settings>('/settings')).data });
  const [gym, setGym] = useState({ name: '', email: '', phone: '', whatsappPhone: '' });
  const [logoUrl, setLogoUrl] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState('');
  const [locationId, setLocationId] = useState('');
  const [location, setLocation] = useState({ name: '', address: '', city: '', email: '', phone: '', whatsappPhone: '' });
  const [adminPin, setAdminPin] = useState({ pin: '', confirmation: '' });
  useEffect(() => { if (settings.data?.gym) setGym({ name: settings.data.gym.name, email: settings.data.gym.email ?? '', phone: settings.data.gym.phone ?? '', whatsappPhone: settings.data.gym.whatsapp_phone ?? '' }); }, [settings.data?.gym]);
  useEffect(() => { if (settings.data?.gym) setLogoUrl(settings.data.gym.logo_url ?? ''); }, [settings.data?.gym]);
  useEffect(() => {
    if (!logoFile) { setLogoPreview(''); return; }
    const preview = URL.createObjectURL(logoFile);
    setLogoPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [logoFile]);
  useEffect(() => { if (!locationId && settings.data?.locations[0]) setLocationId(settings.data.locations[0].id); }, [settings.data?.locations, locationId]);
  useEffect(() => { const selected = settings.data?.locations.find((item) => item.id === locationId); if (selected) setLocation({ name: selected.name, address: selected.address ?? '', city: selected.city, email: selected.email ?? '', phone: selected.phone ?? '', whatsappPhone: selected.whatsapp_phone ?? '' }); }, [locationId, settings.data?.locations]);
  const saveGym = useMutation({ mutationFn: async () => api.put('/settings/gym', gym), onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['settings'] }) });
  const saveBranding = useMutation({
    mutationFn: async () => {
      if (!logoFile || logoFile.size > 5_242_880 || !['image/jpeg', 'image/png', 'image/webp'].includes(logoFile.type)) {
        throw new Error('Selecciona una imagen JPG, PNG o WEBP de hasta 5 MB.');
      }
      const prepared = (await api.post<{ upload: { signedUrl: string; path: string } }>('/settings/receipt-branding/upload', { contentType: logoFile.type })).data.upload;
      const upload = await fetch(prepared.signedUrl, { method: 'PUT', headers: { 'x-upsert': 'true', 'content-type': logoFile.type }, body: logoFile });
      if (!upload.ok) throw new Error('No se pudo subir el logotipo. Intenta nuevamente.');
      return api.put('/settings/receipt-branding', { path: prepared.path });
    },
    onSuccess: async () => { setLogoFile(null); await queryClient.invalidateQueries({ queryKey: ['settings'] }); },
  });
  const resetBranding = useMutation({
    mutationFn: async () => api.put('/settings/receipt-branding', { logoUrl: null }),
    onSuccess: async () => { setLogoFile(null); await queryClient.invalidateQueries({ queryKey: ['settings'] }); },
  });
  const saveLocation = useMutation({ mutationFn: async () => api.put(`/settings/locations/${locationId}`, location), onSuccess: async () => Promise.all([queryClient.invalidateQueries({ queryKey: ['settings'] }), queryClient.invalidateQueries({ queryKey: ['my-calendar'] })]) });
  const saveAdminPin = useMutation({ mutationFn: async () => api.put('/permissions/admin-pin', { pin: adminPin.pin }), onSuccess: () => setAdminPin({ pin: '', confirmation: '' }) });
  const submitGym = (event: FormEvent) => { event.preventDefault(); saveGym.mutate(); };
  const submitBranding = (event: FormEvent) => { event.preventDefault(); saveBranding.mutate(); };
  const submitLocation = (event: FormEvent) => { event.preventDefault(); saveLocation.mutate(); };
  const submitAdminPin = (event: FormEvent) => { event.preventDefault(); if (adminPin.pin === adminPin.confirmation) saveAdminPin.mutate(); };
  if (settings.isLoading) return <div className="splash"><LoaderCircle className="spin"/></div>;
  if (settings.isError) return <div className="page"><div className="alert error">{apiErrorMessage(settings.error)}</div></div>;

  const pinMatches = adminPin.pin === adminPin.confirmation;
  const pinIsValid = /^\d{4,12}$/.test(adminPin.pin);

  return <div className="page"><div className="page-heading"><div><p className="eyebrow">CONFIGURACIÓN</p><h1>Datos y seguridad</h1><p>Administra el contacto del gimnasio, sus sucursales y el acceso a operaciones protegidas.</p></div></div>
    <div className="settings-grid"><form className="panel settings-form" onSubmit={submitGym}><div className="panel-title"><div><h2>Gimnasio</h2><p>Datos generales usados como respaldo</p></div><Building2/></div><label>Nombre<input required minLength={2} value={gym.name} onChange={(event) => setGym({ ...gym, name: event.target.value })}/></label><label><Mail/>Correo general<input type="email" value={gym.email} onChange={(event) => setGym({ ...gym, email: event.target.value })} placeholder="contacto@gimnasio.com"/></label><label><Phone/>Teléfono general<input value={gym.phone} onChange={(event) => setGym({ ...gym, phone: event.target.value })} placeholder="02 000 0000"/></label><label><MessageCircle/>WhatsApp general<input value={gym.whatsappPhone} onChange={(event) => setGym({ ...gym, whatsappPhone: event.target.value })} placeholder="+593 99 000 0000"/></label>{saveGym.isSuccess && <div className="alert success">Datos generales guardados.</div>}{saveGym.isError && <div className="alert error">{apiErrorMessage(saveGym.error)}</div>}<button className="primary" disabled={saveGym.isPending}>{saveGym.isPending ? <LoaderCircle className="spin"/> : <Save/>}Guardar gimnasio</button></form>
      <form className="panel settings-form" onSubmit={submitLocation}><div className="panel-title"><div><h2>Sucursal</h2><p>Estos datos tienen prioridad en el portal</p></div><MapPin/></div><label>Seleccionar sucursal<select value={locationId} onChange={(event) => setLocationId(event.target.value)}>{settings.data?.locations.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_main ? ' · Principal' : ''}</option>)}</select></label><label>Nombre<input required minLength={2} value={location.name} onChange={(event) => setLocation({ ...location, name: event.target.value })}/></label><label>Dirección<input value={location.address} onChange={(event) => setLocation({ ...location, address: event.target.value })} placeholder="Calle, número y referencia"/></label><label>Ciudad<input required value={location.city} onChange={(event) => setLocation({ ...location, city: event.target.value })}/></label><label><Mail/>Correo de sucursal<input type="email" value={location.email} onChange={(event) => setLocation({ ...location, email: event.target.value })} placeholder="sucursal@gimnasio.com"/></label><label><Phone/>Teléfono de sucursal<input value={location.phone} onChange={(event) => setLocation({ ...location, phone: event.target.value })}/></label><label><MessageCircle/>WhatsApp de sucursal<input value={location.whatsappPhone} onChange={(event) => setLocation({ ...location, whatsappPhone: event.target.value })} placeholder="+593 99 000 0000"/></label>{saveLocation.isSuccess && <div className="alert success">Datos de la sucursal guardados.</div>}{saveLocation.isError && <div className="alert error">{apiErrorMessage(saveLocation.error)}</div>}<button className="primary" disabled={!locationId || saveLocation.isPending}>{saveLocation.isPending ? <LoaderCircle className="spin"/> : <Save/>}Guardar sucursal</button></form>
      <form className="panel settings-form branding-form" onSubmit={submitBranding}><div className="panel-title"><div><h2>Marca de recibos</h2><p>Logotipo usado al imprimir y descargar comprobantes</p></div><Image/></div><div className="branding-preview"><img src={logoPreview || logoUrl || '/fitlab-logo.png'} alt="Vista previa del logotipo" referrerPolicy="no-referrer"/><div><strong>{logoFile ? 'Nueva imagen seleccionada' : 'Vista previa actual'}</strong><span>Elige una imagen clara, preferiblemente con fondo transparente. FitLab acepta JPG, PNG o WEBP de hasta 5 MB.</span></div></div><label className="branding-upload" htmlFor="receipt-logo-input"><input id="receipt-logo-input" type="file" accept="image/jpeg,image/png,image/webp" disabled={saveBranding.isPending || resetBranding.isPending} onChange={(event) => { const nextFile = event.target.files?.[0] ?? null; event.target.value = ''; setLogoFile(nextFile); saveBranding.reset(); resetBranding.reset(); }}/><span><ImagePlus/><strong>{logoFile?.name ?? 'Seleccionar imagen desde este dispositivo'}</strong><small>{logoFile ? `${(logoFile.size / 1_048_576).toFixed(2)} MB · lista para guardar` : 'Toca aquí para abrir la galería o explorador de archivos'}</small></span></label>{saveBranding.isSuccess && <div className="alert success">Marca de recibos guardada.</div>}{resetBranding.isSuccess && <div className="alert success">Se restauró el logotipo predeterminado de FitLab.</div>}{(saveBranding.isError || resetBranding.isError) && <div className="alert error">{apiErrorMessage(saveBranding.error ?? resetBranding.error)}</div>}<div className="branding-actions">{logoUrl && <button type="button" className="ghost" disabled={saveBranding.isPending || resetBranding.isPending} onClick={() => resetBranding.mutate()}>{resetBranding.isPending ? <LoaderCircle className="spin"/> : <RotateCcw/>}Usar logo de FitLab</button>}<button className="primary" disabled={!logoFile || saveBranding.isPending || resetBranding.isPending}>{saveBranding.isPending ? <LoaderCircle className="spin"/> : <Upload/>}Subir y guardar</button></div></form>
      {session?.gymUser?.role === 'owner' && <form className="panel settings-form security-form" onSubmit={submitAdminPin}><div className="panel-title"><div><h2>PIN administrativo</h2><p>Protege acciones sensibles realizadas por el personal</p></div><ShieldCheck/></div><div className="security-note"><KeyRound/><p>Usa entre 4 y 12 dígitos. Al cambiarlo se invalidan todas las elevaciones temporales anteriores.</p></div><label>Nuevo PIN<input required type="password" inputMode="numeric" autoComplete="new-password" pattern="\d{4,12}" minLength={4} maxLength={12} value={adminPin.pin} onChange={(event) => setAdminPin({ ...adminPin, pin: event.target.value.replace(/\D/g, '') })}/></label><label>Confirmar PIN<input required type="password" inputMode="numeric" autoComplete="new-password" pattern="\d{4,12}" minLength={4} maxLength={12} value={adminPin.confirmation} onChange={(event) => setAdminPin({ ...adminPin, confirmation: event.target.value.replace(/\D/g, '') })}/></label>{adminPin.confirmation && !pinMatches && <div className="alert error">Los PIN no coinciden.</div>}{saveAdminPin.isSuccess && <div className="alert success">PIN administrativo actualizado.</div>}{saveAdminPin.isError && <div className="alert error">{apiErrorMessage(saveAdminPin.error)}</div>}<button className="primary" disabled={!pinIsValid || !pinMatches || saveAdminPin.isPending}>{saveAdminPin.isPending ? <LoaderCircle className="spin"/> : <ShieldCheck/>}Actualizar PIN</button></form>}</div>
    {session?.gymUser?.role === 'owner' && <AttendanceQrSettings gymName={settings.data?.gym.name ?? 'Gimnasio'}/>}
  </div>;
}
