import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Trophy } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiErrorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';
import '../loyalty.css';
import { LoyaltyEngagement } from './LoyaltyEngagement';

export type Promotion = {
  id: string; name: string; description: string; status: string; location_id: string; location_name?: string;
  starts_on: string; ends_on: string; redeem_until: string; rule_type: 'attendance_count' | 'required_streak' | 'perfect_attendance' | 'recovery' | 'referral';
  auto_award?: boolean; inactive_days?: number; minimum_payment?: number;
  target: number; reward_type: 'discount' | 'free_period' | 'product'; reward_value: number;
  product_id: string | null; product_name: string | null; max_rewards: number; progress?: number; remaining?: number;
};
export type Reward = { id: string; promotion_id: string; status: string; expires_on: string; terms: Promotion; revoked_reason?: string };
export type LoyaltyData = { today: string; promotions: Promotion[]; rewards: Reward[] };
export const rewardLabel = (p: Promotion) => p.reward_type === 'discount' ? `${p.reward_value}% en tu próxima renovación` : p.reward_type === 'free_period' ? `${p.reward_value} ${p.reward_value === 1 ? 'mes gratis' : 'meses gratis'}` : `${p.reward_value} × ${p.product_name ?? 'producto de regalo'}`;
export const ruleLabel = (p: Promotion) => p.rule_type === 'referral' ? `Primera mensualidad confirmada de al menos ${p.minimum_payment ?? 1} en la moneda del gimnasio; código antes del pago` : p.rule_type === 'recovery' ? `${p.target} días de regreso después de recibir la invitación` : p.rule_type === 'perfect_attendance' ? 'Todos los días obligatorios del período' : p.rule_type === 'attendance_count' ? `${p.target} días de asistencia` : `${p.target} días obligatorios consecutivos`;
export const loyaltyStatus: Record<string, string> = { draft: 'Borrador', active: 'Activa', paused: 'Pausada', closed: 'Cerrada', available: 'Lista para canjear', redeemed: 'Canjeada', expired: 'Vencida', revoked: 'Revocada' };
export const loyaltyDate = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('es-EC', { day: 'numeric', month: 'short', year: 'numeric' });

export function LoyaltyRewards({ memberId }: { memberId?: string }) {
  const client = useQueryClient();
  const { session } = useAuth();
  const [action, setAction] = useState<{ reward: Reward; type: 'redeem-product' | 'revoke' } | null>(null);
  const [reason, setReason] = useState('');
  const path = memberId ? `/loyalty/members/${memberId}` : '/loyalty/me';
  const query = useQuery({ queryKey: ['loyalty', session?.gymUser?.gym_id, session?.gymUser?.id, memberId ?? 'me'], queryFn: async () => (await api.get<LoyaltyData>(path)).data });
  const refresh = async () => {
    await Promise.all(['loyalty', 'loyalty-engagement', 'commerce-products', 'inventory-movements'].map((key) => client.invalidateQueries({ queryKey: [key] })));
  };
  const claim = useMutation({ mutationFn: async (id: string) => api.post(`${path}/promotions/${id}/claim`), onSuccess: refresh });
  const redeem = useMutation({ mutationFn: async () => api.post(`/loyalty/rewards/${action!.reward.id}/${action!.type}`, action!.type === 'revoke' ? { reason } : {}), onSuccess: async () => { setAction(null); setReason(''); await refresh(); } });
  if (query.isPending) return <p role="status">Cargando tus retos y recompensas…</p>;
  if (query.isError) return <div className="alert error">{apiErrorMessage(query.error)} <button className="small-button" onClick={() => void query.refetch()}>Reintentar</button></div>;
  const data = query.data;
  return <div className="loyalty-content">
    <div className="loyalty-guidance"><Gift/><p>Cada día válido cuenta una sola vez. Las clases no suman una segunda asistencia. Descansar también es parte del proceso: en retos de racha solo cuentan los días obligatorios definidos al publicar.</p></div>
    {claim.isError && <p className="alert error" role="alert">{apiErrorMessage(claim.error)}</p>}
    <h2>Retos del gimnasio</h2>
    {!data.promotions.length && <div className="panel loyalty-empty"><Gift/><h3>Aquí comienza tu próximo reto</h3><p>Cuando tu gimnasio publique una promoción, podrás consultar sus condiciones y tu avance.</p></div>}
    <div className="loyalty-grid">{data.promotions.map((p) => {
      const earned = data.rewards.some((r) => r.promotion_id === p.id);
      const progress = p.progress ?? 0;
      const eligible = p.status === 'active' && !earned && progress >= p.target && (p.remaining ?? 0) > 0 && data.today >= p.starts_on;
      return <article className="panel loyalty-card" key={p.id}>
        <div className="loyalty-card-top"><span className="loyalty-icon"><Trophy/></span><span className={`badge ${p.status}`}>{loyaltyStatus[p.status]}</span></div>
        <h3>{p.name}</h3><strong className="loyalty-prize">{rewardLabel(p)}</strong><p>{p.description}</p>
        <p>{ruleLabel(p)} · {p.location_name}</p>
        <div className="loyalty-progress-label"><span>{Math.min(progress, p.target)} de {p.target} {p.rule_type === 'referral' ? 'mensualidad validada' : 'días'}</span><strong>{Math.min(100, Math.floor(progress / p.target * 100))}%</strong></div>
        <progress max={p.target} value={Math.min(progress, p.target)} aria-label={`Avance de ${p.name}`}/>
        <small>{progress >= p.target ? '¡Meta alcanzada! Reclama tu recompensa si quedan cupos.' : p.rule_type === 'required_streak' ? 'Se muestra tu mejor racha del período. Faltar a un día obligatorio reinicia el tramo en curso.' : p.rule_type === 'perfect_attendance' ? 'Debes completar todos los días obligatorios del período. Un día perdido impide completar este reto.' : p.rule_type === 'referral' ? 'La primera mensualidad del referido debe cumplir las condiciones y seguir confirmada.' : `Cada visita suma. Te faltan ${p.target - progress} días para esta meta.`}</small>
        <dl><div><dt>Participación</dt><dd>{loyaltyDate(p.starts_on)} – {loyaltyDate(p.ends_on)}</dd></div><div><dt>Canje hasta</dt><dd>{loyaltyDate(p.redeem_until)}</dd></div><div><dt>Cupos restantes</dt><dd>{p.remaining} de {p.max_rewards}</dd></div></dl>
        <button className="primary" disabled={!eligible || claim.isPending} onClick={() => claim.mutate(p.id)}>{earned ? 'Recompensa ya reclamada' : !p.remaining ? 'Cupos agotados' : p.status === 'paused' ? 'Reclamaciones pausadas' : eligible ? (claim.isPending ? 'Reclamando…' : 'Reclamar recompensa') : 'Continúa tu reto'}</button>
      </article>;
    })}</div>
    <h2>{memberId ? 'Recompensas del miembro' : 'Mis recompensas'}</h2>
    <p>Una recompensa por campaña y miembro. No acumulable en una misma renovación. Reclamar reserva tu cupo; el canje lo realiza el owner, después de comprobar la asistencia.</p>
    {!data.rewards.length && <p className="panel">Todavía no hay recompensas reclamadas.</p>}
    <div className="loyalty-grid">{data.rewards.map((r) => <article className="panel loyalty-card" key={r.id}><div className="loyalty-card-top"><Gift/><span className={`badge ${r.status}`}>{loyaltyStatus[r.status]}</span></div><h3>{r.terms.name}</h3><strong>{rewardLabel(r.terms)}</strong><p>{r.terms.location_name && <>Sucursal: {r.terms.location_name}. </>}Canje hasta {loyaltyDate(r.expires_on)}.</p>{r.revoked_reason && <p>Motivo: {r.revoked_reason}</p>}{r.status === 'available' && (memberId ? <div className="loyalty-actions">{r.terms.reward_type === 'product' ? <button className="primary" onClick={() => { redeem.reset(); setAction({ reward: r, type: 'redeem-product' }); }}>Entregar producto</button> : <Link className="small-button" to="/memberships">Canjear al renovar</Link>}<button className="small-button danger-text" onClick={() => { redeem.reset(); setReason(''); setAction({ reward: r, type: 'revoke' }); }}>Revocar</button></div> : <p>Solicita el canje al owner. No se realizan pagos desde el portal del miembro.</p>)}</article>)}</div>
    {action && <section className="panel loyalty-confirm" aria-label="Confirmar operación de recompensa"><h3>{action.type === 'revoke' ? 'Revocar recompensa' : 'Confirmar entrega'}</h3><p>{rewardLabel(action.reward.terms)}. {action.type === 'redeem-product' ? 'Confirma únicamente cuando entregues el producto. Se descontará del stock de la sucursal de la promoción, sin registrar una venta.' : 'El cupo no se libera y el miembro no podrá reclamarla otra vez.'}</p>{action.type === 'revoke' && <label>Motivo<textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)}/></label>}{redeem.isError && <p className="alert error">{apiErrorMessage(redeem.error)}</p>}<div className="loyalty-actions"><button className="ghost" disabled={redeem.isPending} onClick={() => setAction(null)}>Cancelar</button><button className="primary" disabled={redeem.isPending || (action.type === 'revoke' && reason.trim().length < 3)} onClick={() => redeem.mutate()}>{redeem.isPending ? 'Procesando…' : 'Confirmar'}</button></div></section>}
  </div>;
}

export function MemberRewardsPage() {
  return <section className="loyalty-page"><Link className="small-button" to="/portal">Volver a Inicio</Link><div className="page-heading"><div><p className="eyebrow">TU CONSTANCIA TIENE PREMIO</p><h1>Retos y recompensas</h1><p>Metas claras, pequeños avances y reconocimientos de tu gimnasio.</p></div></div><LoyaltyEngagement/><LoyaltyRewards/></section>;
}
