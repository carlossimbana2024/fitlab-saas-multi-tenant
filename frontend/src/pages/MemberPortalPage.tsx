import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bell, CalendarCheck, CheckCircle2, Clock3, CreditCard, Dumbbell, Flame, Gift, LoaderCircle, Mail, MapPin, MessageCircle, Pencil, Phone, QrCode, ShieldCheck, Upload, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';

type PortalSection = 'home' | 'classes' | 'progress' | 'profile';
type Period = { starts_on: string; ends_on: string; status: string };
type Membership = { id: string; status: string; price_at_purchase: number; currency: string; attendance_mode_snapshot: 'daily' | 'weekly'; weekly_target_snapshot?: number | null; plans?: { name?: string }; membership_periods?: Period[] };
type Attendance = { id: string; attendance_date: string; checked_in_at: string; status: 'valid' | 'voided'; source: string; counts_toward_streak: boolean };
type Streak = { status: string; current_streak: number; longest_streak: number; last_attendance_date?: string | null };
type Payment = { id: string; amount: number; currency: string; payment_method: string; status: string; paid_at: string };
type WeeklyProgress = { id: string; week_starts_on: string; week_ends_on: string; target_attendances: number; completed_attendances: number; goal_met: boolean; is_grace_week: boolean };
type Hour = { weekday: number; opens_at: string | null; closes_at: string | null; day_mode: 'required' | 'bonus' | 'closed' };
type Exception = { calendar_date: string; opens_at: string | null; closes_at: string | null; day_mode: 'required' | 'bonus' | 'closed'; reason?: string | null };
type Calendar = { gym: { name: string; email?: string | null; phone?: string | null; whatsapp_phone?: string | null; timezone: string }; location: { name: string; address?: string | null; city: string; timezone: string; email?: string | null; phone?: string | null; whatsapp_phone?: string | null }; hours: Hour[]; exceptions: Exception[] };
type PortalClassBooking = { id: string; status: 'reserved' | 'attended' | 'cancelled' | 'no_show'; payment_id?: string | null };
type PortalClassSchedule = { id: string; starts_at: string; ends_at: string; status: string; occupied: number; capacity: number; available: number; activity: { name: string; description?: string | null; billing_mode: 'included' | 'additional_fee'; price: number; currency: string; duration_minutes: number }; location: { name: string }; instructor?: { name: string } | null; myBooking?: PortalClassBooking | null; myWaitlist?: { id: string; position: number; status: 'waiting' | 'offered' } | null };
type PortalActivities = { schedules: PortalClassSchedule[] };
type FitnessGoal = 'lose_weight' | 'gain_weight' | 'build_muscle' | 'improve_fitness' | 'maintain_weight' | 'general_wellness';
type FitnessProfile = {
  id: string;
  weight_kg: number;
  height_cm: number;
  goal_type: FitnessGoal;
  experience_level: 'beginner' | 'intermediate' | 'advanced';
  training_frequency_per_week: number;
  available_days: number[];
  target_weight_kg?: number | null;
  preferred_training_type?: string | null;
  goal_horizon_months?: number | null;
  public_message?: string | null;
  show_in_community: boolean;
  show_profile_photo: boolean;
  show_streak: boolean;
  show_attendance_count: boolean;
  show_weight_progress: boolean;
  show_goal: boolean;
  onboarding_completed_at: string;
  updated_at: string;
};
type FitnessForm = {
  weightKg: string;
  heightCm: string;
  goalType: FitnessGoal;
  experienceLevel: FitnessProfile['experience_level'];
  trainingFrequencyPerWeek: string;
  availableDays: number[];
  targetWeightKg: string;
  preferredTrainingType: string;
  goalHorizonMonths: string;
  publicMessage: string;
  showInCommunity: boolean;
  showProfilePhoto: boolean;
  showStreak: boolean;
  showAttendanceCount: boolean;
  showWeightProgress: boolean;
  showGoal: boolean;
};
type ProgressWeight = { id: string; weightKg: number; measuredOn: string; source: string; createdAt: string };
type ProgressBucket = { period: string; label: string; count: number };
type GoalProgress = { goalType: FitnessGoal; initialWeightKg: number; currentWeightKg: number; targetWeightKg: number | null; progressPercent: number };
type MemberProgress = {
  today: string;
  totalAttendances: number;
  currentMonthAttendances: number;
  currentWeekAttendances: number;
  averageWeeklyAttendances: number;
  attendanceByMonth: ProgressBucket[];
  attendanceByWeek: ProgressBucket[];
  currentStreak: number;
  longestStreak: number;
  latestAttendanceDate: string | null;
  weights: ProgressWeight[];
  goal: GoalProgress | null;
  motivation: { tone: 'success' | 'encouragement' | 'neutral'; title: string; message: string };
};

const fitnessGoals: Array<{ value: FitnessGoal; label: string }> = [
  { value: 'lose_weight', label: 'Perder peso' },
  { value: 'gain_weight', label: 'Ganar peso' },
  { value: 'build_muscle', label: 'Ganar masa muscular' },
  { value: 'improve_fitness', label: 'Mejorar condición física' },
  { value: 'maintain_weight', label: 'Mantener peso' },
  { value: 'general_wellness', label: 'Bienestar general' },
];
const experienceLabels = { beginner: 'Principiante', intermediate: 'Intermedio', advanced: 'Avanzado' } as const;
const dayLabels = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

function fitnessFormFromProfile(profile?: FitnessProfile | null): FitnessForm {
  return {
    weightKg: profile ? String(profile.weight_kg) : '',
    heightCm: profile ? String(profile.height_cm) : '',
    goalType: profile?.goal_type ?? 'improve_fitness',
    experienceLevel: profile?.experience_level ?? 'beginner',
    trainingFrequencyPerWeek: profile ? String(profile.training_frequency_per_week) : '3',
    availableDays: profile?.available_days ?? [],
    targetWeightKg: profile?.target_weight_kg == null ? '' : String(profile.target_weight_kg),
    preferredTrainingType: profile?.preferred_training_type ?? '',
    goalHorizonMonths: profile?.goal_horizon_months == null ? '' : String(profile.goal_horizon_months),
    publicMessage: profile?.public_message ?? '',
    showInCommunity: profile?.show_in_community ?? false,
    showProfilePhoto: profile?.show_profile_photo ?? false,
    showStreak: profile?.show_streak ?? false,
    showAttendanceCount: profile?.show_attendance_count ?? false,
    showWeightProgress: profile?.show_weight_progress ?? false,
    showGoal: profile?.show_goal ?? false,
  };
}

const localDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(new Date());
const methodLabel = (method: string) => ({ cash: 'Efectivo', bank_transfer: 'Transferencia', external_card: 'Tarjeta', external_deuna: 'DEUNA', other: 'Otro' } as Record<string, string>)[method] ?? method;
const money = (amount: number, currency: string) => new Intl.NumberFormat('es-EC', { style: 'currency', currency }).format(Number(amount));
const shortTime = (value: string | null) => value?.slice(0, 5) ?? '—';

function monthRange() {
  const today = localDate(); const [year, month] = today.split('-').map(Number);
  const last = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return { today, year: year!, month: month!, from: `${year}-${String(month).padStart(2, '0')}-01`, to: `${year}-${String(month).padStart(2, '0')}-${last}`, last };
}

function daysUntil(end: string | undefined, today: string) {
  if (!end) return null;
  const [endYear, endMonth, endDay] = end.split('-').map(Number);
  const [todayYear, todayMonth, todayDay] = today.split('-').map(Number);
  return Math.floor((Date.UTC(endYear!, endMonth! - 1, endDay!) - Date.UTC(todayYear!, todayMonth! - 1, todayDay!)) / 86_400_000);
}

function membershipCoverageLabel(remaining: number | null) {
  if (remaining === null) return 'Sin fecha de cobertura';
  if (remaining > 0) return `${remaining} días restantes`;
  if (remaining === 0) return 'Vigente hasta hoy';
  return 'Cobertura vencida';
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'AT';
}

function sectionCopy(section: PortalSection) {
  return {
    home: ['Tu centro de entrenamiento', 'Todo lo importante, de un vistazo.'],
    classes: ['Entrena con intención', 'Consulta horarios y reserva tus próximas clases.'],
    progress: ['La constancia construye resultados', 'Mira tus asistencias y el avance de tu rutina.'],
    profile: ['Tu información, siempre contigo', 'Administra tus datos y consulta tu cobertura.'],
  }[section];
}

export function MemberPortalPage({ section }: { section: PortalSection }) {
  const { session, refresh } = useAuth();
  const queryClient = useQueryClient();
  const range = useMemo(monthRange, []);
  const [editing, setEditing] = useState(false);
  const [fitnessEditing, setFitnessEditing] = useState(false);
  const [profile, setProfile] = useState({ fullName: session?.gymUser?.profiles?.full_name ?? '', phone: session?.gymUser?.profiles?.phone ?? '' });
  const [passwords, setPasswords] = useState({ current: '', next: '', confirmation: '' });
  const memberships = useQuery({ queryKey: ['my-memberships'], queryFn: async () => (await api.get<{ memberships: Membership[] }>('/memberships')).data.memberships });
  const attendances = useQuery({ queryKey: ['my-attendances'], queryFn: async () => (await api.get<{ attendances: Attendance[] }>('/attendances')).data.attendances });
  const streaks = useQuery({ queryKey: ['my-streak'], queryFn: async () => (await api.get<{ streaks: Streak[] }>('/attendances/streaks')).data.streaks });
  const payments = useQuery({ queryKey: ['my-payments'], queryFn: async () => (await api.get<{ payments: Payment[] }>('/member-payments')).data.payments });
  const weekly = useQuery({ queryKey: ['my-weekly-progress'], queryFn: async () => (await api.get<{ progress: WeeklyProgress[] }>('/attendances/weekly-progress')).data.progress });
  const calendar = useQuery({ queryKey: ['my-calendar', range.from], queryFn: async () => (await api.get<Calendar>('/calendar', { params: { from: range.from, to: range.to } })).data });
  const classes = useQuery({ queryKey: ['my-activities'], queryFn: async () => (await api.get<PortalActivities>('/activities')).data });
  const fitnessProfile = useQuery({ queryKey: ['my-fitness-profile'], queryFn: async () => (await api.get<{ fitnessProfile: FitnessProfile | null }>('/members/me/fitness-profile')).data.fitnessProfile });
  const progress = useQuery({ queryKey: ['my-progress'], queryFn: async () => (await api.get<{ progress: MemberProgress }>('/members/me/progress')).data.progress });
  const [recordingWeight, setRecordingWeight] = useState(false);
  const [weightValue, setWeightValue] = useState('');
  const [weightDate, setWeightDate] = useState(range.today);

  const membership = memberships.data?.find((item) => item.status === 'active');
  const period = membership?.membership_periods?.find((item) => item.status === 'active') ?? membership?.membership_periods?.[0];
  const streak = streaks.data?.[0];
  const currentWeek = weekly.data?.[0];
  const remaining = daysUntil(period?.ends_on, range.today);
  const lastPayment = payments.data?.[0];
  const validAttendances = attendances.data?.filter((item) => item.status === 'valid') ?? [];
  const hasAttendanceToday = validAttendances.some((item) => item.attendance_date === range.today);
  const todayDate = new Date(`${range.today}T12:00:00`); const todayWeekday = todayDate.getDay() || 7;
  const todayException = calendar.data?.exceptions.find((item) => item.calendar_date === range.today);
  const todaySchedule = todayException ?? calendar.data?.hours.find((item) => item.weekday === todayWeekday);
  const nowTime = new Intl.DateTimeFormat('en-GB', { timeZone: calendar.data?.location.timezone ?? 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const isOpen = Boolean(todaySchedule && todaySchedule.day_mode !== 'closed' && todaySchedule.opens_at && todaySchedule.closes_at && (todaySchedule.closes_at <= todaySchedule.opens_at ? nowTime >= todaySchedule.opens_at || nowTime < todaySchedule.closes_at : nowTime >= todaySchedule.opens_at && nowTime < todaySchedule.closes_at));
  const upcomingClasses = (classes.data?.schedules ?? []).filter((item) => new Date(item.starts_at).getTime() > Date.now());
  const displayName = session?.gymUser?.profiles?.full_name ?? 'Atleta';

  const reserveClass = useMutation({ mutationFn: async (scheduleId: string) => api.post(`/activities/schedules/${scheduleId}/bookings/self`), onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['my-activities'] }) });
  const cancelClass = useMutation({ mutationFn: async (bookingId: string) => api.patch(`/activities/bookings/${bookingId}/cancel-self`, { reason: 'Cancelada desde el portal del miembro' }), onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['my-activities'] }) });
  const joinWaitlist = useMutation({ mutationFn: async (scheduleId: string) => api.post(`/activities/schedules/${scheduleId}/waitlist/self`), onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['my-activities'] }) });
  const leaveWaitlist = useMutation({ mutationFn: async (waitlistId: string) => api.patch(`/activities/waitlist/${waitlistId}/cancel-self`, { reason: 'Salida desde el portal del miembro' }), onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['my-activities'] }) });
  const saveProfile = useMutation({
    mutationFn: async () => {
      if (passwords.current || passwords.next || passwords.confirmation) {
        if (!passwords.current || !passwords.next || !passwords.confirmation) throw new Error('Completa los tres campos de contraseña.');
        if (passwords.next !== passwords.confirmation) throw new Error('Las contraseñas nuevas no coinciden.');
      }
      await api.put('/members/me/profile', { fullName: profile.fullName, phone: profile.phone || null });
      if (passwords.current && passwords.next) await api.put('/auth/change-password', { currentPassword: passwords.current, newPassword: passwords.next });
    },
    onSuccess: async () => { await refresh(); setPasswords({ current: '', next: '', confirmation: '' }); setEditing(false); },
  });
  const saveFitnessProfile = useMutation({
    mutationFn: async (form: FitnessForm) => api.put('/members/me/fitness-profile', {
      weightKg: Number(form.weightKg),
      heightCm: Number(form.heightCm),
      goalType: form.goalType,
      experienceLevel: form.experienceLevel,
      trainingFrequencyPerWeek: Number(form.trainingFrequencyPerWeek),
      availableDays: form.availableDays,
      targetWeightKg: form.targetWeightKg ? Number(form.targetWeightKg) : null,
      preferredTrainingType: form.preferredTrainingType.trim() || null,
      goalHorizonMonths: form.goalHorizonMonths ? Number(form.goalHorizonMonths) : null,
      publicMessage: form.publicMessage.trim() || null,
      showInCommunity: form.showInCommunity,
      showProfilePhoto: form.showProfilePhoto,
      showStreak: form.showStreak,
      showAttendanceCount: form.showAttendanceCount,
      showWeightProgress: form.showWeightProgress,
      showGoal: form.showGoal,
    }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['my-fitness-profile'] }); setFitnessEditing(false); },
  });
  const recordWeight = useMutation({
    mutationFn: async () => api.post('/members/me/weight', { weightKg: Number(weightValue), measuredOn: weightDate }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['my-progress'] }); setRecordingWeight(false); setWeightValue(''); setWeightDate(range.today); },
  });
  const avatarUpload = useMutation({
    mutationFn: async (file: File) => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('La foto debe ser JPG, PNG o WEBP.');
      if (file.size > 5 * 1024 * 1024) throw new Error('La foto no puede superar 5 MB.');
      const prepared = (await api.post<{ upload: { signedUrl: string; path: string } }>('/members/me/avatar-upload', { contentType: file.type })).data.upload;
      const body = new FormData();
      body.append('cacheControl', '3600');
      body.append('', file);
      const uploadResponse = await fetch(prepared.signedUrl, { method: 'PUT', headers: { 'x-upsert': 'false' }, body });
      if (!uploadResponse.ok) throw new Error('No se pudo subir la foto. Intenta nuevamente.');
      return (await api.put<{ profile: { avatar_url: string | null }; avatarPath: string }>('/members/me/avatar', { path: prepared.path })).data;
    },
    onSuccess: async () => { await refresh(); },
  });

  const loading = memberships.isLoading || attendances.isLoading || streaks.isLoading;
  const fitnessSetupRequired = !fitnessProfile.isLoading && !fitnessProfile.isError && !fitnessProfile.data;
  const notices = [
    membership && remaining !== null && remaining > 0 && remaining <= 5 ? `Tu membresía vence en ${remaining} día${remaining === 1 ? '' : 's'}.` : '',
    todaySchedule?.day_mode === 'closed' ? `El gimnasio está cerrado hoy${todayException?.reason ? `: ${todayException.reason}` : '.'}` : '',
    membership?.attendance_mode_snapshot === 'weekly' && currentWeek && !currentWeek.goal_met ? `Te faltan ${Math.max(0, currentWeek.target_attendances - currentWeek.completed_attendances)} asistencias para completar tu meta semanal.` : '',
    streak?.current_streak ? `Mantienes una racha de ${streak.current_streak}. ¡Sigue así!` : '',
  ].filter(Boolean);

  const days = Array.from({ length: range.last }, (_, index) => {
    const day = index + 1; const date = `${range.year}-${String(range.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const weekday = new Date(`${date}T12:00:00`).getDay() || 7;
    const exception = calendar.data?.exceptions.find((item) => item.calendar_date === date);
    const schedule = exception ?? calendar.data?.hours.find((item) => item.weekday === weekday);
    const attendance = attendances.data?.find((item) => item.attendance_date === date);
    return { day, date, mode: schedule?.day_mode ?? 'closed', attendance };
  });
  const firstOffset = (new Date(`${range.from}T12:00:00`).getDay() + 6) % 7;
  const contactPhone = calendar.data?.location.phone ?? calendar.data?.gym.phone;
  const whatsappPhone = calendar.data?.location.whatsapp_phone ?? calendar.data?.gym.whatsapp_phone;
  const whatsapp = whatsappPhone?.replace(/\D/g, '').replace(/^0/, '593');
  const contactEmail = calendar.data?.location.email ?? calendar.data?.gym.email;
  const copy = sectionCopy(section);

  const submitProfile = (event: FormEvent) => { event.preventDefault(); saveProfile.mutate(); };
  const mutationError = reserveClass.error ?? cancelClass.error ?? joinWaitlist.error ?? leaveWaitlist.error;

  return <>
    <div className="portal-view-heading"><div><p className="eyebrow">{copy[0]}</p><h1>{section === 'home' ? `Hola, ${displayName}` : copy[0]}</h1><p>{copy[1]}</p></div>{section !== 'profile' && section !== 'classes' && <Link className="checkin-button" to="/check-in">{hasAttendanceToday ? <CheckCircle2/> : <QrCode/>}<span>{hasAttendanceToday ? 'Entrada registrada hoy' : 'Registrar asistencia'}<small>Escanea el QR de tu sucursal</small></span></Link>}</div>

    {section === 'home' && <>
      <Link className="panel loyalty-home-link" to="/portal/rewards"><Gift/><span><strong>Retos y recompensas</strong><small>Descubre los premios de tu gimnasio y sigue tu avance.</small></span></Link>
      <section className={`today-status ${isOpen ? 'open' : 'closed'}`}><Clock3/><div><strong>{isOpen ? 'Abierto ahora' : 'Cerrado ahora'}</strong><span>{todaySchedule?.day_mode === 'closed' ? todayException?.reason ?? 'No abre hoy' : todaySchedule ? `Horario de hoy: ${shortTime(todaySchedule.opens_at)}–${shortTime(todaySchedule.closes_at)}` : 'Horario no configurado'}</span></div><small>{calendar.data?.location.name}</small></section>
      {notices.length > 0 && <section className="portal-notices"><div className="panel-title"><div><h2>Avisos</h2><p>Información importante para ti</p></div><Bell/></div>{notices.map((notice) => <div className="notice" key={notice}>{notice}</div>)}</section>}
      <div className="portal-grid"><article className="portal-card coverage"><CreditCard/><span>Membresía</span><strong>{loading ? 'Cargando…' : membership?.plans?.name ?? 'Sin membresía activa'}</strong><small>{period ? `${period.starts_on} → ${period.ends_on} · ${membershipCoverageLabel(remaining)}` : 'Sin cobertura vigente'}</small>{membership && <small>{Number(membership.price_at_purchase).toFixed(2)} {membership.currency} · {membership.attendance_mode_snapshot === 'weekly' ? `${membership.weekly_target_snapshot} veces por semana` : 'Asistencia diaria'}</small>}</article><article className="portal-card"><Activity/><span>Asistencias válidas</span><strong>{validAttendances.length}</strong><small>{validAttendances[0] ? `Última: ${validAttendances[0].attendance_date}` : 'Aún no hay registros'}</small></article><article className="portal-card streak"><Flame/><span>Racha actual</span><strong>{streak?.current_streak ?? 0}</strong><small>Mejor racha: {streak?.longest_streak ?? 0}</small></article></div>
      <section className="panel portal-classes portal-home-classes"><div className="panel-title"><div><h2>Próximas clases</h2><p>Reserva desde tu sección de Clases.</p></div><Link className="ghost" to="/portal/classes">Ver todas</Link></div>{upcomingClasses.slice(0, 3).map((item) => <ClassSummary key={item.id} schedule={item}/>)}{!upcomingClasses.length && <div className="empty compact"><Dumbbell/><strong>No hay próximas clases publicadas</strong><span>Cuando el gimnasio programe una actividad aparecerá aquí.</span></div>}</section>
    </>}

    {section === 'classes' && <section className="panel portal-classes"><div className="panel-title"><div><h2>Actividades y clases</h2><p>Reserva las clases incluidas en tu membresía. Las actividades adicionales se pagan en recepción.</p></div><Dumbbell/></div>{mutationError && <div className="alert error">{apiErrorMessage(mutationError)}</div>}{classes.isLoading ? <div className="empty compact"><LoaderCircle className="spin"/><strong>Cargando clases…</strong></div> : upcomingClasses.length ? <div className="portal-class-grid">{upcomingClasses.map((item) => <ClassCard key={item.id} schedule={item} membership={membership} reservePending={reserveClass.isPending} cancelPending={cancelClass.isPending} waitlistPending={joinWaitlist.isPending} leavePending={leaveWaitlist.isPending} onReserve={() => reserveClass.mutate(item.id)} onCancel={() => item.myBooking && cancelClass.mutate(item.myBooking.id)} onJoinWaitlist={() => joinWaitlist.mutate(item.id)} onLeaveWaitlist={() => item.myWaitlist && leaveWaitlist.mutate(item.myWaitlist.id)}/>)}</div> : <div className="empty compact"><Dumbbell/><strong>No hay próximas clases publicadas</strong><span>Cuando el gimnasio programe una actividad aparecerá aquí.</span></div>}</section>}

    {section === 'progress' && <ProgressView range={range} days={days} firstOffset={firstOffset} membership={membership} currentWeek={currentWeek} streak={streak} attendances={attendances.data ?? []} validCount={validAttendances.length} progress={progress.data} progressLoading={progress.isLoading} onRecordWeight={() => { setWeightValue(progress.data?.weights.at(-1)?.weightKg ? String(progress.data.weights.at(-1)!.weightKg) : ''); setWeightDate(range.today); setRecordingWeight(true); }} />}

    {section === 'profile' && <ProfileView displayName={displayName} session={session} membership={membership} period={period} remaining={remaining} payments={payments.data ?? []} lastPayment={lastPayment} calendar={calendar.data} contactPhone={contactPhone} whatsapp={whatsapp} contactEmail={contactEmail} fitnessProfile={fitnessProfile.data} onEdit={() => setEditing(true)} onEditFitness={() => setFitnessEditing(true)} onAvatarFile={(file) => avatarUpload.mutate(file)} avatarUploading={avatarUpload.isPending} avatarUploadError={avatarUpload.error}/>}

    {editing && <div className="modal-backdrop"><form className="modal profile-modal" onSubmit={submitProfile}><div className="modal-heading"><div><p className="eyebrow">TU CUENTA</p><h2>Editar perfil</h2></div><button type="button" className="icon-button" onClick={() => setEditing(false)}><X/></button></div><div className="checkout-form single"><label>Nombre completo<input required minLength={2} maxLength={150} value={profile.fullName} onChange={(event) => setProfile({ ...profile, fullName: event.target.value })}/></label><label>Teléfono<input maxLength={30} value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })}/></label><div className="form-divider"><strong>Actualizar contraseña</strong><span>Déjalo vacío si no deseas cambiarla.</span></div><label>Contraseña actual<input type="password" minLength={8} maxLength={128} autoComplete="current-password" value={passwords.current} onChange={(event) => setPasswords({ ...passwords, current: event.target.value })}/></label><label>Nueva contraseña<input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={passwords.next} onChange={(event) => setPasswords({ ...passwords, next: event.target.value })}/></label><label>Confirmar nueva contraseña<input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={passwords.confirmation} onChange={(event) => setPasswords({ ...passwords, confirmation: event.target.value })}/></label>{saveProfile.isError && <div className="alert error">{saveProfile.error instanceof Error && !('response' in saveProfile.error) ? saveProfile.error.message : apiErrorMessage(saveProfile.error)}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={() => setEditing(false)}>Cancelar</button><button className="primary" disabled={saveProfile.isPending}>{saveProfile.isPending ? 'Guardando…' : 'Guardar cambios'}</button></div></div></form></div>}
    {(fitnessSetupRequired || fitnessEditing) && (
      <FitnessProfileModal
        initial={fitnessProfile.data}
        required={fitnessSetupRequired}
        pending={saveFitnessProfile.isPending}
        error={saveFitnessProfile.error}
        onClose={() => setFitnessEditing(false)}
        onSave={(form) => saveFitnessProfile.mutate(form)}
      />
    )}
    {recordingWeight && <WeightEntryModal value={weightValue} date={weightDate} pending={recordWeight.isPending} error={recordWeight.error} onValueChange={setWeightValue} onDateChange={setWeightDate} onClose={() => { if (!recordWeight.isPending) setRecordingWeight(false); }} onSave={() => recordWeight.mutate()} maxDate={range.today} />}
  </>;
}

function ClassSummary({ schedule }: { schedule: PortalClassSchedule }) {
  return <article className="portal-class-summary"><div className="portal-class-date"><b>{new Date(schedule.starts_at).toLocaleDateString('es-EC', { day: '2-digit' })}</b><span>{new Date(schedule.starts_at).toLocaleDateString('es-EC', { month: 'short' })}</span></div><div className="portal-class-info"><span className="eyebrow">{schedule.location.name}</span><h3>{schedule.activity.name}</h3><p>{new Intl.DateTimeFormat('es-EC', { weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(schedule.starts_at))} · {schedule.instructor?.name ?? 'Instructor por confirmar'}</p><small>{schedule.available} de {schedule.capacity} cupos disponibles</small></div><Link className="primary" to="/portal/classes">Ver clase</Link></article>;
}

function ClassCard({ schedule, membership, reservePending, cancelPending, waitlistPending, leavePending, onReserve, onCancel, onJoinWaitlist, onLeaveWaitlist }: { schedule: PortalClassSchedule; membership?: Membership; reservePending: boolean; cancelPending: boolean; waitlistPending: boolean; leavePending: boolean; onReserve: () => void; onCancel: () => void; onJoinWaitlist: () => void; onLeaveWaitlist: () => void }) {
  const booked = schedule.myBooking?.status === 'reserved';
  const waiting = schedule.myWaitlist?.status === 'waiting' || schedule.myWaitlist?.status === 'offered';
  return <article><div className="portal-class-date"><b>{new Date(schedule.starts_at).toLocaleDateString('es-EC', { day: '2-digit' })}</b><span>{new Date(schedule.starts_at).toLocaleDateString('es-EC', { month: 'short' })}</span></div><div className="portal-class-info"><span className="eyebrow">{schedule.location.name}</span><h3>{schedule.activity.name}</h3><p>{new Intl.DateTimeFormat('es-EC', { weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(schedule.starts_at))} · {schedule.instructor?.name ?? 'Instructor por confirmar'}</p><small>{schedule.available} de {schedule.capacity} cupos disponibles</small></div><div className="portal-class-action">{booked ? <><span className="badge reserved">Programada</span><button className="small-button danger-text" disabled={cancelPending || Boolean(schedule.myBooking?.payment_id)} onClick={onCancel}>{schedule.myBooking?.payment_id ? 'Cancela en recepción' : 'Cancelar'}</button></> : schedule.myBooking?.status === 'attended' ? <span className="badge attended">Asististe</span> : waiting ? <><span className="badge waitlisted">Espera #{schedule.myWaitlist?.position}</span><button className="small-button danger-text" disabled={leavePending} onClick={onLeaveWaitlist}>Salir de lista</button></> : schedule.activity.billing_mode === 'additional_fee' ? <><strong>{money(schedule.activity.price, schedule.activity.currency)}</strong><button className="ghost" disabled>Reserva y paga en recepción</button></> : <button className={schedule.available < 1 ? 'ghost' : 'primary'} disabled={!membership || (schedule.available < 1 ? waitlistPending : reservePending)} onClick={schedule.available < 1 ? onJoinWaitlist : onReserve}>{schedule.available < 1 ? 'Unirme a lista de espera' : !membership ? 'Requiere membresía' : 'Reservar'}</button>}</div></article>;
}

function ProgressView({ range, days, firstOffset, membership, currentWeek, streak, attendances, validCount, progress, progressLoading, onRecordWeight }: { range: ReturnType<typeof monthRange>; days: Array<{ day: number; date: string; mode: string; attendance?: Attendance }>; firstOffset: number; membership?: Membership; currentWeek?: WeeklyProgress; streak?: Streak; attendances: Attendance[]; validCount: number; progress?: MemberProgress; progressLoading: boolean; onRecordWeight: () => void }) {
  const totalAttendances = progress?.totalAttendances ?? validCount;
  const monthAttendances = progress?.currentMonthAttendances ?? attendances.filter((item) => item.status === 'valid' && item.attendance_date.startsWith(`${range.year}-${String(range.month).padStart(2, '0')}`)).length;
  const weekAttendances = progress?.currentWeekAttendances ?? 0;
  const currentStreak = progress?.currentStreak ?? streak?.current_streak ?? 0;
  const longestStreak = progress?.longestStreak ?? streak?.longest_streak ?? 0;
  const monthBuckets = progress?.attendanceByMonth ?? [];
  const maxMonthCount = Math.max(1, ...monthBuckets.map((bucket) => bucket.count));
  const weekBuckets = progress?.attendanceByWeek ?? [];
  const maxWeekCount = Math.max(1, ...weekBuckets.map((bucket) => bucket.count));
  const weightEntries = progress?.weights.slice(-8) ?? [];
  const weightValues = weightEntries.map((entry) => entry.weightKg);
  const minWeight = weightValues.length ? Math.min(...weightValues) : 0;
  const weightSpan = Math.max(1, (weightValues.length ? Math.max(...weightValues) : 0) - minWeight);
  const goalLabel = progress?.goal ? fitnessGoals.find((goal) => goal.value === progress.goal!.goalType)?.label : null;
  return <>
    <section className={`progress-motivation ${progress?.motivation.tone ?? 'neutral'}`}><Flame/><div><strong>{progressLoading ? 'Preparando tu resumen…' : progress?.motivation.title ?? 'Cada entrenamiento cuenta'}</strong><span>{progress?.motivation.message ?? 'Registra tu próxima asistencia para continuar avanzando.'}</span></div></section>
    <div className="portal-progress-stats"><article className="portal-card"><Activity/><span>Asistencias totales</span><strong>{totalAttendances}</strong><small>Registros válidos</small></article><article className="portal-card"><CalendarCheck/><span>Este mes</span><strong>{monthAttendances}</strong><small>Entradas registradas</small></article><article className="portal-card"><Activity/><span>Esta semana</span><strong>{weekAttendances}</strong><small>Desde el lunes</small></article><article className="portal-card streak"><Flame/><span>Racha actual</span><strong>{currentStreak}</strong><small>Mejor racha: {longestStreak}</small></article></div>
    <div className="portal-sections progress-overview"><section className="panel"><div className="panel-title"><div><h2>Asistencia mensual</h2><p>Últimos seis meses</p></div><Activity/></div>{monthBuckets.length ? <div className="attendance-chart" aria-label="Asistencias por mes">{monthBuckets.map((bucket) => <div className="attendance-chart-column" key={bucket.period}><strong>{bucket.count}</strong><div className="attendance-bar-track"><span style={{ height: `${Math.max(8, (bucket.count / maxMonthCount) * 100)}%` }}/></div><small>{bucket.label}</small></div>)}</div> : <div className="empty compact"><Activity/><strong>Reuniendo tu historial</strong></div>}{weekBuckets.length > 0 && <><h3 className="chart-subtitle">Frecuencia semanal</h3><div className="attendance-chart weekly" aria-label="Asistencias por semana">{weekBuckets.map((bucket) => <div className="attendance-chart-column" key={bucket.period}><strong>{bucket.count}</strong><div className="attendance-bar-track"><span style={{ height: `${Math.max(8, (bucket.count / maxWeekCount) * 100)}%` }}/></div><small>{bucket.label}</small></div>)}</div></>}</section><section className="panel weight-progress-panel"><div className="panel-title"><div><h2>Progreso de peso</h2><p>{goalLabel ? `Objetivo: ${goalLabel}` : 'Configura un objetivo para medir tu avance'}</p></div><Dumbbell/></div>{progress?.goal ? <><div className="weight-progress-values"><div><span>Inicial</span><strong>{progress.goal.initialWeightKg} kg</strong></div><div><span>Actual</span><strong>{progress.goal.currentWeightKg} kg</strong></div><div><span>Objetivo</span><strong>{progress.goal.targetWeightKg == null ? '—' : `${progress.goal.targetWeightKg} kg`}</strong></div></div><div className="weight-progress-track"><span style={{ width: `${progress.goal.progressPercent}%` }}/></div><div className="weight-progress-caption"><strong>{progress.goal.progressPercent}% de avance</strong><button className="ghost" onClick={onRecordWeight}>Registrar peso</button></div>{weightEntries.length > 1 && <div className="weight-chart" aria-label="Evolución del peso">{weightEntries.map((entry) => <div className="weight-chart-column" key={entry.id}><strong>{entry.weightKg}</strong><div className="weight-chart-track"><span style={{ height: `${25 + ((entry.weightKg - minWeight) / weightSpan) * 75}%` }}/></div><small>{entry.measuredOn.slice(5)}</small></div>)}</div>}</> : <div className="empty compact"><Dumbbell/><strong>Sin progreso calculable todavía</strong><span>Indica un peso objetivo en tu encuesta para ver el porcentaje de avance.</span><button className="ghost" onClick={onRecordWeight}>Registrar peso</button></div>}</section></div>
    <div className="portal-sections"><section className="panel"><div className="panel-title"><div><h2>Calendario de {new Date(`${range.from}T12:00:00`).toLocaleDateString('es-EC', { month: 'long' })}</h2><p>Verde: asistencia · amarillo: día adicional · rojo: anulada</p></div><CalendarCheck/></div><div className="month-weekdays">{['L','M','X','J','V','S','D'].map((day) => <span key={day}>{day}</span>)}</div><div className="month-grid">{Array.from({ length: firstOffset }, (_, index) => <span key={`empty-${index}`}/>)}{days.map((item) => <div key={item.date} title={`${item.date} · ${item.mode}`} className={`month-day ${item.date === range.today ? 'today' : ''} ${item.attendance?.status ?? item.mode}`}><span>{item.day}</span>{item.attendance && <Activity/>}</div>)}</div></section><section className="panel"><div className="panel-title"><div><h2>Tu objetivo semanal</h2><p>{membership?.attendance_mode_snapshot === 'weekly' ? 'Meta incluida en tu plan' : 'Asistencia en días abiertos'}</p></div><Flame/></div>{membership?.attendance_mode_snapshot === 'weekly' ? <div className="progress-block"><div><strong>{currentWeek?.completed_attendances ?? 0} de {currentWeek?.target_attendances ?? membership.weekly_target_snapshot ?? 0}</strong><span>{currentWeek?.is_grace_week ? 'Semana de gracia' : currentWeek?.goal_met ? 'Meta completada' : 'Sigue avanzando'}</span></div><progress value={currentWeek?.completed_attendances ?? 0} max={currentWeek?.target_attendances ?? membership.weekly_target_snapshot ?? 1}/></div> : <div className="daily-goal"><CalendarCheck/><div><strong>Plan de asistencia diaria</strong><span>Asiste los días obligatorios. Los días adicionales solamente suman.</span></div></div>}</section></div>
    <div className="portal-sections progress-lower"><section className="panel"><div className="panel-title"><div><h2>Historial de peso</h2><p>Mediciones privadas, ordenadas por fecha</p></div><button className="ghost" onClick={onRecordWeight}>Registrar peso</button></div>{progress?.weights.length ? <div className="portal-history">{progress.weights.slice(-6).reverse().map((entry) => <article key={entry.id}><div><strong>{entry.weightKg} kg</strong><small>{entry.measuredOn}</small></div><span className="badge attended">{entry.source === 'onboarding' ? 'Inicial' : 'Registrado'}</span></article>)}</div> : <div className="empty compact"><Dumbbell/><strong>Aún no hay mediciones</strong></div>}</section><section className="panel"><div className="panel-title"><div><h2>Asistencias recientes</h2><p>Tu historial permanece disponible</p></div><Activity/></div>{attendances.length ? <div className="portal-history">{attendances.slice(0, 12).map((item) => <article key={item.id}><div><strong>{item.attendance_date}</strong><small>{item.source === 'qr' ? 'Entrada del miembro' : 'Registrada por recepción'}</small></div><span className={`badge ${item.status}`}>{item.status === 'valid' ? 'Válida' : 'Anulada'}</span></article>)}</div> : <div className="empty compact"><Activity/><strong>Sin asistencias todavía</strong></div>}</section></div>
  </>;
}

type ProfileViewProps = {
  displayName: string;
  session: ReturnType<typeof useAuth>['session'];
  membership?: Membership;
  period?: Period;
  remaining: number | null;
  payments: Payment[];
  lastPayment?: Payment;
  calendar?: Calendar;
  contactPhone?: string | null;
  whatsapp?: string;
  contactEmail?: string | null;
  fitnessProfile?: FitnessProfile | null;
  onEdit: () => void;
  onEditFitness: () => void;
  onAvatarFile: (file: File) => void;
  avatarUploading: boolean;
  avatarUploadError: unknown;
};

function ProfileView({ displayName, session, membership, period, remaining, payments, lastPayment, calendar, contactPhone, whatsapp, contactEmail, fitnessProfile, onEdit, onEditFitness, onAvatarFile, avatarUploading, avatarUploadError }: ProfileViewProps) {
  const goalLabel = fitnessGoals.find((goal) => goal.value === fitnessProfile?.goal_type)?.label ?? 'Sin configurar';
  const privacyItems = [
    ['Aparecer en Comunidad', fitnessProfile?.show_in_community],
    ['Mostrar foto', fitnessProfile?.show_profile_photo],
    ['Mostrar racha', fitnessProfile?.show_streak],
    ['Mostrar asistencias', fitnessProfile?.show_attendance_count],
    ['Mostrar progreso de peso', fitnessProfile?.show_weight_progress],
    ['Mostrar objetivo', fitnessProfile?.show_goal],
  ] as const;
  return <>
    <section className="panel profile-hero-card">
      <div className="profile-identity-large">
        {session?.gymUser?.profiles?.avatar_url ? <img src={session.gymUser.profiles.avatar_url} alt={`Foto de ${displayName}`} /> : <span className="avatar avatar-large">{initials(displayName)}</span>}
        <div><p className="eyebrow">MI PERFIL</p><h2>{displayName}</h2><span>{session?.user.email ?? 'Sin correo'}</span></div>
        <button className="icon-button" onClick={onEdit} aria-label="Editar perfil"><Pencil /></button>
      </div>
      <div className="profile-avatar-actions">
        <label className="ghost profile-avatar-upload" htmlFor="member-avatar-input"><Upload />{avatarUploading ? 'Subiendo…' : 'Cambiar foto'}</label>
        <input id="member-avatar-input" type="file" accept="image/jpeg,image/png,image/webp" disabled={avatarUploading} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onAvatarFile(file); }} />
      </div>
      {avatarUploadError != null && <div className="alert error">{apiErrorMessage(avatarUploadError)}</div>}
      <div className="profile-lines"><div><span>Teléfono</span><strong>{session?.gymUser?.profiles?.phone ?? 'Sin teléfono'}</strong></div><div><span>Estado</span><strong className="success-text">Activo</strong></div></div>
    </section>

    <section className="panel fitness-profile-card">
      <div className="panel-title"><div><h2>Datos deportivos</h2><p>Ayudan a personalizar tu experiencia.</p></div><button className="ghost" onClick={onEditFitness}><Pencil />Editar encuesta</button></div>
    {fitnessProfile ? <><div className="fitness-profile-grid"><div><span>Objetivo</span><strong>{goalLabel}</strong></div><div><span>Peso actual</span><strong>{fitnessProfile.weight_kg} kg</strong></div><div><span>Altura</span><strong>{fitnessProfile.height_cm} cm</strong></div><div><span>Experiencia</span><strong>{experienceLabels[fitnessProfile.experience_level]}</strong></div><div><span>Entrenamiento deseado</span><strong>{fitnessProfile.training_frequency_per_week} veces por semana</strong></div><div><span>Tipo preferido</span><strong>{fitnessProfile.preferred_training_type ?? 'Sin especificar'}</strong></div><div><span>Peso objetivo</span><strong>{fitnessProfile.target_weight_kg == null ? 'Sin especificar' : `${fitnessProfile.target_weight_kg} kg`}</strong></div><div><span>Plazo</span><strong>{fitnessProfile.goal_horizon_months == null ? 'Sin especificar' : `${fitnessProfile.goal_horizon_months} meses`}</strong></div></div><div className="privacy-heading"><ShieldCheck /><div><strong>Privacidad para Comunidad</strong><span>Controla desde aquí qué información compartes con otros miembros.</span></div></div><div className="privacy-list">{privacyItems.map(([label, enabled]) => <div key={label}><span>{label}</span><span className={enabled ? 'enabled' : 'disabled'}>{enabled ? 'Visible' : 'Oculto'}</span></div>)}</div>{fitnessProfile.public_message && <p className="profile-public-message">“{fitnessProfile.public_message}”</p>}</> : <div className="empty compact"><Dumbbell /><strong>Completa tu encuesta</strong><span>Configura tus objetivos para aprovechar el portal.</span></div>}
    </section>

    <div className="portal-sections"><section className="panel"><div className="panel-title"><div><h2>Membresía</h2><p>Tu cobertura actual</p></div><CreditCard /></div><div className="profile-lines"><div><span>Plan</span><strong>{membership?.plans?.name ?? 'Sin membresía activa'}</strong></div><div><span>Vigencia</span><strong>{period ? `${period.starts_on} → ${period.ends_on}` : 'Sin cobertura'}</strong></div><div><span>Estado</span><strong>{membershipCoverageLabel(remaining)}</strong></div><div><span>Asistencia</span><strong>{membership?.attendance_mode_snapshot === 'weekly' ? `${membership.weekly_target_snapshot} por semana` : 'Diaria'}</strong></div></div>{lastPayment && <div className="last-payment"><CreditCard /><div><span>Último pago</span><strong>{money(lastPayment.amount, lastPayment.currency)}</strong><small>{methodLabel(lastPayment.payment_method)} · {new Date(lastPayment.paid_at).toLocaleDateString('es-EC')}</small></div></div>}</section><section className="panel"><div className="panel-title"><div><h2>Contacta al gimnasio</h2><p>{calendar?.gym.name ?? 'Tu gimnasio'}</p></div><MapPin /></div><div className="contact-info"><span><MapPin />{calendar?.location.address ? `${calendar.location.address}, ${calendar.location.city}` : calendar?.location.city ?? 'Dirección no configurada'}</span>{contactPhone && <a href={`tel:${contactPhone}`}><Phone />Llamar</a>}{whatsapp && <a href={`https://wa.me/${whatsapp}`} target="_blank" rel="noreferrer"><MessageCircle />WhatsApp</a>}{contactEmail && <a href={`mailto:${contactEmail}`}><Mail />Correo</a>}</div></section></div>
    {payments.length > 0 && <section className="panel"><div className="panel-title"><div><h2>Pagos registrados</h2><p>Solo consulta informativa</p></div><CreditCard /></div><div className="portal-history">{payments.slice(0, 8).map((item) => <article key={item.id}><div><strong>{money(item.amount, item.currency)}</strong><small>{methodLabel(item.payment_method)} · {new Date(item.paid_at).toLocaleDateString('es-EC')}</small></div><span className={`badge ${item.status}`}>{item.status}</span></article>)}</div></section>}
  </>;
}

function WeightEntryModal({ value, date, maxDate, pending, error, onValueChange, onDateChange, onClose, onSave }: { value: string; date: string; maxDate: string; pending: boolean; error: unknown; onValueChange: (value: string) => void; onDateChange: (value: string) => void; onClose: () => void; onSave: () => void }) {
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(); };
  return <div className="modal-backdrop"><form className="modal weight-modal" onSubmit={submit}><div className="modal-heading"><div><p className="eyebrow">SEGUIMIENTO</p><h2>Registrar peso</h2><p className="form-note">La medición solo será visible para ti.</p></div><button type="button" className="icon-button" onClick={onClose} disabled={pending} aria-label="Cerrar"><X /></button></div><div className="checkout-form single"><label>Peso (kg)<input required type="number" min="20" max="500" step="0.1" value={value} onChange={(event) => onValueChange(event.target.value)} autoFocus /></label><label>Fecha de medición<input required type="date" max={maxDate} value={date} onChange={(event) => onDateChange(event.target.value)} /></label>{error != null && <div className="alert error">{apiErrorMessage(error)}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={onClose} disabled={pending}>Cancelar</button><button className="primary" disabled={pending}>{pending ? 'Guardando…' : 'Guardar medición'}</button></div></div></form></div>;
}

function FitnessProfileModal({ initial, required, pending, error, onClose, onSave }: { initial?: FitnessProfile | null; required: boolean; pending: boolean; error: unknown; onClose: () => void; onSave: (form: FitnessForm) => void }) {
  const [form, setForm] = useState<FitnessForm>(() => fitnessFormFromProfile(initial));
  const update = <K extends keyof FitnessForm>(key: K, value: FitnessForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const toggleDay = (day: number) => update('availableDays', form.availableDays.includes(day) ? form.availableDays.filter((item) => item !== day) : [...form.availableDays, day].sort());
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(form); };
  return <div className="modal-backdrop"><form className="modal fitness-modal" onSubmit={submit}><div className="modal-heading"><div><p className="eyebrow">{required ? 'CONFIGURA TU PERFIL' : 'PERFIL DE ENTRENAMIENTO'}</p><h2>{required ? 'Cuéntanos de ti' : 'Datos deportivos'}</h2><p className="form-note">{required ? 'Solo te tomará un minuto y podrás cambiarlo después.' : 'Actualiza tus objetivos y preferencias cuando quieras.'}</p></div>{!required && <button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar"><X /></button>}</div><div className="fitness-form"><label>Peso actual (kg)<input required type="number" min="20" max="500" step="0.1" value={form.weightKg} onChange={(event) => update('weightKg', event.target.value)} /></label><label>Altura (cm)<input required type="number" min="80" max="260" step="0.1" value={form.heightCm} onChange={(event) => update('heightCm', event.target.value)} /></label><label>Objetivo principal<select value={form.goalType} onChange={(event) => update('goalType', event.target.value as FitnessGoal)}>{fitnessGoals.map((goal) => <option key={goal.value} value={goal.value}>{goal.label}</option>)}</select></label><label>Nivel de experiencia<select value={form.experienceLevel} onChange={(event) => update('experienceLevel', event.target.value as FitnessForm['experienceLevel'])}>{Object.entries(experienceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Frecuencia deseada (días/semana)<input required type="number" min="1" max="14" value={form.trainingFrequencyPerWeek} onChange={(event) => update('trainingFrequencyPerWeek', event.target.value)} /></label><label>Peso objetivo (kg)<input type="number" min="20" max="500" step="0.1" placeholder="Opcional" value={form.targetWeightKg} onChange={(event) => update('targetWeightKg', event.target.value)} /></label><label>Tipo de entrenamiento preferido<input maxLength={80} placeholder="Ej. fuerza, boxeo…" value={form.preferredTrainingType} onChange={(event) => update('preferredTrainingType', event.target.value)} /></label><label>Plazo aproximado<select value={form.goalHorizonMonths} onChange={(event) => update('goalHorizonMonths', event.target.value)}><option value="">Sin definir</option>{[1, 3, 6, 12, 24, 36].map((months) => <option key={months} value={months}>{months} {months === 1 ? 'mes' : 'meses'}</option>)}</select></label><div className="days-picker"><strong>Días disponibles</strong>{dayLabels.map((label, index) => <label key={label}><input type="checkbox" checked={form.availableDays.includes(index + 1)} onChange={() => toggleDay(index + 1)} />{label}</label>)}</div><label className="wide">Mensaje público opcional<textarea maxLength={160} placeholder="Ej. Busco mejorar fuerza" value={form.publicMessage} onChange={(event) => update('publicMessage', event.target.value)} /></label><fieldset className="privacy-settings"><legend><ShieldCheck /> Privacidad (todo oculto por defecto)</legend>{([['showInCommunity', 'Aparecer en Comunidad'], ['showProfilePhoto', 'Mostrar foto'], ['showStreak', 'Mostrar racha'], ['showAttendanceCount', 'Mostrar asistencias'], ['showWeightProgress', 'Mostrar progreso de peso'], ['showGoal', 'Mostrar objetivo']] as Array<[keyof FitnessForm, string]>).map(([key, label]) => <label key={String(key)}><input type="checkbox" checked={Boolean(form[key])} onChange={(event) => update(key, event.target.checked as FitnessForm[typeof key])} />{label}</label>)}</fieldset>{error != null && <div className="alert error">{apiErrorMessage(error)}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={onClose} disabled={required || pending}>Cancelar</button><button className="primary" disabled={pending}>{pending ? 'Guardando…' : 'Guardar perfil'}</button></div></div></form></div>;
}
