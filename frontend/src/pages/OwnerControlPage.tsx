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
  permissionKey: string | null;
  usedPinElevation: boolean;
  beforeData: unknown;
  afterData: unknown;
  createdAt: string;
};
type AuditResponse = {
  items: AuditItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

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
  return action.split('.').map((part) => part.replaceAll('_', ' ')).join(' · ');
}

function JsonValue({ label, value }: { label: string; value: unknown }) {
  return <div className="audit-json"><strong>{label}</strong><pre>{value == null ? 'Sin datos' : JSON.stringify(value, null, 2)}</pre></div>;
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
      {audit.isLoading ? <div className="owner-loading"><LoaderCircle className="spin"/><strong>Cargando auditoría…</strong></div> : audit.data?.items.length ? <div className="audit-list">{audit.data.items.map((item) => <article className="audit-row" key={item.id}>
        <div className="audit-main"><span className="audit-icon"><ShieldCheck/></span><div><strong>{readableAction(item.action)}</strong><small>{item.actorName} · {item.actorRole} · {item.entityType}</small></div><time>{new Date(item.createdAt).toLocaleString('es-EC')}</time></div>
        <div className="audit-metadata"><span>Entidad: <strong>{item.entityId ?? 'Sin identificador'}</strong></span><span>Permiso: <strong>{item.permissionKey ?? 'No aplica'}</strong></span><span className={item.usedPinElevation ? 'pin-used' : ''}><KeyRound/>{item.usedPinElevation ? 'Usó PIN' : 'Sin PIN'}</span></div>
        {(item.beforeData != null || item.afterData != null) && <details><summary>Ver valores anteriores y posteriores</summary><div className="audit-json-grid"><JsonValue label="Antes" value={item.beforeData}/><JsonValue label="Después" value={item.afterData}/></div></details>}
      </article>)}</div> : <div className="empty compact"><ShieldCheck/><strong>No hay acciones para estos filtros</strong></div>}
      {audit.data && <div className="audit-pagination"><span>{audit.data.pagination.total} registros · Página {audit.data.pagination.page} de {audit.data.pagination.totalPages}</span><div><button className="small-button" disabled={auditPage <= 1} onClick={() => setAuditPage((current) => Math.max(1, current - 1))}><ChevronLeft/> Anterior</button><button className="small-button" disabled={auditPage >= audit.data.pagination.totalPages} onClick={() => setAuditPage((current) => current + 1)}>Siguiente <ChevronRight/></button></div></div>}
    </section>
  </div>;
}
