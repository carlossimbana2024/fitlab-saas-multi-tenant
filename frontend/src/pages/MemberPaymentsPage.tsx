import { HistoryPageFeedback, QueryFeedback } from '../components/QueryFeedback';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, FileText, LoaderCircle, MessageCircle, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';
import { summarizeMembershipCoverage } from '../utils/membershipCoverage';
import { useMemberHistory, type HistoryPage } from '../utils/memberHistory';
import { refreshMemberQueries } from '../utils/memberQueryInvalidation';
import { portalDate, useCurrentPortalDate } from '../utils/currentPortalDate';
import { gymTimezone } from '../utils/portalTime';
import { GymContactCard } from '../components/GymContactCard';
import { gymWhatsAppNumber, membershipMoney, membershipPaymentMethodLabels as methods, membershipPaymentStatusLabels as statuses, membershipWhatsAppMessage, type MembershipPaymentPlan, type MembershipPaymentRequest } from '../utils/membershipPayments';
import '../membership-payments.css';

type PortalPayments = {
  memberships: Array<{ id: string; plan_id: string; status: string; plans?: MembershipPaymentPlan; membership_periods: Array<{ starts_on: string; ends_on: string; status: string }> }>;
  plans: MembershipPaymentPlan[]; activeRequest: MembershipPaymentRequest | null;
  settings: { enabled: boolean; instructions: string; methods: string[] };
  gym: { name: string; timezone: string }; location: string | null; whatsappPhone: string | null;
};
type PaymentHistoryRow = { id: string; amount: number; currency: string; payment_method: string; status: string; paid_at: string; receipt_number: number | null; receipt_verification_token: string | null };
const requestStatuses = ['pending', 'revision_requested', 'approved', 'rejected', 'cancelled'];
const paymentStatuses = ['pending', 'confirmed', 'voided', 'refunded', 'failed'];
const historyStatusLabel = (status: string) => statuses[status] ?? (status === 'failed' ? 'Fallido' : status);

function PaymentHistorySection<T extends { id: string }>({ queryKey, title, label, empty, options, load, render }: {
  queryKey: readonly unknown[]; title: string; label: string; empty: string; options: string[];
  load: (status: string | undefined, cursor: string | null, signal: AbortSignal) => Promise<HistoryPage<T>>;
  render: (row: T) => ReactNode;
}) {
  const [status, setStatus] = useState('');
  const history = useMemberHistory([...queryKey, status], true, (cursor, signal) => load(status || undefined, cursor, signal));
  const rows = history.data?.pages.flatMap(page => page.items);
  return <section className="panel"><h2>{title}</h2>
    <label>Estado <select aria-label={`Estado: ${title}`} value={status} onChange={event => setStatus(event.target.value)}>
      <option value="">Todos</option>{options.map(option => <option key={option} value={option}>{historyStatusLabel(option)}</option>)}
    </select></label>
    {rows && (rows.length ? <div className="portal-history">{rows.map(render)}</div> : !history.isError && <p>{status ? 'No hay registros con este estado.' : empty}</p>)}
    <HistoryPageFeedback query={history} label={label}/>
  </section>;
}

export function MemberPaymentsPage() {
  const { session } = useAuth();
  const client = useQueryClient();
  const gymId = session?.gymUser?.gym_id;
  const memberId = session?.gymUser?.id;
  const query = useQuery({ queryKey: ['my-membership-payments', memberId], queryFn: async () => (await api.get<PortalPayments>('/membership-payment-requests/me', { params: { view: 'summary' } })).data, staleTime: 0, refetchInterval: 30_000 });
  const [planId, setPlanId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [channel, setChannel] = useState<'fitlab' | 'whatsapp'>('fitlab');
  const [form, setForm] = useState({ amount: '', paidOn: '', method: '', reference: '', comment: '' });
  const [proofUrl, setProofUrl] = useState('');
  const [success, setSuccess] = useState(false);
  const data = query.data;
  const activeRequest = data?.activeRequest;
  const activeRequestKey = activeRequest ? `${activeRequest.id}:${activeRequest.status}` : '';
  const lastReview = useRef<{ gymId?: string; memberId?: string; key: string } | null>(null);
  useEffect(() => {
    if (!data) return;
    const previous = lastReview.current;
    lastReview.current = { gymId, memberId, key: activeRequestKey };
    // If the existing summary refresh sees a review decision, refresh histories
    // without polling every loaded page on each summary tick.
    if (previous && previous.gymId === gymId && previous.memberId === memberId && previous.key !== activeRequestKey) {
      void refreshMemberQueries(client, { gymId, memberId }, 'paymentHistory');
    }
  }, [data, activeRequestKey, client, gymId, memberId]);
  const coverageToday = useCurrentPortalDate(gymTimezone(session?.gymUser?.gym?.timezone), session?.gymUser?.gym_id);
  const paymentToday = portalDate(Date.now(), gymTimezone(data?.gym.timezone));
  useEffect(() => {
    if (!data) return;
    setPlanId((current) => data.plans.some((p) => p.id === current) ? current : data.plans[0]?.id ?? '');
    setForm((current) => ({ ...current, paidOn: current.paidOn || paymentToday, method: data.settings.methods.includes(current.method) ? current.method : data.settings.methods[0] ?? '' }));
  }, [data, paymentToday]);
  const plan = data?.plans.find((p) => p.id === planId);
  useEffect(() => { if (plan) setForm((current) => ({ ...current, amount: String(plan.price) })); }, [plan?.id, plan?.price]);
  const refresh = async () => {
    await refreshMemberQueries(client, {gymId:session?.gymUser?.gym_id,memberId:session?.gymUser?.id}, 'paymentRequest');
  };
  const submit = useMutation({
    mutationFn: async () => {
      if (channel === 'fitlab' && (!file || file.size > 5_242_880 || !['image/jpeg', 'image/png', 'application/pdf'].includes(file.type))) throw new Error('Selecciona un JPG, PNG o PDF de hasta 5 MB.');
      const prepared = (await api.post<{ id: string; signedUrl: string | null; amount: number }>('/membership-payment-requests/me/prepare', { planId, channel, ...(channel === 'fitlab' ? { contentType: file!.type } : {}) })).data;
      try {
        if (channel === 'fitlab') {
          const uploaded = await fetch(prepared.signedUrl!, { method: 'PUT', headers: { 'content-type': file!.type, 'x-upsert': 'false' }, body: file! });
          if (!uploaded.ok) throw new Error('No se pudo subir el comprobante. Puedes intentarlo de nuevo.');
        }
        return await api.post(`/membership-payment-requests/me/${prepared.id}/submit`, { ...form, amount: Number(form.amount), channel });
      } catch (error) {
        // prepare already saved a draft; reconcile only that resource, not coverage/income.
        await refresh();
        throw error;
      }
    },
    onSuccess: async () => { setFile(null); setSuccess(true); await refresh(); },
  });
  const cancel = useMutation({ mutationFn: async (id: string) => api.post(`/membership-payment-requests/me/${id}/cancel`), onSuccess: refresh });
  const proof = useMutation({ mutationFn: async (id: string) => (await api.get<{ url: string }>(`/membership-payment-requests/me/${id}/proof`)).data.url, onSuccess: setProofUrl });
  if (data === undefined) return <QueryFeedback query={query} label="tu membresía y pagos"/>;
  const { membership, period, label } = summarizeMembershipCoverage(data.memberships, coverageToday);
  const shownMembership = membership ?? data.memberships[0];
  const pending = activeRequest?.status === 'pending' ? activeRequest : undefined;
  const revision = activeRequest?.status === 'revision_requested' ? activeRequest : undefined;
  const phone = gymWhatsAppNumber(data!.whatsappPhone);
  const onSubmit = (event: FormEvent) => { event.preventDefault(); setSuccess(false); setProofUrl(''); submit.mutate(); };
  return <div className="member-payment-page"><QueryFeedback query={query} label="tu membresía y pagos"/>
    <div className="page-heading"><div><p className="eyebrow">TU MEMBRESÍA</p><h1>Membresía y pagos</h1><p>{data!.gym.name}{data!.location ? ` · ${data!.location}` : ''}</p></div></div>
    <section className="panel membership-payment-summary"><CreditCard/><div><h2>{shownMembership?.plans?.name ?? 'Elige tu primera membresía'}</h2>{period && <p>{period.starts_on} → {period.ends_on}</p>}<span className="badge">{label}</span></div><strong>{plan ? membershipMoney(plan.price, plan.currency) : 'Consulta en recepción'}</strong></section>
    {success && <p className="alert success" role="status">Solicitud registrada. Tu membresía se activará o renovará cuando el gimnasio confirme el ingreso.{channel === 'whatsapp' && ' Ahora abre WhatsApp y adjunta tu comprobante.'}</p>}
    {pending && <section className="panel"><h2>Pago en revisión</h2><p>{membershipMoney(pending.amount, pending.currency)} · {pending.plan_snapshot.name}</p><p>El gimnasio debe verificar el ingreso antes de activar la cobertura.</p>{pending.channel === 'whatsapp' && phone && <a className="primary" href={`https://wa.me/${phone}?text=${encodeURIComponent(membershipWhatsAppMessage(session?.gymUser?.profiles?.full_name ?? 'Miembro', session!.gymUser!.id, pending))}`} target="_blank" rel="noreferrer"><MessageCircle/>Abrir WhatsApp y adjuntar comprobante</a>}<button className="ghost" disabled={cancel.isPending} onClick={() => { if (window.confirm('¿Retirar esta solicitud de revisión? Esto no devuelve el dinero transferido.')) cancel.mutate(pending.id); }}>Retirar solicitud</button></section>}
    {revision && <p className="alert warning">El gimnasio solicita una corrección: {revision.review_reason}. Completa el formulario y envía el comprobante nuevamente.</p>}
    {!pending && <section className="panel"><div className="panel-title"><div><h2>{shownMembership ? 'Renovar mi membresía' : 'Registrar mi primer pago'}</h2><p>Realiza el pago al gimnasio y presenta tu comprobante.</p></div><Upload/></div>{!data!.settings.enabled ? <p className="alert warning">Tu sucursal todavía no ha habilitado este servicio. Contacta a recepción.</p> : !plan ? <p className="alert warning">Tu plan no está disponible para pagar desde el portal. Contacta a recepción.</p> : <>
      <div className="membership-payment-instructions">{data!.settings.instructions}</div>
      <p className="form-note">Envía tu solicitud dentro de 7 días para conservar ese precio durante la revisión. La cobertura vigente se respeta; si venció, la nueva comienza al aprobarse. Los cambios de plan y recompensas se gestionan en recepción.</p>
      <form className="membership-payment-form" onSubmit={onSubmit}>
        <label>Plan<select required value={planId} disabled={Boolean(shownMembership)} onChange={(e) => setPlanId(e.target.value)}>{data!.plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {membershipMoney(p.price, p.currency)}</option>)}</select></label>
        <label>Valor pagado ({plan.currency})<input required type="number" step="0.01" min="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}/><small>Debe coincidir con {membershipMoney(plan.price, plan.currency)}.</small></label>
        <label>Fecha del pago<input required type="date" max={paymentToday} value={form.paidOn} onChange={(e) => setForm({ ...form, paidOn: e.target.value })}/></label>
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
    <PaymentHistorySection<MembershipPaymentRequest> queryKey={['my-payment-requests-history', gymId, memberId]} title="Mis solicitudes" label="tus solicitudes" empty="Todavía no has presentado solicitudes." options={requestStatuses}
      load={async (status, cursor, signal) => (await api.get<HistoryPage<MembershipPaymentRequest>>('/membership-payment-requests/me/history', { params: { status, cursor: cursor ?? undefined }, signal })).data}
      render={r => <article key={r.id}><div><strong>{r.plan_snapshot.name} · {membershipMoney(r.amount, r.currency)}</strong><small>{r.paid_on ?? r.created_at.slice(0, 10)} · {r.method ? methods[r.method] : ''}</small>{r.review_reason && <p>{r.review_reason}</p>}</div><div><span className={`badge ${r.status}`}>{statuses[r.status] ?? r.status}</span>{r.channel === 'fitlab' && <button className="small-button" disabled={proof.isPending} onClick={() => proof.mutate(r.id)}><FileText/>Comprobante</button>}</div></article>}/>
    {(['membership', 'other'] as const).map(kind => <PaymentHistorySection<PaymentHistoryRow> key={kind} queryKey={['my-payments-history', gymId, memberId, kind]}
      title={kind === 'membership' ? 'Historial de pagos' : 'Otros pagos registrados'} label={kind === 'membership' ? 'el historial de pagos' : 'otros pagos registrados'}
      empty={kind === 'membership' ? 'Todavía no hay pagos de membresía en este historial.' : 'Todavía no hay otros pagos registrados.'} options={paymentStatuses}
      load={async (status, cursor, signal) => {
        const { data: page } = await api.get<{ payments: PaymentHistoryRow[]; nextCursor: string | null }>('/member-payments/me', { params: { kind, status, cursor: cursor ?? undefined }, signal });
        return { items: page.payments, nextCursor: page.nextCursor };
      }}
      render={p => <article key={p.id}><div><strong>{membershipMoney(p.amount, p.currency)}</strong><small>{new Date(p.paid_at).toLocaleDateString('es-EC', { timeZone: data.gym.timezone })} · {methods[p.payment_method] ?? p.payment_method}</small></div><div><span className={`badge ${p.status}`}>{historyStatusLabel(p.status)}</span>{kind === 'membership' && p.receipt_verification_token && <Link className="small-button" to={`/receipt/verify/${p.receipt_verification_token}`}>Ver recibo {p.receipt_number}</Link>}</div></article>}/>)}
    <GymContactCard/>
  </div>;
}
