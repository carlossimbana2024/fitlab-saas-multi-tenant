import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Medal, Users, Target } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';
import type { LoyaltyData } from './LoyaltyRewards';

type Engagement = {
 referral_code: string | null; unread: number;
 preferences: { email: boolean; whatsapp: boolean };
 notifications: { id: string; title: string; body: string; read_at: string | null }[];
 badges: { code: string; name: string; description: string; earned: boolean }[];
 mission: { target: number; progress: number; week_starts_on: string } | null;
 referrals: { registered: number; qualified: number };
 received_referral: { qualified: boolean } | null;
};
export function LoyaltyEngagement() {
 const { session } = useAuth();
 const client = useQueryClient();
 const key = ['loyalty-engagement', session?.gymUser?.gym_id, session?.gymUser?.id];
 const query = useQuery({ queryKey: key, queryFn: async () => (await api.get<Engagement>('/loyalty/me/engagement')).data });
 const campaigns = useQuery({ queryKey: ['loyalty-referral-campaigns', session?.gymUser?.gym_id, session?.gymUser?.id], queryFn: async () => (await api.get<LoyaltyData>('/loyalty/me')).data.promotions.filter(p => p.rule_type === 'referral') });
 const [code, setCode] = useState('');
 const [promotionId, setPromotionId] = useState('');
 const action = useMutation({ mutationFn: async ({ path, body, put }: { path: string; body?: unknown; put?: boolean }) => put ? api.put(`/loyalty/me/${path}`, body) : api.post(`/loyalty/me/${path}`, body), onSuccess: async () => { await client.invalidateQueries({ queryKey: key }); } });
 if (query.isPending) return <p role="status">Cargando tus logros…</p>;
 if (query.isError) return <p className="alert error">{apiErrorMessage(query.error)}</p>;
 const data = query.data;
 return <div className="loyalty-engagement">
  {action.isError && <p role="alert" className="alert error">{apiErrorMessage(action.error)}</p>}
  <div className="loyalty-grid">
   <section className="panel loyalty-card"><Target/><h2>Tu meta semanal</h2>{data.mission ? <><strong>{data.mission.progress} / {data.mission.target} días</strong><progress max={data.mission.target} value={Math.min(data.mission.progress, data.mission.target)}/><p>Una meta a tu ritmo, basada en tu frecuencia deseada. Descansar también forma parte del proceso.</p></> : <p>Tu meta aparecerá después de la próxima evaluación del gimnasio.</p>}</section>
   <section className="panel loyalty-card"><Users/><h2>Entrenar acompañado</h2><p>Comparte tu código. Tu amigo debe registrarlo en una campaña activa antes de pagar su primera mensualidad.</p>{data.referral_code ? <output className="loyalty-code">{data.referral_code}</output> : <button className="small-button" disabled={action.isPending} onClick={() => action.mutate({ path: 'referral-code' })}>Crear mi código</button>}<p>{data.referrals.registered} referidos · {data.referrals.qualified} con mensualidad válida</p><small>Una recompensa por persona y campaña, sujeta a cupos. No se muestran los datos personales de tus referidos.</small></section>
  </div>
  <section className="panel loyalty-card"><Medal/><h2>Tus medallas</h2><div className="loyalty-badges">{data.badges.map(b => <article key={b.code} className={b.earned ? 'earned' : ''}><Medal aria-hidden="true"/><strong>{b.name}</strong><small>{b.description}</small><span>{b.earned ? 'Conseguida' : 'Por descubrir'}</span></article>)}</div><p>Logros privados. Solo cuentan asistencias generales válidas.</p></section>
  {!data.received_referral && Boolean(campaigns.data?.length) && <form className="panel loyalty-card" onSubmit={e => { e.preventDefault(); action.mutate({ path: 'referrals', body: { code: code.trim(), promotionId } }); }}><h2>¿Te invitó un amigo?</h2><div className="loyalty-form-grid"><label>Campaña<select required value={promotionId} onChange={e => setPromotionId(e.target.value)}><option value="">Selecciona una campaña</option>{campaigns.data?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Código<input required minLength={16} maxLength={16} pattern="[a-fA-F0-9]{16}" value={code} onChange={e => setCode(e.target.value)} autoCapitalize="characters"/></label></div><p>La atribución no se puede cambiar. Confirma el código antes de enviarlo.</p><button className="primary" disabled={action.isPending}>Registrar referido</button></form>}
  {data.received_referral && <p className="loyalty-guidance">Invitación registrada: {data.received_referral.qualified ? 'mensualidad validada' : 'pendiente de la primera mensualidad válida'}.</p>}
  <section className="panel loyalty-card"><Bell/><h2>Avisos · {data.unread} sin leer</h2>{data.notifications.length ? <div className="loyalty-notifications">{data.notifications.map(n => <article key={n.id}><strong>{n.title}</strong><p>{n.body}</p>{!n.read_at && <button className="small-button" disabled={action.isPending} onClick={() => action.mutate({ path: `notifications/${n.id}/read` })}>Marcar como leído</button>}</article>)}</div> : <p>Aquí aparecerán tus próximos logros y recordatorios.</p>}</section>
  <section className="panel loyalty-card"><h2>Recordatorios externos</h2><p>Opcionales. Solo se enviarán cuando FitLab tenga configurado un proveedor para estos canales. Puedes retirar tu autorización en cualquier momento.</p><label className="loyalty-check"><input type="checkbox" checked={data.preferences.email} disabled={action.isPending} onChange={e => action.mutate({ path: 'notification-preferences', put: true, body: { ...data.preferences, email: e.target.checked } })}/>Autorizo avisos de fidelización por correo</label><label className="loyalty-check"><input type="checkbox" checked={data.preferences.whatsapp} disabled={action.isPending} onChange={e => action.mutate({ path: 'notification-preferences', put: true, body: { ...data.preferences, whatsapp: e.target.checked } })}/>Autorizo avisos de fidelización por WhatsApp</label></section>
 </div>;
}
