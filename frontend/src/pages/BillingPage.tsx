import { useQuery } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { api } from '../services/api';
import { ManualBilling } from '../components/ManualBilling';

type BillingStatus = { gym: { id: string; name: string; status: string }; subscription: { status: string; effective_status: string; trial_ends_at: string | null; current_period_ends_at: string | null; cancel_at_period_end: boolean; provider: string; provider_subscription_id: string | null; plan_name_snapshot: string; price_snapshot: number; currency_snapshot: string }; graceDays: number };
export function BillingPage() {
  const query = useQuery({ queryKey: ['billing-status'], queryFn: async () => (await api.get<BillingStatus>('/billing/status')).data });
  if (query.isLoading) return <div className="page">Cargando suscripción…</div>;
  if (!query.data) return <div className="page"><div className="alert error">No se pudo cargar la suscripción.</div></div>;
  const { gym, subscription } = query.data; const trialEnd = subscription.trial_ends_at ? new Date(subscription.trial_ends_at) : null; const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / 86_400_000)) : 0; const status = subscription.effective_status;
  return <div className="page billing-page"><div className="page-heading"><div><p className="eyebrow">PLAN DE FITLAB</p><h1>Suscripción</h1><p>Administra la prueba y activación de {gym.name}.</p>{subscription.current_period_ends_at&&<p>Vigencia pagada hasta {new Date(subscription.current_period_ends_at).toLocaleDateString('es-EC')}</p>}</div></div><div className="billing-grid">
    <section className="panel billing-plan"><CreditCard/><p className="eyebrow">{status === 'trialing' ? 'PRUEBA GRATUITA' : 'PLAN ACTUAL'}</p><h2>{subscription.plan_name_snapshot}</h2><strong>{Number(subscription.price_snapshot).toFixed(2)} {subscription.currency_snapshot}<small>/mes</small></strong>{status === 'trialing' && <div className="trial-count"><b>{daysLeft}</b><span>días restantes<small>Finaliza el {trialEnd?.toLocaleDateString('es-EC')}</small></span></div>}<span className={`badge ${status === 'active' ? 'active' : 'invited'}`}>{status === 'past_due' ? 'pago pendiente' : status}</span></section>
    {subscription.provider_subscription_id ? <section className="panel"><p>Esta suscripción está vinculada a Stripe. Contacta con FitLab para cambiarla a pagos manuales.</p></section> : <ManualBilling/>}
  </div></div>;
}
