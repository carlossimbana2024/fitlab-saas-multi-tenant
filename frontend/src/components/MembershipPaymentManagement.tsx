import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, FileText, LoaderCircle, Save, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiErrorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { membershipMoney, membershipPaymentMethodLabels as methods, membershipPaymentStatusLabels as statuses, type MembershipPaymentRequest } from '../utils/membershipPayments';
import '../membership-payments.css';

export function MembershipPaymentSettings({ locations }: { locations: Array<{ id: string; name: string; is_active: boolean }> }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['membership-payment-settings'], queryFn: async () => (await api.get<{ settings: Array<{ location_id: string; enabled: boolean; instructions: string; methods: string[] }> }>('/membership-payment-requests/settings')).data.settings });
  const [locationId, setLocationId] = useState('');
  const [form, setForm] = useState({ enabled: false, instructions: '', methods: ['bank_transfer'] });
  useEffect(() => { if (!locationId) setLocationId(locations.find((l) => l.is_active)?.id ?? ''); }, [locations, locationId]);
  useEffect(() => { const settings = query.data?.find((s) => s.location_id === locationId); setForm(settings ? { enabled: settings.enabled, instructions: settings.instructions, methods: settings.methods } : { enabled: false, instructions: '', methods: ['bank_transfer'] }); }, [query.data, locationId]);
  const save = useMutation({ mutationFn: async () => api.put(`/membership-payment-requests/settings/${locationId}`, form), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['membership-payment-settings'] }); } });
  return <form className="panel settings-form membership-payment-settings" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}><div className="panel-title"><div><h2>Pagos de membresías desde el portal</h2><p>Configura los datos de cobro de cada sucursal.</p></div><ClipboardCheck/></div>
    <label>Sucursal<select value={locationId} onChange={(e) => { save.reset(); setLocationId(e.target.value); }}>{locations.filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
    <label className="method-checkbox"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })}/>Habilitar solicitudes desde el portal</label>
    <label>Datos e instrucciones de pago<textarea required={form.enabled} minLength={form.enabled ? 3 : undefined} maxLength={2000} rows={5} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Banco, titular, número y tipo de cuenta. Indica cómo realizar el pago y cuánto tarda la revisión."/></label>
    <span>Métodos disponibles</span>{['bank_transfer', 'deposit', 'other'].map((method) => <label key={method} className="method-checkbox"><input type="checkbox" checked={form.methods.includes(method)} onChange={(e) => setForm({ ...form, methods: e.target.checked ? [...form.methods, method] : form.methods.filter((m) => m !== method) })}/>{methods[method]}</label>)}
    <p className="form-note">El botón de WhatsApp usará el número de la sucursal o, como respaldo, el WhatsApp general del gimnasio. Verifica siempre el ingreso bancario antes de aprobar una solicitud.</p>
    {query.isPending && <p>Cargando configuración…</p>}{(query.isError || save.isError) && <p className="alert error">{apiErrorMessage(query.error ?? save.error)}</p>}{save.isSuccess && <p className="alert success">Configuración guardada.</p>}
    <button className="primary" disabled={!locationId || !form.methods.length || query.isPending || query.isError || save.isPending}><Save/>Guardar pagos de la sucursal</button>
  </form>;
}

export function MembershipPaymentQueueLink() {
  const { session } = useAuth();
  const enabled = session?.gymUser?.role === 'owner' || Boolean(session?.gymUser?.staff_permissions?.some((p) => p.permission_key === 'payments.register' && p.access_mode === 'allowed'));
  const query = useQuery({ queryKey: ['membership-payment-queue-count'], queryFn: async () => (await api.get<{ total: number }>('/membership-payment-requests')).data, enabled, refetchInterval: 60_000 });
  if (!enabled) return null;
  return <div className="panel membership-payment-review"><Link className="small-button" to="/memberships#payment-requests"><ClipboardCheck/>Pagos por verificar{query.data ? ` · ${query.data.total}` : ''}</Link>{query.isError && <small>No se pudo actualizar el contador.</small>}</div>;
}

export function MembershipPaymentReview() {
  const client = useQueryClient();
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<MembershipPaymentRequest | null>(null);
  const [decision, setDecision] = useState<'approved' | 'rejected' | 'revision_requested'>('approved');
  const [reason, setReason] = useState('');
  const [verified, setVerified] = useState(false);
  const [proofUrl, setProofUrl] = useState('');
  const query = useQuery({ queryKey: ['membership-payment-queue', status, page], queryFn: async () => (await api.get<{ requests: MembershipPaymentRequest[]; total: number }>('/membership-payment-requests', { params: { status, page } })).data, refetchInterval: 30_000 });
  const proof = useMutation({ mutationFn: async (id: string) => (await api.get<{ url: string }>(`/membership-payment-requests/${id}/proof`)).data.url, onSuccess: setProofUrl });
  const review = useMutation({ mutationFn: async () => api.post(`/membership-payment-requests/${selected!.id}/review`, { decision, reason, bankVerified: verified }), onSuccess: async () => { setSelected(null); setProofUrl(''); await Promise.all(['membership-payment-queue', 'membership-payment-queue-count', 'payments', 'memberships', 'dashboard-income-summary', 'my-membership-payments'].map((key) => client.invalidateQueries({ queryKey: [key] }))); }, onError: async () => { await client.invalidateQueries({ queryKey: ['membership-payment-queue'] }); } });
  return <section className="panel membership-payment-review" id="payment-requests"><div className="panel-title"><div><h2>Pagos por verificar</h2><p>{query.data?.total ?? '…'} solicitudes · La aprobación registra el pago y la cobertura.</p></div><ClipboardCheck/></div>
    <label>Mostrar<select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(0); }}><option value="pending">Pendientes</option><option value="all">Historial de solicitudes</option></select></label>
    {query.isPending && <p>Cargando solicitudes…</p>}{query.isError && <p className="alert error">{apiErrorMessage(query.error)} <button onClick={() => void query.refetch()}>Reintentar</button></p>}
    <div className="portal-history">{query.data?.requests.map((r) => <article key={r.id}><div><strong>{r.member_name} · {membershipMoney(r.amount, r.currency)}</strong><small>{r.plan_snapshot.name} · {r.paid_on} · {r.method ? methods[r.method] : ''}</small><small>{r.channel === 'whatsapp' ? 'Comprobante enviado por WhatsApp' : 'Comprobante adjunto en FitLab'}</small>{r.reference && <small>Referencia: {r.reference}</small>}{r.comment && <p>{r.comment}</p>}{r.review_reason && <p>{r.review_reason}</p>}</div><div className="row-actions"><span className={`badge ${r.status}`}>{statuses[r.status]}</span>{r.channel === 'fitlab' && <button className="small-button" disabled={proof.isPending} onClick={() => { setProofUrl(''); proof.mutate(r.id); }}><FileText/>Comprobante</button>}{r.status === 'pending' && <button className="small-button" onClick={() => { review.reset(); setSelected(r); setReason(''); setVerified(false); setDecision('approved'); }}><CheckCircle2/>Revisar</button>}</div></article>)}</div>
    {query.data?.requests.length === 0 && <p>No hay solicitudes en esta vista.</p>}
    {(page > 0 || (query.data?.total ?? 0) > 25) && <div className="row-actions"><button className="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button><span>Página {page + 1}</span><button className="ghost" disabled={(page + 1) * 25 >= (query.data?.total ?? 0)} onClick={() => setPage(page + 1)}>Siguiente</button></div>}
    {proof.isError && <p className="alert error">{apiErrorMessage(proof.error)}</p>}{proofUrl && <a className="small-button" href={proofUrl} target="_blank" rel="noreferrer">Abrir y ampliar comprobante · enlace válido por 1 minuto</a>}
    {selected && <form className="review-form" onSubmit={(e) => { e.preventDefault(); review.mutate(); }}><div className="panel-title"><h3>Revisar pago de {selected.member_name}</h3><button type="button" className="icon-button" disabled={review.isPending} onClick={() => setSelected(null)} aria-label="Cerrar revisión"><X/></button></div><p>{membershipMoney(selected.amount, selected.currency)} · {selected.plan_snapshot.name}</p><label>Decisión<select value={decision} disabled={review.isPending} onChange={(e) => { setDecision(e.target.value as typeof decision); setVerified(false); }}><option value="approved">Aprobar</option><option value="revision_requested">Solicitar corrección</option><option value="rejected">Rechazar</option></select></label>{decision === 'approved' && <label className="verification-check"><input required type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)}/>Confirmé el ingreso real y comprobé que no se haya registrado antes este mismo pago.</label>}<label>{decision === 'approved' ? 'Mensaje para el miembro' : 'Motivo y pasos que debe seguir'}<textarea required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={decision === 'approved' ? 'Pago verificado. Tu membresía ha sido renovada.' : 'Explica qué debe corregir el miembro.'}/></label>{review.isError && <p className="alert error">{apiErrorMessage(review.error)}</p>}<button className="primary" disabled={review.isPending || reason.trim().length < 3 || (decision === 'approved' && !verified)}>{review.isPending ? <LoaderCircle className="spin"/> : <CheckCircle2/>}Confirmar decisión</button></form>}
  </section>;
}
