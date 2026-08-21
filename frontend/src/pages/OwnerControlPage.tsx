import { useQuery } from '@tanstack/react-query';
import {
  Activity, Archive, Ban, CalendarX2, ChevronLeft, ChevronRight,
  CircleDollarSign, KeyRound, LoaderCircle, RotateCcw, ShieldCheck,
  UserX, Users, WalletCards,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, apiErrorMessage } from '../services/api';

type MoneySummary = { count: number; byCurrency: Array<{ currency: string; amount: number }> };
type OwnerReport = {
  range: { from: string; to: string };
  selectedLocationId: string | null;
  locations: Array<{ id: string; name: string; isMain: boolean }>;
  financial: { confirmed: MoneySummary; voided: MoneySummary; refunded: MoneySummary; outstanding: MoneySummary };
  members: { active: number; suspended: number; retired: number; expired: number };
  attendance: {
    total: number;
    daily: Array<{ date: string; count: number }>;
    byLocation: Array<{ locationId: string; locationName: string; count: number }>;
  };
};
type AuditItem = {
  id: number;
  actorGymUserId: string | null;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  entityRole: string | null;
  permissionKey: string | null;
  usedPinElevation: boolean;
  beforeData: unknown;
  afterData: unknown;
  createdAt: string;
};
type AuditResponse = {
  items: AuditItem[];
  permissionCatalog: Array<{ key: string; name: string; description: string | null }>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

type PermissionMode = 'allowed' | 'requires_pin' | 'denied';

const ACTION_LABELS: Record<string, string> = {
  'staff.permissions_updated': 'Actualizó los permisos de un empleado',
  'staff.status_updated': 'Cambió el estado de un empleado',
  'staff.invitation_created': 'Invitó a un empleado',
  'staff.invitation_revoked': 'Revocó una invitación de empleado',
  'staff.removed': 'Retiró el acceso de un empleado',
  'staff.reinstated': 'Reincorporó a un empleado',
  'member.managed_created': 'Registró un miembro sin cuenta',
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
  'admin_pin.attempt_failed': 'Registró un intento de PIN incorrecto',
  'admin_pin.attempt_blocked': 'Bloqueó temporalmente los intentos de PIN',
  'plan.created': 'Creó un plan de membresía',
};

const ENTITY_LABELS: Record<string, string> = {
  gym_user: 'Usuario del gimnasio', member: 'Miembro', membership: 'Membresía',
  payment: 'Pago', attendance: 'Asistencia', gym: 'Gimnasio',
  gym_location: 'Sucursal', staff_invitation: 'Invitación de empleado', plan: 'Plan',
};

const ROLE_LABELS: Record<string, string> = { owner: 'Owner', staff: 'Empleado', member: 'Miembro', system: 'Sistema' };
const MODE_LABELS: Record<PermissionMode, string> = { allowed: 'Permitido', requires_pin: 'Requiere PIN', denied: 'Denegado' };

function todayInGuayaquil() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function initialRange() {
  const today = todayInGuayaquil();
  return { from: `${today.slice(0, 8)}01`, to: today, locationId: '' };
}

function moneyLabel(summary: MoneySummary) {
  if (!summary.byCurrency.length) return '0.00 USD';
  return summary.byCurrency.map(({ amount, currency }) => `${Number(amount).toFixed(2)} ${currency}`).join(' · ');
}

function readableAction(action: string) {
  return ACTION_LABELS[action] ?? action.split('.').map((part) => part.replaceAll('_', ' ')).join(' · ');
}

function JsonValue({ label, value }: { label: string; value: unknown }) {
  return <div className="audit-json"><strong>{label}</strong><pre>{value == null ? 'No se registró este estado.' : JSON.stringify(value, null, 2)}</pre></div>;
}

function permissionMatrix(value: unknown): Record<string, PermissionMode> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, PermissionMode] =>
    entry[1] === 'allowed' || entry[1] === 'requires_pin' || entry[1] === 'denied');
  return entries.length ? Object.fromEntries(entries) : null;
}

function PermissionAudit({ item, catalog }: { item: AuditItem; catalog: AuditResponse['permissionCatalog'] }) {
  if (item.action !== 'staff.permissions_updated') return null;
  const before = permissionMatrix(item.beforeData);
  const after = permissionMatrix(item.afterData);
  if (!after) return null;
  const names = new Map(catalog.map((permission) => [permission.key, permission.name]));

  if (!before) {
    return <div className="permission-audit"><div className="audit-context-note"><ShieldCheck/><span><strong>Estado registrado después del cambio</strong><small>Este evento antiguo no guardó el estado anterior, por lo que no es posible reconstruir las diferencias.</small></span></div><div className="permission-snapshot">{Object.entries(after).sort(([left], [right]) => left.localeCompare(right)).map(([key, mode]) => <div key={key}><span>{names.get(key) ?? key}</span><b className={`permission-state ${mode}`}>{MODE_LABELS[mode]}</b></div>)}</div></div>;
  }

  const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key]).sort();
  return <div className="permission-audit"><strong className="permission-audit-title">Cambios realizados</strong>{changedKeys.length ? <div className="permission-change-list">{changedKeys.map((key) => <div className="permission-change" key={key}><span>{names.get(key) ?? key}</span><b className={`permission-state ${before[key] ?? 'denied'}`}>{MODE_LABELS[before[key] ?? 'denied']}</b><span className="permission-arrow">→</span><b className={`permission-state ${after[key] ?? 'denied'}`}>{MODE_LABELS[after[key] ?? 'denied']}</b></div>)}</div> : <div className="audit-context-note"><ShieldCheck/><span><strong>Sin cambios efectivos</strong><small>Se guardó la misma configuración que ya tenía el empleado.</small></span></div>}</div>;
}

export function OwnerControlPage() {
  const [reportFilters, setReportFilters] = useState(initialRange);
  const [auditDraft, setAuditDraft] = useState({ action: '', entityType: '', usedPin: '' });
  const [auditFilters, setAuditFilters] = useState(auditDraft);
  const [auditPage, setAuditPage] = useState(1);

  const report = useQuery({
    queryKey: ['owner-control-report', reportFilters],
    queryFn: async () => (await api.get<OwnerReport>('/owner-control/report', { params: {
      from: reportFilters.from, to: reportFilters.to, locationId: reportFilters.locationId || undefined,
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

  function updateReportFilter(key: keyof typeof reportFilters, value: string) {
    setReportFilters((current) => ({ ...current, [key]: value }));
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
    <div className="page-heading"><div><p className="eyebrow">CONTROL DEL OWNER</p><h1>Reportes y auditoría</h1><p>Información operativa y financiera exclusivamente de lectura.</p></div><ShieldCheck/></div>

    <section className="panel owner-report-filters">
      <label>Desde<input type="date" value={reportFilters.from} max={reportFilters.to} onChange={(event) => updateReportFilter('from', event.target.value)}/></label>
      <label>Hasta<input type="date" value={reportFilters.to} min={reportFilters.from} onChange={(event) => updateReportFilter('to', event.target.value)}/></label>
      <label>Sucursal<select value={reportFilters.locationId} onChange={(event) => updateReportFilter('locationId', event.target.value)}><option value="">Todas las sucursales</option>{report.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}{location.isMain ? ' · Principal' : ''}</option>)}</select></label>
    </section>

    {report.isError && <div className="alert error">{apiErrorMessage(report.error)}</div>}
    {report.isLoading ? <div className="panel owner-loading"><LoaderCircle className="spin"/><strong>Preparando reporte…</strong></div> : report.data && <>
      <div className="owner-section-heading"><div><p className="eyebrow">FINANZAS</p><h2>Ingresos y saldos</h2></div><small>Anulaciones por fecha de anulación y reembolsos por fecha de reembolso.</small></div>
      <div className="stats-grid">{financialCards.map(({ label, value, detail, icon: Icon, tone }) => <article className="stat-card" key={label}><span className={`stat-icon ${tone}`}><Icon/></span><div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div></article>)}</div>

      <div className="owner-section-heading"><div><p className="eyebrow">MIEMBROS</p><h2>Estado actual</h2></div><small>Membresía vencida puede coincidir con un acceso operativo activo.</small></div>
      <div className="stats-grid">{memberCards.map(({ label, value, icon: Icon, tone }) => <article className="stat-card" key={label}><span className={`stat-icon ${tone}`}><Icon/></span><div><p>{label}</p><strong>{value}</strong><small>Estado actual</small></div></article>)}</div>

      <div className="owner-report-grid">
        <section className="panel"><div className="panel-title"><div><h2>Asistencias por día</h2><p>{report.data.attendance.total} asistencias válidas</p></div><Activity/></div><div className="owner-data-table"><table><thead><tr><th>Fecha</th><th>Asistencias</th></tr></thead><tbody>{report.data.attendance.daily.map((day) => <tr key={day.date}><td>{day.date}</td><td><strong>{day.count}</strong></td></tr>)}</tbody></table></div></section>
        <section className="panel"><div className="panel-title"><div><h2>Por sucursal</h2><p>Distribución del período seleccionado</p></div><Activity/></div><div className="owner-data-table"><table><thead><tr><th>Sucursal</th><th>Asistencias</th></tr></thead><tbody>{report.data.attendance.byLocation.map((location) => <tr key={location.locationId}><td>{location.locationName}</td><td><strong>{location.count}</strong></td></tr>)}</tbody></table></div></section>
      </div>
    </>}

    <div className="owner-section-heading audit-heading"><div><p className="eyebrow">SOLO OWNER</p><h2>Auditoría</h2></div><small>Este historial no puede editarse ni eliminarse desde la interfaz.</small></div>
    <form className="panel audit-filters" onSubmit={applyAuditFilters}>
      <label>Acción contiene<input value={auditDraft.action} onChange={(event) => setAuditDraft({ ...auditDraft, action: event.target.value })} placeholder="Ejemplo: payment"/></label>
      <label>Entidad contiene<input value={auditDraft.entityType} onChange={(event) => setAuditDraft({ ...auditDraft, entityType: event.target.value })} placeholder="Ejemplo: member"/></label>
      <label>Uso de PIN<select value={auditDraft.usedPin} onChange={(event) => setAuditDraft({ ...auditDraft, usedPin: event.target.value })}><option value="">Todos</option><option value="true">Con PIN</option><option value="false">Sin PIN</option></select></label>
      <button className="primary">Aplicar filtros</button>
    </form>

    {audit.isError && <div className="alert error">{apiErrorMessage(audit.error)}</div>}
    <section className="panel audit-panel">
      {audit.isLoading ? <div className="owner-loading"><LoaderCircle className="spin"/><strong>Cargando auditoría…</strong></div> : audit.data?.items.length ? <div className="audit-list">{audit.data.items.map((item) => {
        const permissionName = audit.data.permissionCatalog.find((permission) => permission.key === item.permissionKey)?.name;
        return <article className="audit-row" key={item.id}>
          <div className="audit-main"><span className="audit-icon"><ShieldCheck/></span><div><strong>{readableAction(item.action)}</strong><small>{item.actorName} · {ROLE_LABELS[item.actorRole] ?? item.actorRole}</small></div><time>{new Date(item.createdAt).toLocaleString('es-EC')}</time></div>
          <div className="audit-metadata">
            {item.entityName ? <span>{item.entityRole ? ROLE_LABELS[item.entityRole] ?? 'Usuario' : 'Usuario'}: <strong>{item.entityName}</strong></span> : <span>Entidad: <strong>{ENTITY_LABELS[item.entityType] ?? item.entityType}</strong></span>}
            {permissionName && <span>Operación: <strong>{permissionName}</strong></span>}
            <span className={item.usedPinElevation ? 'pin-used' : ''}><KeyRound/>{item.usedPinElevation ? 'Autorizado con PIN' : 'No utilizó PIN'}</span>
          </div>
          <PermissionAudit item={item} catalog={audit.data.permissionCatalog}/>
          {(item.beforeData != null || item.afterData != null) && <details className="audit-technical"><summary>Ver datos técnicos (JSON)</summary><div className="audit-technical-metadata"><span>Tipo: {item.entityType}</span><span>ID: {item.entityId ?? 'No disponible'}</span><span>Acción: {item.action}</span></div><div className="audit-json-grid"><JsonValue label="Estado anterior técnico" value={item.beforeData}/><JsonValue label="Estado posterior técnico" value={item.afterData}/></div></details>}
        </article>;
      })}</div> : <div className="empty compact"><ShieldCheck/><strong>No hay acciones para estos filtros</strong></div>}
      {audit.data && <div className="audit-pagination"><span>{audit.data.pagination.total} registros · Página {audit.data.pagination.page} de {audit.data.pagination.totalPages}</span><div><button className="small-button" disabled={auditPage <= 1} onClick={() => setAuditPage((current) => Math.max(1, current - 1))}><ChevronLeft/> Anterior</button><button className="small-button" disabled={auditPage >= audit.data.pagination.totalPages} onClick={() => setAuditPage((current) => current + 1)}>Siguiente <ChevronRight/></button></div></div>}
    </section>
  </div>;
}
