import { useQuery } from '@tanstack/react-query';
import { CreditCard, ExternalLink, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, apiErrorMessage } from '../services/api';

type BillingStatus = { gym: { id: string; name: string; status: string }; subscription: { status: string; trial_ends_at: string | null; current_period_ends_at: string | null; cancel_at_period_end: boolean; provider_subscription_id: string | null; plan_name_snapshot: string; price_snapshot: number; currency_snapshot: string }; graceDays: number };
export function BillingPage() {
  const [error, setError] = useState(''); const [redirecting, setRedirecting] = useState(false);
  const query = useQuery({ queryKey: ['billing-status'], queryFn: async () => (await api.get<BillingStatus>('/billing/status')).data });
  const activate = async () => { try { setError(''); setRedirecting(true); const { data } = await api.post<{ url: string }>('/billing/checkout'); window.location.assign(data.url); } catch (cause) { setRedirecting(false); setError(apiErrorMessage(cause)); } };
  if (query.isLoading) return <div className="page">Cargando suscripción…</div>;
  if (!query.data) return <div className="page"><div className="alert error">No se pudo cargar la suscripción.</div></div>;
  const { gym, subscription } = query.data; const trialEnd = subscription.trial_ends_at ? new Date(subscription.trial_ends_at) : null; const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / 86_400_000)) : 0;
  return <div className="page"><div className="page-heading"><div><p className="eyebrow">PLAN DE FITLAB</p><h1>Suscripción</h1><p>Administra la prueba y activación de {gym.name}.</p></div></div>{error && <div className="alert error">{error}</div>}<div className="billing-grid">
    <section className="panel billing-plan"><CreditCard/><p className="eyebrow">{subscription.status === 'trialing' ? 'PRUEBA GRATUITA' : 'PLAN ACTUAL'}</p><h2>{subscription.plan_name_snapshot}</h2><strong>{Number(subscription.price_snapshot).toFixed(2)} {subscription.currency_snapshot}<small>/mes</small></strong>{subscription.status === 'trialing' && <div className="trial-count"><b>{daysLeft}</b><span>días restantes<small>Finaliza el {trialEnd?.toLocaleDateString('es-EC')}</small></span></div>}<span className={`badge ${subscription.status === 'active' ? 'active' : 'invited'}`}>{subscription.status}</span></section>
    <section className="panel billing-action"><ShieldCheck/><h2>Activa FitLab con Stripe</h2><p>Serás dirigido a una página segura alojada por Stripe. En este MVP se utiliza exclusivamente el entorno de prueba.</p>{!subscription.provider_subscription_id ? <button className="primary" onClick={() => void activate()} disabled={redirecting}>{redirecting ? <><LoaderCircle className="spin"/>Abriendo Stripe…</> : <>Activar suscripción <ExternalLink/></>}</button> : <div className="alert success">La suscripción ya está vinculada con Stripe.</div>}</section>
  </div></div>;
}
