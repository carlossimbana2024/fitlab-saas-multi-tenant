import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';

type Campaign = { promotion_id: string; name: string; currency: string; participants: number; awarded: number; redeemed: number; discount_total: number; product_cost: number; unknown_product_costs: number; free_months: number; retention_eligible: number; retention_returned: number; referrals: number; qualified_referrals: number };
type Analytics = { current: { campaigns: Campaign[] }; snapshot: { campaigns: Campaign[] } | null; closed_at: string | null; job: { last_run_at: string | null; pending: boolean } | null; pending_rewards: number; expiring_rewards: number };
export function LoyaltyAnalytics() {
 const { session } = useAuth();
 const client = useQueryClient();
 const [month, setMonth] = useState(() => new Date().toLocaleDateString('sv-SE').slice(0, 7));
 const [snapshot, setSnapshot] = useState(false);
 const key = ['loyalty-analytics', session?.gymUser?.gym_id, session?.gymUser?.id, month];
 const query = useQuery({ queryKey: key, queryFn: async () => (await api.get<Analytics>('/loyalty/analytics', { params: { month } })).data });
 const evaluate = useMutation({ mutationFn: async () => (await api.post<{ processed: number; done: boolean }>('/loyalty/evaluate')).data, onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ['loyalty-analytics'] }), client.invalidateQueries({ queryKey: ['loyalty'] })]); } });
 const data = query.data;
 const campaigns = (snapshot ? data?.snapshot : data?.current)?.campaigns ?? [];
 const money = (n: number, currency: string) => new Intl.NumberFormat('es-EC', { style: 'currency', currency }).format(n);
 return <div className="loyalty-engagement">
  <section className="panel loyalty-card"><div className="loyalty-card-top loyalty-analytics-header"><div><BarChart3/><h2>Resultados de tus campañas</h2></div><label>Período<input type="month" required value={month} onChange={e => { if (e.target.value) { setMonth(e.target.value); setSnapshot(false); } }}/></label></div><p>Última evaluación: {data?.job?.last_run_at ? new Date(data.job.last_run_at).toLocaleString('es-EC') : 'pendiente'}.</p><button className="small-button" disabled={evaluate.isPending} onClick={() => evaluate.mutate()}><RefreshCw/>{evaluate.isPending ? 'Evaluando…' : data?.job?.pending ? 'Continuar evaluación' : 'Evaluar ahora'}</button><p>Procesa hasta 100 miembros por bloque. No canjea premios ni envía mensajes externos desde este botón.</p>{evaluate.data && <p role="status">{evaluate.data.processed} miembros evaluados. {evaluate.data.done ? 'Evaluación terminada.' : 'Quedan miembros: pulsa Continuar evaluación.'}</p>}{evaluate.isError && <p className="alert error">{apiErrorMessage(evaluate.error)}</p>}
   {data && <p>{data.pending_rewards} premios disponibles · {data.expiring_rewards} vencen en los próximos 3 días.</p>}
   {data?.snapshot && <label className="loyalty-check"><input type="checkbox" checked={snapshot} onChange={e => setSnapshot(e.target.checked)}/>Ver copia de cierre ({new Date(data.closed_at!).toLocaleDateString('es-EC')})</label>}
   <small>{snapshot ? 'Copia histórica inmutable; representa lo conocido al cerrar el período.' : 'Datos recalculados: reflejan pagos anulados y cohortes que ya completaron su período de seguimiento.'}</small>
  </section>
  {query.isPending && <p role="status">Cargando métricas…</p>}{query.isError && <p className="alert error">{apiErrorMessage(query.error)}</p>}
  <div className="loyalty-grid">{campaigns.map(c => <article key={c.promotion_id} className="panel loyalty-card"><h3>{c.name}</h3><dl className="loyalty-metrics"><div><dt>Nuevos participantes detectados</dt><dd>{c.participants}</dd></div><div><dt>Premios otorgados</dt><dd>{c.awarded}</dd></div><div><dt>Canjes del mes</dt><dd>{c.redeemed}</dd></div><div><dt>Descuentos concedidos</dt><dd>{money(c.discount_total, c.currency)}</dd></div><div><dt>Costo conocido de regalos</dt><dd>{money(c.product_cost, c.currency)}</dd></div><div><dt>Meses gratuitos</dt><dd>{c.free_months}</dd></div><div><dt>Referidos con pago válido</dt><dd>{c.qualified_referrals} / {c.referrals}</dd></div><div><dt>Retorno a los 30–59 días</dt><dd>{c.retention_eligible ? `${Math.round(c.retention_returned / c.retention_eligible * 100)}% (${c.retention_returned}/${c.retention_eligible})` : 'Aún sin cohorte madura'}</dd></div></dl>{c.unknown_product_costs > 0 && <p>{c.unknown_product_costs} regalos sin costo histórico: el total es parcial.</p>}</article>)}</div>
  {!query.isPending && !query.isError && !campaigns.length && <p className="panel loyalty-card">No hay campañas publicadas para este período.</p>}
  <p className="loyalty-guidance">La retención mide si hubo alguna asistencia válida entre los días 30 y 59 desde que se detectó participación; solo incluye personas con 60 días de seguimiento. Es una señal de retorno, no una prueba de que la promoción lo causó. Canjes y premios se cuentan por su fecha, por lo que no se divide uno por otro como tasa de conversión.</p>
 </div>;
}
