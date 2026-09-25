import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Send, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, apiErrorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';

type Announcement = { id: string; location_id: string | null; body: string; created_at: string };
type Location = { id: string; name: string };
type AnnouncementList = { announcements: Announcement[]; locations: Location[] };

export function OwnerAnnouncementsPanel() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [locationId, setLocationId] = useState('');
  const list = useQuery({ queryKey: ['gym-announcements', session?.gymUser?.gym_id, 'owner'], queryFn: async () => (await api.get<AnnouncementList>('/announcements')).data });
  const publish = useMutation({
    mutationFn: async () => api.post('/announcements', { body: body.trim(), locationId: locationId || null }),
    onSuccess: async () => { setBody(''); await queryClient.invalidateQueries({ queryKey: ['gym-announcements'] }); },
  });
  const archive = useMutation({
    mutationFn: async (id: string) => api.patch(`/announcements/${id}/archive`),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['gym-announcements'] }),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); if (body.trim()) publish.mutate(); };
  const locations = list.data?.locations ?? [];

  return <section className="panel owner-announcements">
    <div className="panel-title"><div><p className="eyebrow">COMUNICACIÓN</p><h2>Informa a tus clientes</h2><p>Publica un aviso para todo el gimnasio o solo una sucursal.</p></div><Bell aria-hidden="true"/></div>
    <form className="announcement-form" onSubmit={submit}>
      <label htmlFor="announcement-body">Mensaje</label>
      <textarea id="announcement-body" value={body} onChange={(event) => setBody(event.target.value)} maxLength={3000} rows={4} placeholder="Ej.: Hoy no abrimos por remodelación. Nos vemos mañana." required/>
      <div className="announcement-form-bottom"><label htmlFor="announcement-location">Destinatarios<select id="announcement-location" value={locationId} onChange={(event) => setLocationId(event.target.value)}><option value="">Todas las sucursales</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}</select></label><span>{body.length}/3000</span><button className="primary" type="submit" disabled={publish.isPending || !body.trim()}><Send size={17}/>{publish.isPending ? 'Publicando…' : 'Publicar aviso'}</button></div>
    </form>
    {publish.isError && <div className="alert error">{apiErrorMessage(publish.error)}</div>}
    {archive.isError && <div className="alert error">{apiErrorMessage(archive.error)}</div>}
    {list.isError && <div className="alert error">No se pudieron cargar los avisos. {apiErrorMessage(list.error)}</div>}
    {list.isLoading && <p className="muted">Cargando avisos…</p>}
    {Boolean(list.data?.announcements.length) && <div className="announcement-list"><h3>Avisos publicados</h3>{list.data!.announcements.map((announcement) => <article className="announcement-item" key={announcement.id}><div><small>{announcement.location_id ? locations.find((location) => location.id === announcement.location_id)?.name ?? 'Sucursal' : 'Todas las sucursales'} · {new Date(announcement.created_at).toLocaleDateString('es-EC')}</small><p>{announcement.body}</p></div><button type="button" className="ghost" aria-label="Retirar aviso" title="Retirar aviso" disabled={archive.isPending} onClick={() => archive.mutate(announcement.id)}><Trash2 size={17}/></button></article>)}</div>}
  </section>;
}
