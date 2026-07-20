import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowUpRight, CreditCard, Flame, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';

type Member = { id: string; status: string; profiles?: { full_name?: string } };
type Attendance = { id: string; member_user_id: string; checked_in_at: string; status: 'valid' | 'voided'; source: string };
type Payment = { id: string; member_user_id: string; amount: number; currency: string; payment_method: string; status: string; paid_at: string };
type Streak = { member_user_id: string; current_streak: number; longest_streak: number; status: string };
type ActivityItem = { id: string; kind: 'attendance' | 'payment'; memberUserId: string; date: string; label: string; detail: string };

function dateInGuayaquil() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts();
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function paymentMethod(method: string) {
  return ({ cash: 'Efectivo', bank_transfer: 'Transferencia', external_card: 'Tarjeta', external_deuna: 'DEUNA', other: 'Otro' } as Record<string, string>)[method] ?? method;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const today = dateInGuayaquil();
  const monthPrefix = today.slice(0, 7);
  const members = useQuery({ queryKey: ['members'], queryFn: async () => (await api.get<{ members: Member[] }>('/members')).data.members });
  const attendances = useQuery({ queryKey: ['attendances', today], queryFn: async () => (await api.get<{ attendances: Attendance[] }>('/attendances', { params: { from: today, to: today } })).data.attendances });
  const streaks = useQuery({ queryKey: ['streaks'], queryFn: async () => (await api.get<{ streaks: Streak[] }>('/attendances/streaks')).data.streaks });
  const payments = useQuery({ queryKey: ['payments'], queryFn: async () => (await api.get<{ payments: Payment[] }>('/member-payments')).data.payments, retry: false });
  const names = new Map((members.data ?? []).map((member) => [member.id, member.profiles?.full_name ?? 'Miembro']));
  const confirmedPayments = (payments.data ?? []).filter((payment) => payment.status === 'confirmed' && payment.paid_at.slice(0, 7) === monthPrefix);
  const income = confirmedPayments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const currency = confirmedPayments[0]?.currency ?? 'USD';
  const validAttendances = (attendances.data ?? []).filter((attendance) => attendance.status === 'valid');
  const bestStreak = Math.max(0, ...(streaks.data ?? []).map((streak) => streak.longest_streak));
  const loading = members.isLoading || attendances.isLoading || streaks.isLoading;

  const activity: ActivityItem[] = [
    ...(attendances.data ?? []).map((attendance) => ({ id: attendance.id, kind: 'attendance' as const, memberUserId: attendance.member_user_id, date: attendance.checked_in_at, label: attendance.status === 'valid' ? 'Asistencia registrada' : 'Asistencia anulada', detail: attendance.source === 'staff' ? 'Registro manual' : 'Registro QR' })),
    ...(payments.data ?? []).filter((payment) => payment.status === 'confirmed').map((payment) => ({ id: payment.id, kind: 'payment' as const, memberUserId: payment.member_user_id, date: payment.paid_at, label: 'Pago confirmado', detail: `${Number(payment.amount).toFixed(2)} ${payment.currency} · ${paymentMethod(payment.payment_method)}` })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 6);

  const stats = [
    { label: 'Miembros activos', value: loading ? '…' : String((members.data ?? []).filter((member) => member.status === 'active').length), detail: 'Con acceso activo', icon: Users, tone: 'red' },
    { label: 'Ingresos del mes', value: payments.isLoading ? '…' : payments.isError ? 'Restringido' : `${income.toFixed(2)} ${currency}`, detail: payments.isError ? 'Sin permiso financiero' : 'Pagos confirmados', icon: CreditCard, tone: 'yellow' },
    { label: 'Asistencias hoy', value: attendances.isLoading ? '…' : String(validAttendances.length), detail: 'Registros válidos', icon: Activity, tone: 'green' },
    { label: 'Mejor racha', value: streaks.isLoading ? '…' : String(bestStreak), detail: 'Récord del gimnasio', icon: Flame, tone: 'orange' },
  ];

  return <div className="page"><div className="page-heading"><div><p className="eyebrow">RESUMEN DEL GIMNASIO</p><h1>Dashboard</h1><p>Una vista rápida de lo que está pasando hoy.</p></div><button className="primary" onClick={() => navigate('/memberships')}>Registrar pago <ArrowUpRight size={17}/></button></div>
    <div className="stats-grid">{stats.map(({ label, value, detail, icon: Icon, tone }) => <article className="stat-card" key={label}><span className={`stat-icon ${tone}`}><Icon/></span><div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div></article>)}</div>
    <div className="dashboard-grid"><section className="panel"><div className="panel-title"><div><h2>Actividad reciente</h2><p>Últimos movimientos del gimnasio</p></div><button className="ghost" onClick={() => navigate('/attendances')}>Ver asistencias</button></div>{activity.length ? <div className="activity-list">{activity.map((item) => <article className="activity-row" key={`${item.kind}-${item.id}`}><span className={`activity-icon ${item.kind}`}>{item.kind === 'payment' ? <CreditCard/> : <Activity/>}</span><div><strong>{item.label}</strong><small>{names.get(item.memberUserId) ?? 'Miembro'} · {item.detail}</small></div><time>{new Date(item.date).toLocaleString('es-EC', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></article>)}</div> : <div className="empty"><Activity/><strong>Aún no hay actividad para mostrar</strong><span>Las asistencias y pagos aparecerán aquí.</span></div>}</section>
      <section className="panel streak-panel"><p className="eyebrow">MOTIVACIÓN</p><Flame size={42}/><h2>Rachas que construyen hábitos</h2><p>{bestStreak > 0 ? `La mejor racha actual del gimnasio alcanza ${bestStreak} días.` : 'Las rachas aparecerán cuando los miembros empiecen a registrar asistencias.'}</p><button className="secondary" onClick={() => navigate('/attendances')}>Ver rachas</button></section></div>
  </div>;
}
