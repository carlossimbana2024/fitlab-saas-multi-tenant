import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, FileText, LoaderCircle, MessageCircle, Upload } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';
import { selectMembershipCoverage } from '../utils/membershipCoverage';
import { GymContactCard } from '../components/GymContactCard';
import { gymWhatsAppNumber, membershipMoney, membershipPaymentMethodLabels as methods, membershipPaymentStatusLabels as statuses, membershipWhatsAppMessage, type MembershipPaymentPlan, type MembershipPaymentRequest } from '../utils/membershipPayments';
import '../membership-payments.css';

type PortalPayments = {
  memberships: Array<{ id: string; plan_id: string; status: string; plans?: MembershipPaymentPlan; membership_periods: Array<{ starts_on: string; ends_on: string; status: string }> }>;
  plans: MembershipPaymentPlan[]; requests: MembershipPaymentRequest[];
  payments: Array<{ id: string; amount: number; currency: string; payment_method: string; status: string; paid_at: string; receipt_number: number; receipt_verification_token: string }>;
  settings: { enabled: boolean; instructions: string; methods: string[] };
  gym: { name: string; timezone: string }; location: string | null; whatsappPhone: string | null;
};

export function MemberPaymentsPage() {
  const { session } = useAuth();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['my-membership-payments', session?.gymUser?.id], queryFn: async () => (await api.get<PortalPayments>('/membership-payment-requests/me')).data, refetchInterval: 30_000 });
  const otherPayments=useQuery({queryKey:['my-payments'],queryFn:async()=>(await api.get<{payments:Array<{id:string;amount:number;currency:string;payment_method:string;status:string;paid_at:string}>}>('/member-payments/me')).data.payments});
  const [planId, setPlanId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [channel, setChannel] = useState<'fitlab' | 'whatsapp'>('fitlab');
  const [form, setForm] = useState({ amount: '', paidOn: '', method: '', reference: '', comment: '' });
  const [proofUrl, setProofUrl] = useState('');
  const [success, setSuccess] = useState(false);
  const data = query.data;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: data?.gym.timezone ?? 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  useEffect(() => {
    if (!data) return;
    setPlanId((current) => data.plans.some((p) => p.id === current) ? current : data.plans[0]?.id ?? '');
    setForm((current) => ({ ...current, paidOn: current.paidOn || today, method: data.settings.methods.includes(current.method) ? current.method : data.settings.methods[0] ?? '' }));
  }, [data, today]);
  const plan = data?.plans.find((p) => p.id === planId);
  useEffect(() => { if (plan) setForm((current) => ({ ...current, amount: String(plan.price) })); }, [plan?.id, plan?.price]);
  const refresh = async () => {
    await Promise.all(['my-membership-payments', 'my-memberships', 'my-payments', 'loyalty-engagement'].map((key) => client.invalidateQueries({ queryKey: [key] })));
  };
  const submit = useMutation({
    mutationFn: async () => {
      if (channel === 'fitlab' && (!file || file.size > 5_242_880 || !['image/jpeg', 'image/png', 'application/pdf'].includes(file.type))) throw new Error('Selecciona un JPG, PNG o PDF de hasta 5 MB.');
      const prepared = (await api.post<{ id: string; signedUrl: string | null; amount: number }>('/membership-payment-requests/me/prepare', { planId, channel, ...(channel === 'fitlab' ? { contentType: file!.type } : {}) })).data;
      if (channel === 'fitlab') {
        const uploaded = await fetch(prepared.signedUrl!, { method: 'PUT', headers: { 'content-type': file!.type, 'x-upsert': 'false' }, body: file! });
        if (!uploaded.ok) throw new Error('No se pudo subir el comprobante. Puedes intentarlo de nuevo.');
      }
      return api.post(`/membership-payment-requests/me/${prepared.id}/submit`, { ...form, amount: Number(form.amount), channel });
    },
    onSuccess: async () => { setFile(null); setSuccess(true); await refresh(); },
    onError: refresh,
  });
  const cancel = useMutation({ mutationFn: async (id: string) => api.post(`/membership-payment-requests/me/${id}/cancel`), onSuccess: refresh });
  const proof = useMutation({ mutationFn: async (id: string) => (await api.get<{ url: string }>(`/membership-payment-requests/me/${id}/proof`)).data.url, onSuccess: setProofUrl });
  if (query.isPending) return <p role="status"><LoaderCircle className="spin"/> Cargando membresía y pagos…</p>;
  if (query.isError) return <div className="alert error">{apiErrorMessage(query.error)} <button className="small-button" onClick={() => void query.refetch()}>Reintentar</button></div>;
  const { membership, period } = selectMembershipCoverage(data!.memberships, today);
  const fallback = data!.memberships.find((m) => m.status === 'active') ?? data!.memberships[0];
  const shownMembership = membership ?? fallback;
  const remaining = period ? Math.max(0, Math.floor((Date.parse(`${period.ends_on}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) + 1) : 0;
  const coverageState = period ? period.starts_on > today ? 'Cobertura futura' : period.ends_on < today ? 'Vencida' : 'Vigente' : 'Sin cobertura vigente';
  const pending = data!.requests.find((r) => r.status === 'pending');
  const revision = data!.requests.find((r) => r.status === 'revision_requested');
  const phone = gymWhatsAppNumber(data!.whatsappPhone);
  const onSubmit = (event: FormEvent) => { event.preventDefault(); setSuccess(false); setProofUrl(''); submit.mutate(); };
  return <div className="member-payment-page">
    <div className="page-heading"><div><p className="eyebrow">TU MEMBRESÍA</p><h1>Membresía y pagos</h1><p>{data!.gym.name}{data!.location ? ` · ${data!.location}` : ''}</p></div></div>
    <section className="panel membership-payment-summary"><CreditCard/><div><h2>{shownMembership?.plans?.name ?? 'Elige tu primera membresía'}</h2><p>{period ? `${period.starts_on} → ${period.ends_on}` : 'Aún no tienes un período vigente'}</p><span className="badge">{coverageState}</span>{period && <small>{remaining} días de cobertura restantes</small>}</div><strong>{plan ? membershipMoney(plan.price, plan.currency) : 'Consulta en recepción'}</strong></section>
    {success && <p className="alert success" role="status">Solicitud registrada. Tu membresía se activará o renovará cuando el gimnasio confirme el ingreso.{channel === 'whatsapp' && ' Ahora abre WhatsApp y adjunta tu comprobante.'}</p>}
    {pending && <section className="panel"><h2>Pago en revisión</h2><p>{membershipMoney(pending.amount, pending.currency)} · {pending.plan_snapshot.name}</p><p>El gimnasio debe verificar el ingreso antes de activar la cobertura.</p>{pending.channel === 'whatsapp' && phone && <a className="primary" href={`https://wa.me/${phone}?text=${encodeURIComponent(membershipWhatsAppMessage(session?.gymUser?.profiles?.full_name ?? 'Miembro', session!.gymUser!.id, pending))}`} target="_blank" rel="noreferrer"><MessageCircle/>Abrir WhatsApp y adjuntar comprobante</a>}<button className="ghost" disabled={cancel.isPending} onClick={() => { if (window.confirm('¿Retirar esta solicitud de revisión? Esto no devuelve el dinero transferido.')) cancel.mutate(pending.id); }}>Retirar solicitud</button></section>}
    {revision && <p className="alert warning">El gimnasio solicita una corrección: {revision.review_reason}. Completa el formulario y envía el comprobante nuevamente.</p>}
    {!pending && <section className="panel"><div className="panel-title"><div><h2>{shownMembership ? 'Renovar mi membresía' : 'Registrar mi primer pago'}</h2><p>Realiza el pago al gimnasio y presenta tu comprobante.</p></div><Upload/></div>{!data!.settings.enabled ? <p className="alert warning">Tu sucursal todavía no ha habilitado este servicio. Contacta a recepción.</p> : !plan ? <p className="alert warning">Tu plan no está disponible para pagar desde el portal. Contacta a recepción.</p> : <>
      <div className="membership-payment-instructions">{data!.settings.instructions}</div>
      <p className="form-note">Envía tu solicitud dentro de 7 días para conservar ese precio durante la revisión. La cobertura vigente se respeta; si venció, la nueva comienza al aprobarse. Los cambios de plan y recompensas se gestionan en recepción.</p>
      <form className="membership-payment-form" onSubmit={onSubmit}>
        <label>Plan<select required value={planId} disabled={Boolean(shownMembership)} onChange={(e) => setPlanId(e.target.value)}>{data!.plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {membershipMoney(p.price, p.currency)}</option>)}</select></label>
        <label>Valor pagado ({plan.currency})<input required type="number" step="0.01" min="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}/><small>Debe coincidir con {membershipMoney(plan.price, plan.currency)}.</small></label>
        <label>Fecha del pago<input required type="date" max={today} value={form.paidOn} onChange={(e) => setForm({ ...form, paidOn: e.target.value })}/></label>
        <label>Método<select required value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{data!.settings.methods.map((m) => <option key={m} value={m}>{methods[m]}</option>)}</select></label>
        <label>Referencia opcional<input maxLength={200} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })}/></label>
        <label>Cómo entregar el comprobante<select value={channel} disabled={submit.isPending} onChange={(e) => setChannel(e.target.value as typeof channel)}><option value="fitlab">Adjuntarlo en FitLab</option>{phone && <option value="whatsapp">Enviarlo por WhatsApp</option>}</select></label>
        {channel === 'fitlab' ? <label className="wide">Comprobante · JPG, PNG o PDF, hasta 5 MB<input type="file" accept="image/jpeg,image/png,application/pdf" required disabled={submit.isPending} onChange={(e) => setFile(e.target.files?.[0] ?? null)}/>{file && <small>{file.name}</small>}</label> : <p className="form-note wide">Después de registrar la solicitud, abrirás WhatsApp y adjuntarás el archivo manualmente. FitLab no envía archivos ni mensajes automáticamente.</p>}
        <label className="wide">Comentario opcional<textarea maxLength={1000} value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })}/></label>
        {submit.isError && <p className="alert error wide" role="alert">{apiErrorMessage(submit.error)}</p>}
        <button className="primary wide" disabled={submit.isPending || !planId || Number(form.amount) !== Number(plan.price)}>{submit.isPending ? <><LoaderCircle className="spin"/>Enviando…</> : channel === 'fitlab' ? 'Enviar a revisión' : 'Registrar pago para enviar por WhatsApp'}</button>
      </form></>}
    </section>}
    {(cancel.isError || proof.isError) && <p className="alert error">{apiErrorMessage(cancel.error ?? proof.error)}</p>}
    {proofUrl && <a className="small-button" href={proofUrl} target="_blank" rel="noreferrer">Descargar comprobante · enlace válido por 1 minuto</a>}
    <section className="panel"><h2>Mis solicitudes</h2><div className="portal-history">{data!.requests.filter((r) => r.status !== 'draft').map((r) => <article key={r.id}><div><strong>{r.plan_snapshot.name} · {membershipMoney(r.amount, r.currency)}</strong><small>{r.paid_on ?? r.created_at.slice(0, 10)} · {r.method ? methods[r.method] : ''}</small>{r.review_reason && <p>{r.review_reason}</p>}</div><div><span className={`badge ${r.status}`}>{statuses[r.status]}</span>{r.channel === 'fitlab' && <button className="small-button" disabled={proof.isPending} onClick={() => proof.mutate(r.id)}><FileText/>Comprobante</button>}</div></article>)}</div>{!data!.requests.some((r) => r.status !== 'draft') && <p>Todavía no has presentado solicitudes.</p>}</section>
    <section className="panel"><h2>Historial de pagos</h2><div className="portal-history">{data!.payments.map((p) => <article key={p.id}><div><strong>{membershipMoney(p.amount, p.currency)}</strong><small>{new Date(p.paid_at).toLocaleDateString('es-EC', { timeZone: data!.gym.timezone })} · {methods[p.payment_method] ?? p.payment_method}</small></div><div><span className={`badge ${p.status}`}>{statuses[p.status] ?? p.status}</span><Link className="small-button" to={`/receipt/verify/${p.receipt_verification_token}`}>Ver recibo {p.receipt_number}</Link></div></article>)}</div>{!data!.payments.length && <p>Todavía no tienes pagos registrados.</p>}</section>
    {otherPayments.isError&&<p className="alert error">No se pudieron cargar otros pagos registrados. <button className="small-button" onClick={()=>void otherPayments.refetch()}>Reintentar historial</button></p>}
    {otherPayments.data?.some(payment=>!data!.payments.some(item=>item.id===payment.id))&&<section className="panel"><h2>Otros pagos registrados</h2><div className="portal-history">{otherPayments.data.filter(payment=>!data!.payments.some(item=>item.id===payment.id)).map(payment=><article key={payment.id}><div><strong>{membershipMoney(payment.amount,payment.currency)}</strong><small>{methods[payment.payment_method]??payment.payment_method} · {new Date(payment.paid_at).toLocaleDateString('es-EC',{timeZone:data!.gym.timezone})}</small></div><span className={`badge ${payment.status}`}>{statuses[payment.status]??payment.status}</span></article>)}</div></section>}
    <GymContactCard/>
  </div>;
}
