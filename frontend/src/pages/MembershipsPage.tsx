import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, CreditCard, FileText, LoaderCircle, Plus, Printer, RotateCcw, WalletCards, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';

type Member = { id: string; status: string; account_mode: 'portal' | 'managed'; managed_full_name?: string | null; profiles?: { full_name?: string } | null };
type Plan = { id: string; name: string; price: number; currency: string };
type Period = { id: string; starts_on: string; ends_on: string; status: string; charged_amount: number; currency: string };
type Membership = { id: string; member_user_id: string; plan_id: string; status: string; price_at_purchase: number; currency: string; cancelled_at?: string | null; cancellation_reason?: string | null; plans?: { name?: string; price?: number; currency?: string }; membership_periods?: Period[] };
type Payment = { id: string; member_name: string; plan_name: string; amount: number; currency: string; payment_method: string; status: 'pending' | 'confirmed' | 'voided' | 'refunded' | 'failed'; paid_at: string; receipt_number: number; external_reference?: string | null; void_reason?: string | null; refund_reason?: string | null };
type Receipt = { number: number; issuedAt: string; status: Payment['status']; amount: number; currency: string; paymentMethod: string; externalReference?: string | null; notes?: string | null; voidReason?: string | null; refundReason?: string | null; gym: { name: string; legal_name?: string | null; email?: string | null; phone?: string | null }; location: { name: string; address?: string | null; city?: string | null; phone?: string | null }; member: { name: string; phone?: string | null }; plan: { name: string }; coverage?: { starts_on: string; ends_on: string } | null; registeredBy: { name: string } };
type PaymentMethod = 'cash' | 'bank_transfer' | 'external_card' | 'external_deuna' | 'other';
type CheckoutForm = { memberUserId: string; planId: string; membershipId: string; paymentMethod: PaymentMethod; externalReference: string; notes: string };
type PlanForm = { name: string; price: string; durationUnit: 'days' | 'weeks' | 'months'; durationValue: string; attendanceMode: 'daily' | 'weekly'; weeklyTarget: string };

const initialForm: CheckoutForm = { memberUserId: '', planId: '', membershipId: '', paymentMethod: 'cash', externalReference: '', notes: '' };
const initialPlan: PlanForm = { name: '', price: '', durationUnit: 'months', durationValue: '1', attendanceMode: 'daily', weeklyTarget: '3' };
const statusLabels: Record<string, string> = { pending: 'Pendiente', active: 'Activa', expired: 'Vencida', cancelled: 'Cancelada', paused: 'Pausada', confirmed: 'Confirmado', voided: 'Anulado', refunded: 'Reembolsado', failed: 'Fallido' };
const methodLabels: Record<string, string> = { cash: 'Efectivo', bank_transfer: 'Transferencia', external_card: 'Tarjeta externa', external_deuna: 'DEUNA externo', other: 'Otro' };
const memberName = (member: Member) => member.profiles?.full_name ?? member.managed_full_name ?? 'Miembro sin nombre';
const money = (amount: number, currency: string) => new Intl.NumberFormat('es-EC', { style: 'currency', currency }).format(Number(amount));
const dateTime = (value: string) => new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const receiptCode = (number: number) => `REC-${String(number).padStart(6, '0')}`;

export function MembershipsPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'memberships' | 'payments'>('memberships');
  const [open, setOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [form, setForm] = useState<CheckoutForm>(initialForm);
  const [planForm, setPlanForm] = useState<PlanForm>(initialPlan);
  const [cancelTarget, setCancelTarget] = useState<Membership | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [reverseTarget, setReverseTarget] = useState<{ payment: Payment; action: 'void' | 'refund' } | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<{ receipt_number: number; coverage_starts_on: string; coverage_ends_on: string } | null>(null);
  const role = session?.gymUser?.role;
  const hasPermission = (key: string) => role === 'owner' || Boolean(session?.gymUser?.staff_permissions?.some((permission) => permission.permission_key === key && permission.access_mode !== 'denied'));
  const canRegister = hasPermission('payments.register');
  const canViewFinances = hasPermission('finances.view');
  const canReverse = hasPermission('payments.void');
  const canManage = hasPermission('members.manage');

  const members = useQuery({ queryKey: ['members'], queryFn: async () => (await api.get<{ members: Member[] }>('/members')).data.members });
  const plans = useQuery({ queryKey: ['plans'], queryFn: async () => (await api.get<{ plans: Plan[] }>('/plans')).data.plans });
  const memberships = useQuery({ queryKey: ['memberships'], queryFn: async () => (await api.get<{ memberships: Membership[] }>('/memberships')).data.memberships });
  const payments = useQuery({ queryKey: ['payments'], enabled: canViewFinances, queryFn: async () => (await api.get<{ payments: Payment[] }>('/payments')).data.payments });
  const receipt = useQuery({ queryKey: ['payment-receipt', receiptId], enabled: Boolean(receiptId), queryFn: async () => (await api.get<{ receipt: Receipt }>(`/payments/${receiptId}/receipt`)).data.receipt });
  const memberNames = new Map((members.data ?? []).map((member) => [member.id, memberName(member)]));

  const checkout = useMutation({
    mutationFn: async () => (await api.post<{ checkout: typeof checkoutResult }>('/memberships/manual-checkout', {
      locationId: session?.gymUser?.default_location_id,
      memberUserId: form.memberUserId,
      planId: form.planId,
      membershipId: form.membershipId || null,
      paymentMethod: form.paymentMethod,
      externalReference: form.externalReference.trim() || null,
      notes: form.notes.trim() || null,
    })).data.checkout,
    onSuccess: async (result) => {
      setOpen(false); setForm(initialForm); setCheckoutResult(result);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['memberships'] }), queryClient.invalidateQueries({ queryKey: ['payments'] })]);
    },
  });
  const createPlan = useMutation({
    mutationFn: async () => api.post('/plans', { name: planForm.name, price: Number(planForm.price), durationUnit: planForm.durationUnit, durationValue: Number(planForm.durationValue), attendanceMode: planForm.attendanceMode, weeklyTarget: planForm.attendanceMode === 'weekly' ? Number(planForm.weeklyTarget) : null, allowsExtraClasses: true }),
    onSuccess: async () => { setPlanOpen(false); setPlanForm(initialPlan); await queryClient.invalidateQueries({ queryKey: ['plans'] }); },
  });
  const cancelMembership = useMutation({
    mutationFn: async () => api.patch(`/memberships/${cancelTarget?.id}/cancel`, { reason: cancelReason }),
    onSuccess: async () => { setCancelTarget(null); setCancelReason(''); await queryClient.invalidateQueries({ queryKey: ['memberships'] }); },
  });
  const reversePayment = useMutation({
    mutationFn: async () => api.patch(`/payments/${reverseTarget?.payment.id}/${reverseTarget?.action}`, { reason: reverseReason }),
    onSuccess: async () => { setReverseTarget(null); setReverseReason(''); await Promise.all([queryClient.invalidateQueries({ queryKey: ['payments'] }), queryClient.invalidateQueries({ queryKey: ['memberships'] })]); },
  });

  const selectMember = (memberUserId: string) => {
    const existing = (memberships.data ?? []).find((item) => item.member_user_id === memberUserId && item.status !== 'cancelled');
    setForm({ ...form, memberUserId, membershipId: existing?.id ?? '', planId: existing?.plan_id ?? '' });
  };
  const openRenewal = (membership: Membership) => {
    setForm({ ...initialForm, memberUserId: membership.member_user_id, membershipId: membership.id, planId: membership.plan_id }); setOpen(true);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); if (form.memberUserId && form.planId && session?.gymUser?.default_location_id) checkout.mutate(); };
  const loading = members.isLoading || plans.isLoading || memberships.isLoading;
  const activeMembers = (members.data ?? []).filter((member) => member.status === 'active');
  const canCheckout = Boolean(canRegister && session?.gymUser?.default_location_id && activeMembers.length && plans.data?.length);
  const checkoutBlocker = !session?.gymUser?.default_location_id ? 'Falta una sucursal predeterminada.' : !activeMembers.length ? 'Primero debes tener al menos un miembro activo.' : !plans.data?.length ? 'Primero crea un plan activo.' : '';
  const selectedMembership = form.membershipId ? memberships.data?.find((item) => item.id === form.membershipId) : undefined;

  return <div className="page membership-page">
    <div className="page-heading"><div><p className="eyebrow">COBROS Y COBERTURA</p><h1>Membresías</h1><p>Renueva coberturas, consulta recibos y conserva el historial financiero.</p></div><div className="heading-actions">{canManage && <button className="ghost" onClick={() => setPlanOpen(true)}><Plus size={18}/>Crear plan</button>}{canRegister && <button className="primary" onClick={() => canCheckout && setOpen(true)} title={checkoutBlocker} disabled={!canCheckout}><Plus size={18}/>Registrar pago</button>}</div></div>
    {checkoutResult && <div className="alert success receipt-success"><span>Pago registrado con recibo <strong>{receiptCode(checkoutResult.receipt_number)}</strong>. Cobertura: {checkoutResult.coverage_starts_on} al {checkoutResult.coverage_ends_on}.</span><button className="icon-button" onClick={() => setCheckoutResult(null)}><X/></button></div>}
    {!session?.gymUser?.default_location_id && canRegister && <div className="alert warning">Tu usuario no tiene una sucursal predeterminada. Asígnala antes de registrar cobros.</div>}
    <section className="panel financial-panel">
      <div className={`directory-tabs ${canViewFinances ? '' : 'single-tab'}`}><button className={tab === 'memberships' ? 'active' : ''} onClick={() => setTab('memberships')}><WalletCards/>Coberturas <span>{memberships.data?.length ?? 0}</span></button>{canViewFinances && <button className={tab === 'payments' ? 'active' : ''} onClick={() => setTab('payments')}><FileText/>Pagos y recibos <span>{payments.data?.length ?? 0}</span></button>}</div>
      {tab === 'memberships' && (loading ? <Loading text="Cargando membresías…"/> : memberships.data?.length ? <div className="membership-list">{memberships.data.map((membership) => {
        const period = [...(membership.membership_periods ?? [])].sort((a, b) => b.ends_on.localeCompare(a.ends_on))[0];
        const currentPrice = Number(membership.plans?.price ?? membership.price_at_purchase);
        return <article className="membership-row" key={membership.id}><span className="membership-icon"><CreditCard/></span><div><strong>{memberNames.get(membership.member_user_id) ?? 'Miembro'}</strong><small>{membership.plans?.name ?? 'Plan'} · próxima renovación {money(currentPrice, membership.plans?.currency ?? membership.currency)}</small>{membership.cancellation_reason && <small>Motivo: {membership.cancellation_reason}</small>}</div><div className="period"><strong>{period ? `${period.starts_on} → ${period.ends_on}` : 'Sin periodo'}</strong><small>Última cobertura</small></div><span className={`badge ${membership.status}`}>{statusLabels[membership.status] ?? membership.status}</span><div className="row-actions">{canRegister && membership.status !== 'cancelled' && <button className="small-button" onClick={() => openRenewal(membership)}><RotateCcw/>Renovar</button>}{canManage && membership.status !== 'cancelled' && <button className="small-button danger-text" onClick={() => setCancelTarget(membership)}><Ban/>Cancelar</button>}</div></article>;
      })}</div> : <Empty icon={<CreditCard/>} title="Aún no hay membresías" text="Registra el primer pago para activar una cobertura."/>)}
      {tab === 'payments' && canViewFinances && (payments.isLoading ? <Loading text="Cargando historial…"/> : payments.data?.length ? <div className="payment-list">{payments.data.map((payment) => <article className="payment-row" key={payment.id}><div><strong>{receiptCode(payment.receipt_number)}</strong><small>{dateTime(payment.paid_at)} · {methodLabels[payment.payment_method] ?? payment.payment_method}</small></div><div><strong>{payment.member_name}</strong><small>{payment.plan_name}</small></div><strong>{money(payment.amount, payment.currency)}</strong><span className={`badge ${payment.status}`}>{statusLabels[payment.status]}</span><div className="row-actions"><button className="small-button" onClick={() => setReceiptId(payment.id)}><FileText/>Recibo</button>{canReverse && payment.status === 'confirmed' && <><button className="small-button danger-text" onClick={() => setReverseTarget({ payment, action: 'void' })}>Anular</button><button className="small-button warning-text" onClick={() => setReverseTarget({ payment, action: 'refund' })}>Reembolsar</button></>}</div></article>)}</div> : <Empty icon={<FileText/>} title="No hay pagos" text="Los recibos aparecerán aquí después del primer cobro."/>)}
    </section>

    {open && <Modal close={() => setOpen(false)} eyebrow={selectedMembership ? 'RENOVACIÓN' : 'NUEVO CONTRATO'} title={selectedMembership ? 'Renovar membresía' : 'Registrar pago manual'}><form className="checkout-form" onSubmit={submit}>
      <label>Miembro<select required value={form.memberUserId} onChange={(event) => selectMember(event.target.value)}><option value="">Selecciona un miembro</option>{activeMembers.map((member) => <option key={member.id} value={member.id}>{memberName(member)}{member.account_mode === 'managed' ? ' · Sin cuenta' : ''}</option>)}</select></label>
      <label>Plan<select required value={form.planId} disabled={Boolean(selectedMembership)} onChange={(event) => setForm({ ...form, planId: event.target.value })}><option value="">Selecciona un plan</option>{plans.data?.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} — {money(plan.price, plan.currency)}</option>)}</select></label>
      {selectedMembership && <div className="form-note renewal-note">Se añadirá un nuevo período después de la cobertura existente. Se cobrará el precio vigente del plan y el contrato conservará todo su historial.</div>}
      <label>Método de pago<select value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value as PaymentMethod })}><option value="cash">Efectivo</option><option value="bank_transfer">Transferencia bancaria</option><option value="external_card">Tarjeta externa</option><option value="external_deuna">DEUNA externo</option><option value="other">Otro</option></select></label>
      <label>Referencia {form.paymentMethod === 'cash' || form.paymentMethod === 'other' ? 'opcional' : 'obligatoria'}<input required={!['cash', 'other'].includes(form.paymentMethod)} value={form.externalReference} maxLength={200} onChange={(event) => setForm({ ...form, externalReference: event.target.value })} placeholder="Número de transferencia o comprobante"/></label>
      <label className="wide">Notas opcionales<textarea value={form.notes} maxLength={1000} onChange={(event) => setForm({ ...form, notes: event.target.value })}/></label>
      {checkout.isError && <div className="alert error">{apiErrorMessage(checkout.error)}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={() => setOpen(false)}>Cancelar</button><button className="primary" disabled={checkout.isPending || !form.memberUserId || !form.planId}>{checkout.isPending ? <><LoaderCircle className="spin"/>Registrando…</> : selectedMembership ? 'Confirmar renovación' : 'Confirmar pago'}</button></div>
    </form></Modal>}
    {planOpen && <Modal close={() => setPlanOpen(false)} eyebrow="CONFIGURACIÓN" title="Crear plan"><form className="checkout-form" onSubmit={(event) => { event.preventDefault(); createPlan.mutate(); }}><label>Nombre<input required minLength={2} maxLength={120} value={planForm.name} onChange={(event) => setPlanForm({ ...planForm, name: event.target.value })}/></label><label>Precio<input required type="number" min="0" step="0.01" value={planForm.price} onChange={(event) => setPlanForm({ ...planForm, price: event.target.value })}/></label><label>Duración<select value={planForm.durationUnit} onChange={(event) => setPlanForm({ ...planForm, durationUnit: event.target.value as PlanForm['durationUnit'] })}><option value="days">Días</option><option value="weeks">Semanas</option><option value="months">Meses</option></select></label><label>Cantidad<input required type="number" min="1" max="120" value={planForm.durationValue} onChange={(event) => setPlanForm({ ...planForm, durationValue: event.target.value })}/></label><label>Regla de asistencia<select value={planForm.attendanceMode} onChange={(event) => setPlanForm({ ...planForm, attendanceMode: event.target.value as PlanForm['attendanceMode'] })}><option value="daily">Días abiertos</option><option value="weekly">Meta semanal</option></select></label>{planForm.attendanceMode === 'weekly' && <label>Asistencias por semana<input required type="number" min="1" max="7" value={planForm.weeklyTarget} onChange={(event) => setPlanForm({ ...planForm, weeklyTarget: event.target.value })}/></label>}{createPlan.isError && <div className="alert error">{apiErrorMessage(createPlan.error)}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={() => setPlanOpen(false)}>Cancelar</button><button className="primary" disabled={createPlan.isPending}>{createPlan.isPending ? 'Creando…' : 'Crear plan'}</button></div></form></Modal>}
    {cancelTarget && <Modal close={() => setCancelTarget(null)} eyebrow="CANCELACIÓN CONTRACTUAL" title="Cancelar membresía"><div className="danger-note"><AlertTriangle/><p>Se cancelará la cobertura actual y futura, pero <strong>ningún pago será anulado ni reembolsado</strong>. El historial permanecerá intacto.</p></div><label className="standalone-label">Motivo<textarea value={cancelReason} minLength={3} maxLength={500} onChange={(event) => setCancelReason(event.target.value)}/></label>{cancelMembership.isError && <div className="alert error">{apiErrorMessage(cancelMembership.error)}</div>}<div className="modal-actions"><button className="ghost" onClick={() => setCancelTarget(null)}>Volver</button><button className="danger-button" disabled={cancelMembership.isPending || cancelReason.trim().length < 3} onClick={() => cancelMembership.mutate()}>{cancelMembership.isPending ? 'Cancelando…' : 'Cancelar membresía'}</button></div></Modal>}
    {reverseTarget && <Modal close={() => setReverseTarget(null)} eyebrow={reverseTarget.action === 'void' ? 'CORRECCIÓN DE PAGO' : 'DEVOLUCIÓN DE DINERO'} title={reverseTarget.action === 'void' ? 'Anular pago' : 'Registrar reembolso'}><div className={reverseTarget.action === 'void' ? 'danger-note' : 'security-note'}><AlertTriangle/><p>{reverseTarget.action === 'void' ? 'Úsalo si el cobro fue registrado por error. Se anulará su cobertura asociada.' : 'Confirma que el dinero ya fue devuelto por el medio externo correspondiente. FitLab registrará la devolución y cancelará esa cobertura.'}</p></div><label className="standalone-label">Motivo<textarea value={reverseReason} minLength={3} maxLength={500} onChange={(event) => setReverseReason(event.target.value)}/></label>{reversePayment.isError && <div className="alert error">{apiErrorMessage(reversePayment.error)}</div>}<div className="modal-actions"><button className="ghost" onClick={() => setReverseTarget(null)}>Volver</button><button className={reverseTarget.action === 'void' ? 'danger-button' : 'primary'} disabled={reversePayment.isPending || reverseReason.trim().length < 3} onClick={() => reversePayment.mutate()}>{reversePayment.isPending ? 'Procesando…' : reverseTarget.action === 'void' ? 'Confirmar anulación' : 'Confirmar reembolso'}</button></div></Modal>}
    {receiptId && <Modal close={() => setReceiptId(null)} eyebrow="COMPROBANTE INTERNO" title={receipt.data ? receiptCode(receipt.data.number) : 'Recibo'} wide>{receipt.isLoading ? <Loading text="Preparando recibo…"/> : receipt.isError ? <div className="alert error">{apiErrorMessage(receipt.error)}</div> : receipt.data && <ReceiptView receipt={receipt.data}/>}</Modal>}
  </div>;
}

function Modal({ close, eyebrow, title, wide, children }: { close: () => void; eyebrow: string; title: string; wide?: boolean; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className={`modal ${wide ? 'receipt-modal' : ''}`} role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><button className="icon-button" onClick={close} aria-label="Cerrar"><X/></button></div>{children}</section></div>;
}
function Loading({ text }: { text: string }) { return <div className="empty"><LoaderCircle className="spin"/><strong>{text}</strong></div>; }
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="empty">{icon}<strong>{title}</strong><span>{text}</span></div>; }
function ReceiptView({ receipt }: { receipt: Receipt }) {
  return <><article className="receipt-sheet"><header><div><strong>{receipt.gym.legal_name || receipt.gym.name}</strong><span>{receipt.location.name} · {[receipt.location.address, receipt.location.city].filter(Boolean).join(', ')}</span></div><div><b>{receiptCode(receipt.number)}</b><span>{dateTime(receipt.issuedAt)}</span><span className={`badge ${receipt.status}`}>{statusLabels[receipt.status]}</span></div></header><section className="receipt-party"><div><small>RECIBIDO DE</small><strong>{receipt.member.name}</strong><span>{receipt.member.phone || 'Sin teléfono'}</span></div><div><small>REGISTRADO POR</small><strong>{receipt.registeredBy.name}</strong><span>{methodLabels[receipt.paymentMethod] ?? receipt.paymentMethod}</span></div></section><section className="receipt-line"><div><strong>{receipt.plan.name}</strong><span>{receipt.coverage ? `Cobertura ${receipt.coverage.starts_on} al ${receipt.coverage.ends_on}` : 'Sin período asociado'}</span></div><strong>{money(receipt.amount, receipt.currency)}</strong></section>{receipt.externalReference && <p><small>Referencia:</small> {receipt.externalReference}</p>}{receipt.notes && <p><small>Notas:</small> {receipt.notes}</p>}{(receipt.voidReason || receipt.refundReason) && <div className="receipt-reversal"><strong>{receipt.status === 'voided' ? 'PAGO ANULADO' : 'PAGO REEMBOLSADO'}</strong><span>{receipt.voidReason || receipt.refundReason}</span></div>}<footer>Comprobante interno de FitLab. No reemplaza una factura o comprobante tributario.</footer></article><div className="modal-actions receipt-actions"><button className="primary" onClick={() => window.print()}><Printer/>Imprimir recibo</button></div></>;
}
