import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, LoaderCircle, Plus, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';

type Member = { id: string; profiles?: { full_name?: string } };
type Plan = { id: string; name: string; price: number; currency: string };
type Period = { id: string; starts_on: string; ends_on: string; status: string };
type Membership = { id: string; member_user_id: string; status: string; price_at_purchase: number; currency: string; plans?: { name?: string }; membership_periods?: Period[] };
type PaymentMethod = 'cash' | 'bank_transfer' | 'external_card' | 'external_deuna' | 'other';
type CheckoutForm = { memberUserId: string; planId: string; paymentMethod: PaymentMethod; externalReference: string; notes: string };
type PlanForm = { name: string; price: string; durationUnit: 'days' | 'weeks' | 'months'; durationValue: string; attendanceMode: 'daily' | 'weekly'; weeklyTarget: string };

const initialForm: CheckoutForm = { memberUserId: '', planId: '', paymentMethod: 'cash', externalReference: '', notes: '' };
const initialPlan: PlanForm = { name: '', price: '', durationUnit: 'months', durationValue: '1', attendanceMode: 'daily', weeklyTarget: '3' };

function errorMessage(error: unknown) {
  const apiError = error as { response?: { data?: { message?: string } } };
  return apiError.response?.data?.message ?? 'No se pudo registrar el pago. Revisa los datos e inténtalo nuevamente.';
}

export function MembershipsPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [form, setForm] = useState<CheckoutForm>(initialForm);
  const [planForm, setPlanForm] = useState<PlanForm>(initialPlan);
  const members = useQuery({ queryKey: ['members'], queryFn: async () => (await api.get<{ members: Member[] }>('/members')).data.members });
  const plans = useQuery({ queryKey: ['plans'], queryFn: async () => (await api.get<{ plans: Plan[] }>('/plans')).data.plans });
  const memberships = useQuery({ queryKey: ['memberships'], queryFn: async () => (await api.get<{ memberships: Membership[] }>('/memberships')).data.memberships });
  const memberNames = new Map((members.data ?? []).map((member) => [member.id, member.profiles?.full_name ?? 'Miembro sin nombre']));

  const checkout = useMutation({
    mutationFn: async () => api.post('/memberships/manual-checkout', {
      locationId: session?.gymUser?.default_location_id,
      memberUserId: form.memberUserId,
      planId: form.planId,
      paymentMethod: form.paymentMethod,
      externalReference: form.externalReference.trim() || null,
      notes: form.notes.trim() || null,
    }),
    onSuccess: async () => {
      setOpen(false);
      setForm(initialForm);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['memberships'] }),
        queryClient.invalidateQueries({ queryKey: ['payments'] }),
      ]);
    },
  });
  const createPlan = useMutation({
    mutationFn: async () => api.post('/plans', {
      name: planForm.name,
      price: Number(planForm.price),
      durationUnit: planForm.durationUnit,
      durationValue: Number(planForm.durationValue),
      attendanceMode: planForm.attendanceMode,
      weeklyTarget: planForm.attendanceMode === 'weekly' ? Number(planForm.weeklyTarget) : null,
      allowsExtraClasses: true,
    }),
    onSuccess: async () => {
      setPlanOpen(false);
      setPlanForm(initialPlan);
      await queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (form.memberUserId && form.planId && session?.gymUser?.default_location_id) checkout.mutate();
  };
  const loading = members.isLoading || plans.isLoading || memberships.isLoading;
  const canCheckout = Boolean(session?.gymUser?.default_location_id && members.data?.length && plans.data?.length);
  const checkoutBlocker = !session?.gymUser?.default_location_id ? 'Falta una sucursal predeterminada.' : !members.data?.length ? 'Primero debes tener al menos un miembro.' : !plans.data?.length ? 'Primero crea un plan activo.' : '';

  return <div className="page">
    <div className="page-heading"><div><p className="eyebrow">COBROS Y COBERTURA</p><h1>Membresías</h1><p>Registra pagos manuales y activa la cobertura de tus miembros.</p></div><div className="heading-actions"><button className="ghost" onClick={() => setPlanOpen(true)}><Plus size={18}/>Crear plan</button><button className="primary" onClick={() => canCheckout ? setOpen(true) : undefined} title={checkoutBlocker} disabled={!canCheckout}><Plus size={18}/>Registrar pago</button></div></div>
    {!session?.gymUser?.default_location_id && <div className="alert warning">Tu usuario no tiene una sucursal predeterminada. Asígnala antes de registrar cobros.</div>}
    {session?.gymUser?.default_location_id && !plans.isLoading && !plans.data?.length && <div className="alert warning">Aún no existen planes activos. Crea el primero para habilitar el registro de pagos.</div>}
    <section className="panel">
      <div className="panel-title"><div><h2>Membresías recientes</h2><p>Últimos periodos creados en este gimnasio.</p></div><span>{memberships.data?.length ?? 0} registros</span></div>
      {loading ? <div className="empty"><LoaderCircle className="spin"/><strong>Cargando membresías…</strong></div> : memberships.data?.length ? <div className="membership-list">{memberships.data.map((membership) => {
        const period = membership.membership_periods?.[0];
        return <article className="membership-row" key={membership.id}><span className="membership-icon"><CreditCard/></span><div><strong>{memberNames.get(membership.member_user_id) ?? 'Miembro'}</strong><small>{membership.plans?.name ?? 'Plan'} · {Number(membership.price_at_purchase).toFixed(2)} {membership.currency}</small></div><div className="period"><strong>{period ? `${period.starts_on} → ${period.ends_on}` : 'Sin periodo'}</strong><small>Cobertura</small></div><span className={`badge ${membership.status}`}>{membership.status}</span></article>;
      })}</div> : <div className="empty"><CreditCard/><strong>Aún no hay membresías</strong><span>Registra el primer pago para activar una cobertura.</span></div>}
    </section>

    {open && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title"><div className="modal-heading"><div><p className="eyebrow">NUEVO COBRO</p><h2 id="checkout-title">Registrar pago manual</h2></div><button className="icon-button" onClick={() => setOpen(false)} aria-label="Cerrar"><X/></button></div>
      <form className="checkout-form" onSubmit={submit}>
        <label>Miembro<select required value={form.memberUserId} onChange={(event) => setForm({ ...form, memberUserId: event.target.value })}><option value="">Selecciona un miembro</option>{members.data?.map((member) => <option key={member.id} value={member.id}>{member.profiles?.full_name ?? 'Sin nombre'}</option>)}</select></label>
        <label>Plan<select required value={form.planId} onChange={(event) => setForm({ ...form, planId: event.target.value })}><option value="">Selecciona un plan</option>{plans.data?.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} — {Number(plan.price).toFixed(2)} {plan.currency}</option>)}</select></label>
        <label>Método de pago<select value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value as PaymentMethod })}><option value="cash">Efectivo</option><option value="bank_transfer">Transferencia bancaria</option><option value="external_card">Tarjeta externa</option><option value="external_deuna">DEUNA externo</option><option value="other">Otro</option></select></label>
        <label>Referencia opcional<input value={form.externalReference} maxLength={200} onChange={(event) => setForm({ ...form, externalReference: event.target.value })} placeholder="Número de transferencia o comprobante"/></label>
        <label>Notas opcionales<textarea value={form.notes} maxLength={1000} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Observaciones del cobro"/></label>
        {checkout.isError && <div className="alert error">{errorMessage(checkout.error)}</div>}
        <div className="modal-actions"><button type="button" className="ghost" onClick={() => setOpen(false)}>Cancelar</button><button className="primary" disabled={checkout.isPending || !form.memberUserId || !form.planId}>{checkout.isPending ? <><LoaderCircle className="spin"/>Registrando…</> : 'Confirmar pago'}</button></div>
      </form>
    </section></div>}
    {planOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPlanOpen(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="plan-title"><div className="modal-heading"><div><p className="eyebrow">CONFIGURACIÓN</p><h2 id="plan-title">Crear plan</h2></div><button className="icon-button" onClick={() => setPlanOpen(false)} aria-label="Cerrar"><X/></button></div>
      <form className="checkout-form" onSubmit={(event) => { event.preventDefault(); createPlan.mutate(); }}>
        <label>Nombre<input required minLength={2} maxLength={120} value={planForm.name} onChange={(event) => setPlanForm({ ...planForm, name: event.target.value })} placeholder="Plan mensual"/></label>
        <label>Precio<input required type="number" min="0" step="0.01" value={planForm.price} onChange={(event) => setPlanForm({ ...planForm, price: event.target.value })} placeholder="30.00"/></label>
        <label>Duración<select value={planForm.durationUnit} onChange={(event) => setPlanForm({ ...planForm, durationUnit: event.target.value as PlanForm['durationUnit'] })}><option value="days">Días</option><option value="weeks">Semanas</option><option value="months">Meses</option></select></label>
        <label>Cantidad<input required type="number" min="1" max="120" value={planForm.durationValue} onChange={(event) => setPlanForm({ ...planForm, durationValue: event.target.value })}/></label>
        <label>Regla de asistencia<select value={planForm.attendanceMode} onChange={(event) => setPlanForm({ ...planForm, attendanceMode: event.target.value as PlanForm['attendanceMode'] })}><option value="daily">Días abiertos</option><option value="weekly">Meta semanal</option></select></label>
        {planForm.attendanceMode === 'weekly' && <label>Asistencias por semana<input required type="number" min="1" max="7" value={planForm.weeklyTarget} onChange={(event) => setPlanForm({ ...planForm, weeklyTarget: event.target.value })}/></label>}
        {createPlan.isError && <div className="alert error">{errorMessage(createPlan.error)}</div>}
        <div className="modal-actions"><button type="button" className="ghost" onClick={() => setPlanOpen(false)}>Cancelar</button><button className="primary" disabled={createPlan.isPending || planForm.name.trim().length < 2 || planForm.price === ''}>{createPlan.isPending ? <><LoaderCircle className="spin"/>Creando…</> : 'Crear plan'}</button></div>
      </form>
    </section></div>}
  </div>;
}
