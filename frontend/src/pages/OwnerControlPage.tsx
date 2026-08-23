import { useQuery } from '@tanstack/react-query';
import {
  Activity, Archive, Ban, CalendarClock, CalendarX2, ChevronLeft, ChevronRight,
  CircleDollarSign, Clock3, KeyRound, LoaderCircle, MapPin, RotateCcw,
  ShieldAlert, ShieldCheck, TrendingDown, TrendingUp, UserRoundSearch, UserX,
  Users, WalletCards,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, apiErrorMessage } from '../services/api';

type ReportView = 'week' | 'month' | 'quarter' | 'year' | 'custom';
type ReportFilters = { from: string; to: string; locationId: string; view: ReportView };
type MoneySummary = { count: number; byCurrency: Array<{ currency: string; amount: number }> };
type IncomeSeries = {
  currency: string;
  points: Array<{ key: string; label: string; confirmed: number; refunded: number; net: number }>;
  currentNet: number;
  previousNet: number;
  changePercentage: number | null;
};
type OwnerReport = {
  range: { from: string; to: string; view: ReportView; previousFrom: string; previousTo: string };
  selectedLocationId: string | null;
  locations: Array<{ id: string; name: string; isMain: boolean }>;
  financial: {
    confirmed: MoneySummary; voided: MoneySummary; refunded: MoneySummary; outstanding: MoneySummary;
    evolution: IncomeSeries[];
  };
  members: { active: number; suspended: number; retired: number; expired: number };
  attendance: {
    total: number;
    daily: Array<{ date: string; count: number }>;
    byLocation: Array<{ locationId: string; locationName: string; count: number }>;
    heatmap: Array<{ hour: number; label: string; counts: number[]; total: number }>;
  };
  retention: {
    renewalBuckets: Array<{ key: string; label: string; count: number }>;
    atRiskCount: number;
    atRiskMembers: Array<{
      memberUserId: string; name: string; lastAttendanceDate: string | null;
      daysWithoutAttendance: number | null; endsOn: string;
    }>;
    riskRuleDays: number;
  };
  locationComparison: Array<{
    locationId: string; locationName: string; isMain: boolean; revenue: MoneySummary;
    attendances: number; activeMembers: number;
  }>;
  staffActivity: {
    people: Array<{ staffUserId: string; name: string; actions: number; pinActions: number; sensitiveActions: number }>;
    alerts: { failedPinAttempts: number; blockedPinAttempts: number; reversals: number; attendanceVoids: number };
  };
};

type PermissionMode = 'allowed' | 'requires_pin' | 'denied';
type AuditItem = {
  id: number; actorName: string; actorRole: string;
  action: string; entityType: string; entityName: string | null; entityRole: string | null;
  usedPinElevation: boolean;
  permissionChanges: Array<{ key: string; name: string; before: PermissionMode; after: PermissionMode }>;
  permissionSnapshot: Array<{ key: string; name: string; mode: PermissionMode }>;
  changes: Array<{ label: string; before: string; after: string }>;
  details: Array<{ label: string; value: string }>;
  createdAt: string;
};
type AuditResponse = {
  items: AuditItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

const ACTION_LABELS: Record<string, string> = {
  'staff.permissions_updated': 'Actualizó los permisos de un empleado',
  'staff.status_updated': 'Cambió el estado de un empleado',
  'staff.invitation_created': 'Invitó a un empleado',
  'staff.invitation_accepted': 'Aceptó una invitación de empleado',
  'staff.invitation_revoked': 'Revocó una invitación de empleado',
  'staff.removed': 'Retiró el acceso de un empleado',
  'staff.reinstated': 'Reincorporó a un empleado',
  'member.managed_created': 'Registró un miembro sin cuenta',
  'member.invitation_created': 'Invitó a un miembro al portal',
  'member.invitation_accepted': 'Aceptó una invitación de miembro',
  'member.invitation_revoked': 'Revocó una invitación de miembro',
  'member.details_updated': 'Actualizó los datos de un miembro',
  'member.suspended': 'Suspendió a un miembro',
  'member.reactivated': 'Reactivó a un miembro',
  'member.retired': 'Retiró a un miembro',
  'member.reinstated': 'Reincorporó a un miembro',
  'member.converted_to_portal': 'Concedió acceso al portal a un miembro',
  'membership.created_with_payment': 'Creó una membresía y registró su pago',
  'membership.renewed': 'Renovó una membresía',
  'membership.cancelled': 'Canceló una membresía',
  'payment.voided': 'Anuló un pago',
  'payment.refunded': 'Registró un reembolso',
  'attendance.registered_by_staff': 'Registró una asistencia manual',
  'attendance.voided': 'Anuló una asistencia',
  'calendar.schedule_updated': 'Actualizó el horario semanal',
  'calendar.exception_saved': 'Registró una excepción de horario',
  'settings.gym_updated': 'Actualizó los datos del gimnasio',
  'settings.location_updated': 'Actualizó los datos de una sucursal',
  'settings.receipt_branding_updated': 'Actualizó la marca de los recibos',
  'admin_pin.updated': 'Actualizó el PIN administrativo',
  'admin_pin.elevation_created': 'Autorizó una acción mediante PIN',
  'admin_pin.attempt_failed': 'Ingresó un PIN incorrecto',
  'admin_pin.attempt_blocked': 'Bloqueó temporalmente los intentos de PIN',
  'plan.created': 'Creó un plan de membresía',
};
const ENTITY_LABELS: Record<string, string> = {
  gym_user: 'Usuario del gimnasio', member: 'Miembro', membership: 'Membresía',
  member_payment: 'Pago', payment: 'Pago', attendance: 'Asistencia', gym: 'Gimnasio',
  gym_location: 'Sucursal', gym_invitation: 'Invitación', staff_invitation: 'Invitación de empleado', plan: 'Plan',
  gym_security: 'Seguridad', admin_elevation_session: 'Autorización por PIN', calendar_exception: 'Excepción de horario',
};
const ROLE_LABELS: Record<string, string> = { owner: 'Owner', staff: 'Empleado', member: 'Miembro', system: 'Sistema' };
const MODE_LABELS: Record<PermissionMode, string> = { allowed: 'Permitido', requires_pin: 'Requiere PIN', denied: 'Denegado' };
const PERIOD_LABELS: Array<{ value: Exclude<ReportView, 'custom'>; label: string }> = [
  { value: 'week', label: 'Semana' }, { value: 'month', label: 'Mes' },
  { value: 'quarter', label: 'Trimestre' }, { value: 'year', label: 'Año' },
];

function todayInGuayaquil() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function dateString(date: Date) { return date.toISOString().slice(0, 10); }

function presetRange(view: Exclude<ReportView, 'custom'>) {
  const today = todayInGuayaquil();
  const current = new Date(`${today}T00:00:00Z`);
  const start = new Date(current);
  if (view === 'week') start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  if (view === 'month') start.setUTCDate(1);
  if (view === 'quarter') start.setUTCMonth(Math.floor(start.getUTCMonth() / 3) * 3, 1);
  if (view === 'year') start.setUTCMonth(0, 1);
  return { from: dateString(start), to: today, locationId: '', view };
}

function moneyLabel(summary: MoneySummary) {
  if (!summary.byCurrency.length) return '0.00 USD';
  return summary.byCurrency.map(({ amount, currency }) => `${Number(amount).toFixed(2)} ${currency}`).join(' · ');
}

function readableAction(action: string) { return ACTION_LABELS[action] ?? 'Realizó una acción registrada'; }

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`));
}

function IncomeEvolution({ series }: { series: IncomeSeries[] }) {
  if (!series.length) return <div className="chart-empty"><CircleDollarSign/><strong>Aún no hay movimientos en este período</strong><span>Los próximos cobros aparecerán aquí automáticamente.</span></div>;
  return <div className="income-series-list">{series.map((currencySeries) => {
    const maximum = Math.max(1, ...currencySeries.points.flatMap((point) => [point.confirmed, point.refunded]));
    const trend = currencySeries.changePercentage;
    return <article className="income-series" key={currencySeries.currency}>
      <header><div><span>Ingreso neto</span><strong>{currencySeries.currentNet.toFixed(2)} {currencySeries.currency}</strong></div><div className={`trend ${trend != null && trend < 0 ? 'negative' : 'positive'}`}>{trend == null ? <span>Sin período anterior comparable</span> : trend < 0 ? <><TrendingDown/><span>{Math.abs(trend)} % frente al período anterior</span></> : <><TrendingUp/><span>{trend} % frente al período anterior</span></>}</div></header>
      <div className="chart-legend"><span><i className="confirmed"/>Ingresos confirmados</span><span><i className="refunded"/>Reembolsos</span></div>
      <div className="income-bars" role="img" aria-label={`Evolución de ingresos en ${currencySeries.currency}`}>
        {currencySeries.points.map((point) => <div className="income-bar-group" key={point.key} title={`${point.label}: ${point.confirmed.toFixed(2)} confirmados, ${point.refunded.toFixed(2)} reembolsados`}>
          <div className="income-bar-values"><small>{point.confirmed ? point.confirmed.toFixed(0) : ''}</small><small>{point.refunded ? point.refunded.toFixed(0) : ''}</small></div>
          <div className="income-bar-columns"><i className="confirmed" style={{ height: `${Math.max(point.confirmed ? 5 : 0, point.confirmed / maximum * 100)}%` }}/><i className="refunded" style={{ height: `${Math.max(point.refunded ? 5 : 0, point.refunded / maximum * 100)}%` }}/></div>
          <span>{point.label}</span>
        </div>)}
      </div>
    </article>;
  })}</div>;
}

function AttendanceHeatmap({ rows }: { rows: OwnerReport['attendance']['heatmap'] }) {
  const weekdays = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const maximum = Math.max(0, ...rows.flatMap((row) => row.counts));
  const peak = rows.flatMap((row) => row.counts.map((count, weekday) => ({ count, weekday, hour: row.label })))
    .sort((left, right) => right.count - left.count)[0];
  return <>
    <div className="heatmap-summary"><Clock3/><span>{peak?.count ? <>Mayor concurrencia: <strong>{weekdays[peak.weekday]} a las {peak.hour}</strong> · {peak.count} asistencias</> : <>Aún no hay asistencias en este período.</>}</span></div>
    <div className="attendance-heatmap" role="table" aria-label="Asistencias por día y hora">
      <span className="heatmap-corner">Hora</span>{weekdays.map((day) => <strong key={day}>{day}</strong>)}
      {rows.map((row) => <div className="heatmap-row" key={row.hour}>
        <strong>{row.label}</strong>{row.counts.map((count, weekday) => {
          const intensity = maximum ? 0.08 + (count / maximum) * 0.82 : 0.04;
          return <span className={count > maximum * .55 ? 'hot' : ''} style={{ backgroundColor: `rgba(225, 6, 0, ${intensity})` }} title={`${weekdays[weekday]} ${row.label}: ${count} asistencias`} key={weekday}>{count}</span>;
        })}
      </div>)}
    </div>
    <div className="heatmap-legend"><span>Menor concurrencia</span><i/><i/><i/><i/><span>Mayor concurrencia</span></div>
  </>;
}

function RetentionPanel({ data }: { data: OwnerReport['retention'] }) {
  const maximum = Math.max(1, ...data.renewalBuckets.map((bucket) => bucket.count), data.atRiskCount);
  return <div className="retention-layout">
    <div className="renewal-chart"><h3>Vencimientos próximos</h3><p>Miembros que conviene contactar para renovar.</p>{data.renewalBuckets.map((bucket) => <div className="horizontal-metric" key={bucket.key}><span>{bucket.label}</span><div><i style={{ width: `${bucket.count / maximum * 100}%` }}/></div><strong>{bucket.count}</strong></div>)}</div>
    <div className="risk-members"><header><div><h3>Miembros en riesgo</h3><p>Con cobertura, pero sin asistir durante {data.riskRuleDays} días o más.</p></div><strong>{data.atRiskCount}</strong></header>
      {data.atRiskMembers.length ? <div className="risk-list">{data.atRiskMembers.map((member) => <article key={member.memberUserId}><UserRoundSearch/><span><strong>{member.name}</strong><small>{member.lastAttendanceDate ? `Última asistencia: ${formatDate(member.lastAttendanceDate)}` : 'Sin asistencias recientes'} · vence {formatDate(member.endsOn)}</small></span></article>)}</div> : <div className="mini-empty"><ShieldCheck/>No hay miembros en riesgo con esta regla.</div>}
    </div>
  </div>;
}

function LocationComparison({ locations }: { locations: OwnerReport['locationComparison'] }) {
  const maxAttendance = Math.max(1, ...locations.map((location) => location.attendances));
  return <div className="location-comparison">{locations.length ? locations.map((location) => <article key={location.locationId}>
    <header><span><MapPin/><strong>{location.locationName}</strong>{location.isMain && <small>Principal</small>}</span><b>{moneyLabel(location.revenue)}</b></header>
    <div className="location-metrics"><span><b>{location.activeMembers}</b> miembros activos</span><span><b>{location.attendances}</b> asistencias</span></div>
    <div className="location-bar"><i style={{ width: `${location.attendances / maxAttendance * 100}%` }}/></div>
  </article>) : <div className="chart-empty"><MapPin/><strong>No hay sucursales activas para comparar</strong></div>}</div>;
}

function StaffActivity({ data }: { data: OwnerReport['staffActivity'] }) {
  const maximum = Math.max(1, ...data.people.map((person) => person.actions));
  const alerts = [
    { label: 'PIN incorrecto', value: data.alerts.failedPinAttempts, tone: 'yellow' },
    { label: 'Bloqueos de PIN', value: data.alerts.blockedPinAttempts, tone: 'red' },
    { label: 'Pagos revertidos', value: data.alerts.reversals, tone: 'orange' },
    { label: 'Asistencias anuladas', value: data.alerts.attendanceVoids, tone: 'red' },
  ];
  return <div className="staff-activity-layout">
    <div className="staff-bars">{data.people.length ? data.people.map((person) => <article key={person.staffUserId}><span><strong>{person.name}</strong><small>{person.pinActions} con PIN · {person.sensitiveActions} sensibles</small></span><div><i style={{ width: `${person.actions / maximum * 100}%` }}/></div><b>{person.actions}</b></article>) : <div className="mini-empty"><Users/>No hubo actividad de empleados en este período.</div>}</div>
    <div className="audit-alerts">{alerts.map((alert) => <article className={alert.value ? alert.tone : 'neutral'} key={alert.label}><ShieldAlert/><span><strong>{alert.value}</strong><small>{alert.label}</small></span></article>)}</div>
  </div>;
}

function PermissionAudit({ item }: { item: AuditItem }) {
  if (item.action !== 'staff.permissions_updated') return null;
  if (item.permissionSnapshot.length) return <div className="permission-audit"><div className="audit-context-note"><ShieldCheck/><span><strong>Estado registrado después del cambio</strong><small>Este evento antiguo no guardó el estado anterior.</small></span></div><div className="permission-snapshot">{item.permissionSnapshot.map((permission) => <div key={permission.key}><span>{permission.name}</span><b className={`permission-state ${permission.mode}`}>{MODE_LABELS[permission.mode]}</b></div>)}</div></div>;
  return <div className="permission-audit"><strong className="permission-audit-title">Cambios realizados</strong>{item.permissionChanges.length ? <div className="permission-change-list">{item.permissionChanges.map((permission) => <div className="permission-change" key={permission.key}><span>{permission.name}</span><b className={`permission-state ${permission.before}`}>{MODE_LABELS[permission.before]}</b><span className="permission-arrow">→</span><b className={`permission-state ${permission.after}`}>{MODE_LABELS[permission.after]}</b></div>)}</div> : <div className="audit-context-note"><ShieldCheck/><span><strong>Sin cambios efectivos</strong><small>Se guardó la misma configuración que ya tenía el empleado.</small></span></div>}</div>;
}

function ReadableAuditDetails({ item }: { item: AuditItem }) {
  if (!item.changes.length && !item.details.length) return null;
  return <div className="audit-readable-details">
    {item.changes.map((change) => <div className="audit-readable-change" key={change.label}><span>{change.label}</span><b>{change.before}</b><i>→</i><b>{change.after}</b></div>)}
    {item.details.map((detail) => <div className="audit-readable-value" key={detail.label}><span>{detail.label}</span><b>{detail.value}</b></div>)}
  </div>;
}

export function OwnerControlPage() {
  const [reportFilters, setReportFilters] = useState<ReportFilters>(() => presetRange('month'));
  const [auditDraft, setAuditDraft] = useState({ action: '', entityType: '', usedPin: '' });
  const [auditFilters, setAuditFilters] = useState(auditDraft);
  const [auditPage, setAuditPage] = useState(1);

  const report = useQuery({
    queryKey: ['owner-control-report', reportFilters],
    queryFn: async () => (await api.get<OwnerReport>('/owner-control/report', { params: {
      from: reportFilters.from, to: reportFilters.to, view: reportFilters.view,
      locationId: reportFilters.locationId || undefined,
    } })).data,
  });
  const audit = useQuery({
    queryKey: ['owner-control-audit', reportFilters.from, reportFilters.to, auditFilters, auditPage],
    queryFn: async () => (await api.get<AuditResponse>('/owner-control/audit', { params: {
      from: reportFilters.from, to: reportFilters.to,
      action: auditFilters.action || undefined, entityType: auditFilters.entityType || undefined,
      usedPin: auditFilters.usedPin || undefined, page: auditPage, pageSize: 20,
    } })).data,
  });

  function selectPeriod(view: Exclude<ReportView, 'custom'>) {
    setReportFilters((current) => ({ ...presetRange(view), locationId: current.locationId }));
    setAuditPage(1);
  }
  function updateReportFilter(key: 'from' | 'to' | 'locationId', value: string) {
    setReportFilters((current) => ({ ...current, [key]: value, view: key === 'locationId' ? current.view : 'custom' }));
    setAuditPage(1);
  }
  function applyAuditFilters(event: FormEvent) {
    event.preventDefault();
    setAuditFilters(auditDraft);
    setAuditPage(1);
  }

  const financialCards = report.data ? [
    { label: 'Ingresos confirmados', value: moneyLabel(report.data.financial.confirmed), detail: `${report.data.financial.confirmed.count} pagos`, icon: CircleDollarSign, tone: 'green' },
    { label: 'Pagos anulados', value: moneyLabel(report.data.financial.voided), detail: `${report.data.financial.voided.count} anulaciones`, icon: Ban, tone: 'red' },
    { label: 'Reembolsos', value: moneyLabel(report.data.financial.refunded), detail: `${report.data.financial.refunded.count} reembolsos`, icon: RotateCcw, tone: 'yellow' },
    { label: 'Saldo pendiente actual', value: moneyLabel(report.data.financial.outstanding), detail: `${report.data.financial.outstanding.count} miembros con deuda`, icon: WalletCards, tone: 'orange' },
  ] : [];
  const memberCards = report.data ? [
    { label: 'Acceso activo', value: report.data.members.active, icon: Users, tone: 'green' },
    { label: 'Suspendidos', value: report.data.members.suspended, icon: UserX, tone: 'yellow' },
    { label: 'Retirados', value: report.data.members.retired, icon: Archive, tone: 'red' },
    { label: 'Membresía vencida', value: report.data.members.expired, icon: CalendarX2, tone: 'orange' },
  ] : [];

  return <div className="page owner-control-page">
    <div className="page-heading"><div><p className="eyebrow">CONTROL DEL OWNER</p><h1>Reportes y auditoría</h1><p>Indicadores claros para tomar decisiones sobre ingresos, asistencia y equipo.</p></div><ShieldCheck/></div>

    <section className="panel owner-period-panel">
      <div className="period-selector"><span>Período</span><div>{PERIOD_LABELS.map((period) => <button type="button" className={reportFilters.view === period.value ? 'active' : ''} onClick={() => selectPeriod(period.value)} key={period.value}>{period.label}</button>)}</div></div>
      <div className="owner-report-filters">
        <label>Desde<input type="date" value={reportFilters.from} max={reportFilters.to} onChange={(event) => updateReportFilter('from', event.target.value)}/></label>
        <label>Hasta<input type="date" value={reportFilters.to} min={reportFilters.from} max={todayInGuayaquil()} onChange={(event) => updateReportFilter('to', event.target.value)}/></label>
        <label>Sucursal<select value={reportFilters.locationId} onChange={(event) => updateReportFilter('locationId', event.target.value)}><option value="">Todas las sucursales</option>{report.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}{location.isMain ? ' · Principal' : ''}</option>)}</select></label>
      </div>
      {reportFilters.view === 'custom' && <small className="custom-period-note"><CalendarClock/>Rango personalizado. Puedes volver a Semana, Mes, Trimestre o Año cuando quieras.</small>}
    </section>

    {report.isError && <div className="alert error">{apiErrorMessage(report.error)}</div>}
    {report.isLoading ? <div className="panel owner-loading"><LoaderCircle className="spin"/><strong>Preparando indicadores…</strong></div> : report.data && <>
      <div className="owner-section-heading"><div><p className="eyebrow">FINANZAS</p><h2>Ingresos y saldos</h2></div><small>Valores calculados para el período y la sucursal seleccionados.</small></div>
      <div className="stats-grid">{financialCards.map(({ label, value, detail, icon: Icon, tone }) => <article className="stat-card" key={label}><span className={`stat-icon ${tone}`}><Icon/></span><div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div></article>)}</div>

      <section className="panel decision-panel"><div className="panel-title"><div><h2>Evolución de ingresos</h2><p>Compara cobros y reembolsos con el período anterior equivalente.</p></div><TrendingUp/></div><IncomeEvolution series={report.data.financial.evolution}/></section>

      <div className="owner-section-heading"><div><p className="eyebrow">MIEMBROS</p><h2>Estado actual</h2></div><small>La membresía vencida puede coincidir con un acceso operativo activo.</small></div>
      <div className="stats-grid">{memberCards.map(({ label, value, icon: Icon, tone }) => <article className="stat-card" key={label}><span className={`stat-icon ${tone}`}><Icon/></span><div><p>{label}</p><strong>{value}</strong><small>Estado actual</small></div></article>)}</div>

      <section className="panel decision-panel"><div className="panel-title"><div><h2>Horarios más concurridos</h2><p>{report.data.attendance.total} asistencias válidas · hora local del gimnasio</p></div><Activity/></div><AttendanceHeatmap rows={report.data.attendance.heatmap}/></section>

      <section className="panel decision-panel"><div className="panel-title"><div><h2>Renovaciones y retención</h2><p>Prioriza contactos antes del vencimiento y recupera miembros que dejaron de asistir.</p></div><UserRoundSearch/></div><RetentionPanel data={report.data.retention}/></section>

      <section className="panel decision-panel"><div className="panel-title"><div><h2>Comparación entre sucursales</h2><p>Ingresos, miembros activos y tráfico del período seleccionado.</p></div><MapPin/></div><LocationComparison locations={report.data.locationComparison}/></section>

      <section className="panel decision-panel"><div className="panel-title"><div><h2>Actividad del personal y alertas</h2><p>Volumen de operaciones y eventos que merecen revisión.</p></div><ShieldAlert/></div><StaffActivity data={report.data.staffActivity}/></section>
    </>}

    <div className="owner-section-heading audit-heading"><div><p className="eyebrow">SOLO OWNER</p><h2>Auditoría</h2></div><small>Historial de solo lectura presentado en lenguaje comprensible.</small></div>
    <form className="panel audit-filters" onSubmit={applyAuditFilters}>
      <label>Tipo de acción<select value={auditDraft.action} onChange={(event) => setAuditDraft({ ...auditDraft, action: event.target.value })}><option value="">Todas las acciones</option><option value="staff.">Personal</option><option value="member.">Miembros</option><option value="membership.">Membresías</option><option value="payment.">Pagos</option><option value="attendance.">Asistencias</option><option value="settings.">Configuración</option><option value="admin_pin.">Seguridad y PIN</option></select></label>
      <label>Entidad<select value={auditDraft.entityType} onChange={(event) => setAuditDraft({ ...auditDraft, entityType: event.target.value })}><option value="">Todas las entidades</option><option value="gym_user">Persona</option><option value="membership">Membresía</option><option value="member_payment">Pago</option><option value="attendance">Asistencia</option><option value="gym_location">Sucursal</option><option value="gym">Gimnasio</option></select></label>
      <label>Uso de PIN<select value={auditDraft.usedPin} onChange={(event) => setAuditDraft({ ...auditDraft, usedPin: event.target.value })}><option value="">Todos</option><option value="true">Con PIN</option><option value="false">Sin PIN</option></select></label>
      <button className="primary">Aplicar filtros</button>
    </form>

    {audit.isError && <div className="alert error">{apiErrorMessage(audit.error)}</div>}
    <section className="panel audit-panel">
      {audit.isLoading ? <div className="owner-loading"><LoaderCircle className="spin"/><strong>Cargando auditoría…</strong></div> : audit.data?.items.length ? <div className="audit-list">{audit.data.items.map((item) => <article className="audit-row" key={item.id}>
        <div className="audit-main"><span className="audit-icon"><ShieldCheck/></span><div><strong>{readableAction(item.action)}</strong><small>{item.actorName} · {ROLE_LABELS[item.actorRole] ?? 'Usuario'}</small></div><time>{new Date(item.createdAt).toLocaleString('es-EC')}</time></div>
        <div className="audit-metadata">
          {item.entityName ? <span>{item.entityRole ? ROLE_LABELS[item.entityRole] ?? 'Usuario' : 'Usuario'}: <strong>{item.entityName}</strong></span> : <span>Entidad: <strong>{ENTITY_LABELS[item.entityType] ?? 'Registro del gimnasio'}</strong></span>}
          <span className={item.usedPinElevation ? 'pin-used' : ''}><KeyRound/>{item.usedPinElevation ? 'Autorizado con PIN' : 'No utilizó PIN'}</span>
        </div>
        <PermissionAudit item={item}/><ReadableAuditDetails item={item}/>
      </article>)}</div> : <div className="empty compact"><ShieldCheck/><strong>No hay acciones para estos filtros</strong></div>}
      {audit.data && <div className="audit-pagination"><span>{audit.data.pagination.total} registros · Página {audit.data.pagination.page} de {audit.data.pagination.totalPages}</span><div><button type="button" className="small-button" disabled={auditPage <= 1} onClick={() => setAuditPage((current) => Math.max(1, current - 1))}><ChevronLeft/> Anterior</button><button type="button" className="small-button" disabled={auditPage >= audit.data.pagination.totalPages} onClick={() => setAuditPage((current) => current + 1)}>Siguiente <ChevronRight/></button></div></div>}
    </section>
  </div>;
}
