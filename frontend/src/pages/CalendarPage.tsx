import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, LoaderCircle, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';

type DayMode = 'required' | 'bonus' | 'closed';
type Day = { weekday: number; dayMode: DayMode; opensAt: string | null; closesAt: string | null };
type StoredDay = { weekday: number; day_mode: DayMode; opens_at: string | null; closes_at: string | null };
type Exception = { id: string; calendar_date: string; day_mode: DayMode; opens_at: string | null; closes_at: string | null; reason?: string | null };
type CalendarData = { location: { id: string; name: string }; hours: StoredDay[]; exceptions: Exception[] };

const dayNames = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const defaultDays: Day[] = dayNames.map((_, index) => ({ weekday: index + 1, dayMode: index < 5 ? 'required' : 'closed', opensAt: index < 5 ? '06:00' : null, closesAt: index < 5 ? '22:00' : null }));
const modeLabels: Record<DayMode, string> = { required: 'Abierto obligatorio', bonus: 'Abierto adicional', closed: 'Cerrado' };

function apiMessage(error: unknown) {
  const value = error as { response?: { data?: { error?: { message?: string } } } };
  return value.response?.data?.error?.message ?? 'No se pudo guardar la configuración.';
}

export function CalendarPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const locationId = session?.gymUser?.default_location_id;
  const [days, setDays] = useState<Day[]>(defaultDays);
  const [calendarDate, setCalendarDate] = useState('');
  const [exceptionMode, setExceptionMode] = useState<DayMode>('closed');
  const [exceptionOpens, setExceptionOpens] = useState('06:00');
  const [exceptionCloses, setExceptionCloses] = useState('22:00');
  const [reason, setReason] = useState('');
  const calendar = useQuery({ queryKey: ['calendar', locationId], queryFn: async () => (await api.get<CalendarData>('/calendar')).data, enabled: Boolean(locationId) });
  useEffect(() => {
    if (!calendar.data) return;
    const stored = new Map(calendar.data.hours.map((day) => [day.weekday, day]));
    setDays(defaultDays.map((fallback) => { const day = stored.get(fallback.weekday); return day ? { weekday: day.weekday, dayMode: day.day_mode, opensAt: day.opens_at?.slice(0, 5) ?? null, closesAt: day.closes_at?.slice(0, 5) ?? null } : fallback; }));
  }, [calendar.data]);
  const saveSchedule = useMutation({ mutationFn: async () => api.put('/calendar/schedule', { locationId, days }), onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['calendar'] }) });
  const saveException = useMutation({ mutationFn: async () => api.post('/calendar/exceptions', { locationId, calendarDate, dayMode: exceptionMode, opensAt: exceptionMode === 'closed' ? null : exceptionOpens, closesAt: exceptionMode === 'closed' ? null : exceptionCloses, reason: reason.trim() || null }), onSuccess: async () => { setCalendarDate(''); setReason(''); await queryClient.invalidateQueries({ queryKey: ['calendar'] }); } });
  const updateDay = (weekday: number, update: Partial<Day>) => setDays((current) => current.map((day) => day.weekday === weekday ? { ...day, ...update } : day));

  if (!locationId) return <div className="page"><div className="alert warning">Tu usuario no tiene una sucursal predeterminada.</div></div>;
  return <div className="page"><div className="page-heading"><div><p className="eyebrow">CONFIGURACIÓN</p><h1>Horarios</h1><p>{calendar.data?.location.name ?? 'Sucursal'} · America/Guayaquil</p></div><button className="primary" onClick={() => saveSchedule.mutate()} disabled={saveSchedule.isPending}>{saveSchedule.isPending ? <><LoaderCircle className="spin"/>Guardando…</> : 'Guardar horario'}</button></div>
    {saveSchedule.isError && <div className="alert error">{apiMessage(saveSchedule.error)}</div>}
    {saveSchedule.isSuccess && <div className="alert success">Horario semanal guardado correctamente.</div>}
    <section className="panel"><div className="panel-title"><div><h2>Semana habitual</h2><p>Obligatorio afecta la racha; adicional solamente suma.</p></div></div>{calendar.isLoading ? <div className="empty"><LoaderCircle className="spin"/>Cargando horario…</div> : <div className="schedule-list">{days.map((day, index) => <article className="schedule-row" key={day.weekday}><strong>{dayNames[index]}</strong><select value={day.dayMode} onChange={(event) => { const mode = event.target.value as DayMode; updateDay(day.weekday, { dayMode: mode, opensAt: mode === 'closed' ? null : day.opensAt ?? '06:00', closesAt: mode === 'closed' ? null : day.closesAt ?? '22:00' }); }}>{Object.entries(modeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><input type="time" disabled={day.dayMode === 'closed'} value={day.opensAt ?? ''} onChange={(event) => updateDay(day.weekday, { opensAt: event.target.value })}/><span>hasta</span><input type="time" disabled={day.dayMode === 'closed'} value={day.closesAt ?? ''} onChange={(event) => updateDay(day.weekday, { closesAt: event.target.value })}/></article>)}</div>}</section>
    <div className="calendar-grid"><section className="panel"><div className="panel-title"><div><h2>Agregar excepción</h2><p>Feriados, cierres o aperturas especiales.</p></div><Plus/></div><form className="exception-form" onSubmit={(event: FormEvent) => { event.preventDefault(); saveException.mutate(); }}><label>Fecha<input type="date" required value={calendarDate} onChange={(event) => setCalendarDate(event.target.value)}/></label><label>Estado<select value={exceptionMode} onChange={(event) => setExceptionMode(event.target.value as DayMode)}>{Object.entries(modeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>{exceptionMode !== 'closed' && <><label>Abre<input type="time" required value={exceptionOpens} onChange={(event) => setExceptionOpens(event.target.value)}/></label><label>Cierra<input type="time" required value={exceptionCloses} onChange={(event) => setExceptionCloses(event.target.value)}/></label></>}<label className="wide">Motivo<input maxLength={250} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ejemplo: feriado local"/></label>{saveException.isError && <div className="alert error wide">{apiMessage(saveException.error)}</div>}<button className="primary wide" disabled={saveException.isPending}>{saveException.isPending ? 'Guardando…' : 'Guardar excepción'}</button></form></section><section className="panel"><div className="panel-title"><div><h2>Próximas excepciones</h2><p>Una fecha existente se puede sobrescribir.</p></div><CalendarDays/></div>{calendar.data?.exceptions.length ? <div className="exception-list">{calendar.data.exceptions.map((item) => <article key={item.id}><div><strong>{item.calendar_date}</strong><small>{item.reason ?? 'Sin motivo'}</small></div><span className={`badge ${item.day_mode}`}>{modeLabels[item.day_mode]}</span></article>)}</div> : <div className="empty compact"><CalendarDays/><strong>Sin excepciones futuras</strong></div>}</section></div>
  </div>;
}
