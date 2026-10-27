import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bell, CalendarCheck, CheckCircle2, ChevronRight, Clock3, CreditCard, Dumbbell, Flame, Gift, LoaderCircle, Pencil, ShieldCheck, UserRound, UsersRound, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage } from '../services/api';
import { MemberSocialProfile, SocialPrivacySettings } from '../components/MemberSocialProfile';
import { FriendRequestsPreference } from '../components/MemberFriendships';
import { MyTrainingSocial, PokePreference } from '../components/MemberTrainingSocial';
import { PrivacySwitch } from '../components/PrivacySwitch';
import { ProfileDialog } from '../components/ProfileDialog';
import { AttendanceQrCard } from '../components/AttendanceQrCard';
import { ClassBookingConditions } from '../components/ClassBookingConditions';
import { ClassWaitlistOffer } from '../components/ClassWaitlistOffer';
import { classWaitlistPollInterval, refreshClassQueries, waitlistExitNotice, type ClassWaitlistEntry } from '../utils/classWaitlist';
import { classPaymentLabel, type ClassBookingEconomics } from '../utils/classBookingEconomics';
import '../profile-header.css';
import '../progress.css';
import { selectMembershipCoverage } from '../utils/membershipCoverage';

type PortalSection = 'home' | 'classes' | 'progress' | 'profile' | 'settings';
type Period = { starts_on: string; ends_on: string; status: string };
type Membership = { id: string; status: string; price_at_purchase: number; currency: string; attendance_mode_snapshot: 'daily' | 'weekly'; weekly_target_snapshot?: number | null; plans?: { name?: string }; membership_periods?: Period[] };
type Attendance = { id: string; attendance_date: string; checked_in_at: string; status: 'valid' | 'voided'; source: string; counts_toward_streak: boolean };
type Streak = { status: string; current_streak: number; longest_streak: number; last_attendance_date?: string | null };
type GymAnnouncement = { id: string; location_id: string | null; body: string; created_at: string };
type WeeklyProgress = { id: string; week_starts_on: string; week_ends_on: string; target_attendances: number; completed_attendances: number; goal_met: boolean; is_grace_week: boolean };
type Hour = { weekday: number; opens_at: string | null; closes_at: string | null; day_mode: 'required' | 'bonus' | 'closed' };
type Exception = { calendar_date: string; opens_at: string | null; closes_at: string | null; day_mode: 'required' | 'bonus' | 'closed'; reason?: string | null };
type Calendar = { gym: { name: string; email?: string | null; phone?: string | null; whatsapp_phone?: string | null; timezone: string }; location: { name: string; address?: string | null; city: string; timezone: string; email?: string | null; phone?: string | null; whatsapp_phone?: string | null }; hours: Hour[]; exceptions: Exception[] };
type PortalClassBooking = ClassBookingEconomics & { id: string; status: 'reserved' | 'attended' | 'cancelled' | 'no_show'; payment_id?: string | null };
type PortalClassSchedule = { id: string; starts_at: string; ends_at: string; status: string; occupied: number; capacity: number; available: number; isFull: boolean; offeredCount?: number; activity: { name: string; description?: string | null; billing_mode: 'included' | 'additional_fee'; price: number; currency: string; duration_minutes: number; is_active?: boolean } | null; location: { name: string; is_active?: boolean } | null; referenceState?: string; instructor?: { name: string } | null; myBooking?: PortalClassBooking | null; myWaitlist?: ClassWaitlistEntry | null };
type PortalActivities = { schedules: PortalClassSchedule[]; serverTime?: string; offersEnabled?: boolean; receivedAt?: number };
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
function fitnessPayload(form:FitnessForm){return {weightKg:Number(form.weightKg),heightCm:Number(form.heightCm),goalType:form.goalType,experienceLevel:form.experienceLevel,trainingFrequencyPerWeek:Number(form.trainingFrequencyPerWeek),availableDays:form.availableDays,targetWeightKg:form.targetWeightKg?Number(form.targetWeightKg):null,preferredTrainingType:form.preferredTrainingType.trim()||null,goalHorizonMonths:form.goalHorizonMonths?Number(form.goalHorizonMonths):null,publicMessage:form.publicMessage.trim()||null,showInCommunity:form.showInCommunity,showProfilePhoto:form.showProfilePhoto,showStreak:form.showStreak,showAttendanceCount:form.showAttendanceCount,showWeightProgress:form.showWeightProgress,showGoal:form.showGoal};}
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

function membershipCoverageLabel(remaining: number | null, period?: Period) {
  if (period && period.starts_on > localDate()) return `Comienza el ${period.starts_on}`;
  if (remaining === null) return 'Sin fecha de cobertura';
  if (remaining > 0) return `${remaining} días restantes`;
  if (remaining === 0) return 'Vigente hasta hoy';
  return 'Cobertura vencida';
}

function sectionCopy(section: PortalSection) {
  return {
    home: ['Tu centro de entrenamiento', 'Todo lo importante, de un vistazo.'],
    classes: ['Entrena con intención', 'Consulta horarios y reserva tus próximas clases.'],
    progress: ['La constancia construye resultados', 'Mira tus asistencias y el avance de tu rutina.'],
    profile: ['Tu información, siempre contigo', 'Administra tus datos y consulta tu cobertura.'],
    settings: ['Configuración', 'Tu cuenta, privacidad y datos deportivos.'],
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
  const memberships = useQuery({ queryKey: ['my-memberships', session?.gymUser?.id], queryFn: async () => (await api.get<{ memberships: Membership[] }>('/memberships')).data.memberships, enabled: Boolean(session?.gymUser) });
  const announcements = useQuery({ queryKey: ['gym-announcements', session?.gymUser?.gym_id, session?.gymUser?.default_location_id], queryFn: async () => (await api.get<{ announcements: GymAnnouncement[] }>('/announcements')).data.announcements, enabled: section === 'home' && Boolean(session?.gymUser), refetchInterval: 60_000 });
  const attendances = useQuery({ queryKey: ['my-attendances'], queryFn: async () => (await api.get<{ attendances: Attendance[] }>('/attendances')).data.attendances });
  const streaks = useQuery({ queryKey: ['my-streak'], queryFn: async () => (await api.get<{ streaks: Streak[] }>('/attendances/streaks')).data.streaks });
  const weekly = useQuery({ queryKey: ['my-weekly-progress'], queryFn: async () => (await api.get<{ progress: WeeklyProgress[] }>('/attendances/weekly-progress')).data.progress });
  const calendar = useQuery({ queryKey: ['my-calendar', range.from], queryFn: async () => (await api.get<Calendar>('/calendar', { params: { from: range.from, to: range.to } })).data });
  const [classHistoryMonth,setClassHistoryMonth] = useState(range.from.slice(0,7));
  const historyClasses = useQuery({queryKey:['my-activities','history',classHistoryMonth],enabled:section==='classes',queryFn:async()=>{
    const start=new Date(classHistoryMonth+'-01T00:00:00Z'); const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);end.setTime(end.getTime()-1);
    return (await api.get<PortalActivities>('/activities',{params:{from:start.toISOString(),to:end.toISOString()}})).data;
  }});
  const classes = useQuery({
    queryKey: ['my-activities'],
    queryFn: async () => ({ ...(await api.get<PortalActivities>('/activities')).data, receivedAt: performance.now() }),
    refetchInterval: query => (section === 'home' || section === 'classes') && query.state.data?.offersEnabled !== false
      ? classWaitlistPollInterval(query.state.data?.schedules) : false,
    refetchIntervalInBackground: false,
  });
  const fitnessProfile = useQuery({ queryKey: ['my-fitness-profile'], queryFn: async () => (await api.get<{ fitnessProfile: FitnessProfile | null }>('/members/me/fitness-profile')).data.fitnessProfile });
  const progress = useQuery({ queryKey: ['my-progress'], queryFn: async () => (await api.get<{ progress: MemberProgress }>('/members/me/progress')).data.progress });
  const [recordingWeight, setRecordingWeight] = useState(false);
  const [weightValue, setWeightValue] = useState('');
  const [weightDate, setWeightDate] = useState(range.today);

  const { membership, period } = selectMembershipCoverage(memberships.data ?? [], range.today);
  const streak = streaks.data?.[0];
  const currentWeek = weekly.data?.[0];
  const remaining = daysUntil(period?.ends_on, range.today);
  const validAttendances = attendances.data?.filter((item) => item.status === 'valid') ?? [];
  const hasAttendanceToday = validAttendances.some((item) => item.attendance_date === range.today);
  const todayDate = new Date(`${range.today}T12:00:00`); const todayWeekday = todayDate.getDay() || 7;
  const todayException = calendar.data?.exceptions.find((item) => item.calendar_date === range.today);
  const todaySchedule = todayException ?? calendar.data?.hours.find((item) => item.weekday === todayWeekday);
  const nowTime = new Intl.DateTimeFormat('en-GB', { timeZone: calendar.data?.location.timezone ?? 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const isOpen = Boolean(todaySchedule && todaySchedule.day_mode !== 'closed' && todaySchedule.opens_at && todaySchedule.closes_at && (todaySchedule.closes_at <= todaySchedule.opens_at ? nowTime >= todaySchedule.opens_at || nowTime < todaySchedule.closes_at : nowTime >= todaySchedule.opens_at && nowTime < todaySchedule.closes_at));
  const upcomingClasses = (classes.data?.schedules ?? []).filter((item) => new Date(item.starts_at).getTime() > Date.now());
  const upcomingReservations = upcomingClasses.filter((item) => item.myBooking?.status === 'reserved' || ((classReferenceIssue(item) || item.status !== 'scheduled') && (item.myBooking || item.myWaitlist)));
  const availableClasses = upcomingClasses.filter((item) => !upcomingReservations.includes(item));
  const displayName = session?.gymUser?.profiles?.full_name ?? 'Atleta';

  const [classActionError, setClassActionError] = useState<unknown>(null);
  const [classNotice, setClassNotice] = useState<string | null>(null);
  const refreshClasses = () => refreshClassQueries(queryClient);
  const classActionCallbacks = {
    onMutate: () => { setClassActionError(null); setClassNotice(null); },
    onError: (error: unknown) => setClassActionError(error),
    // A conflict may have expired an offer and promoted the next member in SQL.
    onSettled: refreshClasses,
  };
  const reserveClass = useMutation({ mutationFn: async (scheduleId: string) => api.post(`/activities/schedules/${scheduleId}/bookings/self`), ...classActionCallbacks, onSuccess: () => setClassNotice('Reserva confirmada. Consulta sus condiciones y pago.') });
  const cancelClass = useMutation({ mutationFn: async (bookingId: string) => api.patch(`/activities/bookings/${bookingId}/cancel-self`, { reason: 'Cancelada desde el portal del miembro' }), ...classActionCallbacks, onSuccess: () => setClassNotice('Reserva cancelada. Disponibilidad actualizada.') });
  const joinWaitlist = useMutation({ mutationFn: async (scheduleId: string) => api.post(`/activities/schedules/${scheduleId}/waitlist/self`), ...classActionCallbacks, onSuccess: () => setClassNotice('Ya estás en la lista de espera. Tu posición se consulta al servidor.') });
  const leaveWaitlist = useMutation({ mutationFn: async (waitlistId: string) => api.patch<{ waitlist: { state?: string } }>(`/activities/waitlist/${waitlistId}/cancel-self`, { reason: 'Salida o rechazo desde el portal del miembro' }), ...classActionCallbacks, onSuccess: response => setClassNotice(waitlistExitNotice(response.data.waitlist.state)) });
  const acceptOffer = useMutation({ mutationFn: async (offerId: string) => api.post(`/activities/waitlist/offers/${offerId}/accept-self`), ...classActionCallbacks, onSuccess: () => setClassNotice('Cupo aceptado. Tu reserva y sus condiciones están confirmadas.') });
  const refreshExpiredOffer = () => {
    setClassNotice('El plazo visual de una oferta terminó. Consultando su estado real…');
    void refreshClasses().then(() => {
      setClassNotice(queryClient.getQueryState(['my-activities'])?.status === 'error' ? null
        : 'Estado actualizado. Si la oferta ya no aparece, dejó de estar disponible; puedes consultar las opciones actuales de la clase.');
    }).catch(error => { setClassNotice(null); setClassActionError(error); });
  };
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
    mutationFn: async (form: FitnessForm) => {
      const payload: Partial<ReturnType<typeof fitnessPayload>> = fitnessPayload(form);
      // Privacy is supplied only at creation; sports edits never resend consent.
      if (!fitnessSetupRequired) for (const [key] of privacyOptions) delete payload[key];
      return api.put('/members/me/fitness-profile', payload);
    },
    onSuccess: async () => { await Promise.all(['my-fitness-profile','member-social-profile','member-community','my-progress'].map(key=>queryClient.invalidateQueries({queryKey:[key]}))); setFitnessEditing(false); },
  });
  const savePrivacy=useMutation({mutationFn:async({key,value}:{key:PrivacyKey;value:boolean})=>{
    return api.patch('/members/me/privacy', {key,value});
  },onSettled:()=>Promise.all(['my-fitness-profile','member-social-profile','member-community','member-friendship','member-friends','member-training-social'].map(key=>queryClient.invalidateQueries({queryKey:[key]})))});
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
    onSuccess: async () => { await refresh(); await queryClient.invalidateQueries({ queryKey: ['member-social-profile'] }); },
  });

  const loading = memberships.isLoading || attendances.isLoading || streaks.isLoading;
  const fitnessSetupRequired = !fitnessProfile.isLoading && !fitnessProfile.isError && !fitnessProfile.data;
  const notices = [
    membership && period && period.starts_on <= range.today && remaining !== null && remaining > 0 && remaining <= 5 ? `Tu membresía vence en ${remaining} día${remaining === 1 ? '' : 's'}.` : '',
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
  const copy = sectionCopy(section);
  const showHeadingCheckIn = section !== 'profile' && section !== 'classes' && section !== 'settings';

  const submitProfile = (event: FormEvent) => { event.preventDefault(); saveProfile.mutate(); };
  const mutationError = classActionError;

  return <>
    {section !== 'profile' && section !== 'settings' && <div className={`portal-view-heading ${section==='progress'?'progress-view-heading':section==='home'?'home-view-heading':''}`}><div><p className="eyebrow">{copy[0]}</p><h1>{section === 'home' ? `Hola, ${displayName}` : section==='progress'?'Tu progreso':copy[0]}</h1><p>{copy[1]}</p></div>{showHeadingCheckIn && <AttendanceQrCard hasAttendanceToday={hasAttendanceToday}/>}</div>}
    {section === 'home' && <div className="portal-home-content">
      <div className="home-quick-actions"><Link className="panel loyalty-home-link" to="/portal/payments"><CreditCard aria-hidden="true"/><span><strong>Membresía y pagos</strong><small>Renueva, presenta tu comprobante y consulta el resultado.</small></span><ChevronRight aria-hidden="true"/></Link>
      <Link className="panel loyalty-home-link" to="/portal/rewards"><Gift aria-hidden="true"/><span><strong>Retos y recompensas</strong><small>Descubre los premios de tu gimnasio y sigue tu avance.</small></span><ChevronRight aria-hidden="true"/></Link></div>
      <section className={`today-status ${isOpen ? 'open' : 'closed'}`}><Clock3/><div><strong>{isOpen ? 'Abierto ahora' : 'Cerrado ahora'}</strong><span>{todaySchedule?.day_mode === 'closed' ? todayException?.reason ?? 'No abre hoy' : todaySchedule ? `Horario de hoy: ${shortTime(todaySchedule.opens_at)}–${shortTime(todaySchedule.closes_at)}` : 'Horario no configurado'}</span></div><small>{calendar.data?.location.name}</small></section>
      {Boolean(announcements.data?.length) && <section className="portal-notices gym-announcement-notices"><div className="panel-title"><Bell aria-hidden="true"/><div><h2>Avisos de tu gimnasio</h2><p>Información compartida por el owner</p></div></div><HomeAnnouncement announcement={announcements.data![0]!}/>{announcements.data!.length>1 && <details className="home-more-announcements"><summary>Ver todos los avisos ({announcements.data!.length})<ChevronRight aria-hidden="true"/></summary>{announcements.data!.slice(1).map(announcement=><HomeAnnouncement key={announcement.id} announcement={announcement}/>)}</details>}</section>}
      {announcements.isError && <div className="alert error">No se pudieron cargar los avisos del gimnasio.</div>}
      {notices.length > 0 && <section className="portal-notices"><div className="panel-title"><div><h2>Avisos</h2><p>Información importante para ti</p></div><Bell/></div>{notices.map((notice) => <div className="notice" key={notice}>{notice}</div>)}</section>}
      <div className="portal-grid home-summary-grid"><article className="portal-card coverage"><CreditCard aria-hidden="true"/><div className="home-membership-copy"><span>Membresía</span><strong>{loading ? 'Cargando…' : membership?.plans?.name ?? 'Sin membresía activa'}</strong><small>{period ? `${period.starts_on} → ${period.ends_on}` : 'Sin cobertura vigente'}</small>{period && <span className="home-coverage-chip">{membershipCoverageLabel(remaining, period)}</span>}{membership && <small>{Number(membership.price_at_purchase).toFixed(2)} {membership.currency} · {membership.attendance_mode_snapshot === 'weekly' ? `${membership.weekly_target_snapshot} veces por semana` : 'Asistencia diaria'}</small>}</div></article><article className="portal-card home-activity-stat"><Activity aria-hidden="true"/><span>Asistencias válidas</span><strong>{validAttendances.length}</strong><small>{validAttendances[0] ? `Última: ${validAttendances[0].attendance_date}` : 'Aún no hay registros'}</small></article><article className="portal-card streak home-activity-stat"><Flame aria-hidden="true"/><span>Racha actual</span><strong>{streak?.current_streak ?? 0}</strong><small>Mejor racha: {streak?.longest_streak ?? 0}</small></article></div>
      <section className="panel portal-classes portal-home-classes"><div className="panel-title"><CalendarCheck aria-hidden="true"/><div><h2>Próximas clases</h2><p>Reserva desde tu sección de Clases.</p></div><Link className="ghost" to="/portal/classes">Ver todas<ChevronRight aria-hidden="true"/></Link></div><div className="home-class-grid">{!classes.isLoading && !classes.isError && upcomingClasses.slice(0, 3).map((item) => <ClassSummary key={item.id} schedule={item}/>)}</div>{classes.isLoading && <p role="status">Consultando cupos…</p>}{classes.isError && <p role="alert">No se pudo consultar la disponibilidad. <button onClick={() => classes.refetch()}>Reintentar</button></p>}{!classes.isLoading && !classes.isError && !upcomingClasses.length && <div className="empty compact"><Dumbbell/><strong>No hay próximas clases publicadas</strong><span>Cuando el gimnasio programe una actividad aparecerá aquí.</span></div>}</section>
    </div>}

    {section === 'classes' && <section className="panel portal-classes"><div className="panel-title"><div><h2>Actividades y clases</h2><p>Reserva desde aquí. Las actividades adicionales se pagan presencialmente en recepción.</p></div><Dumbbell/></div>{Boolean(mutationError) && <div className="alert error" role="alert">{apiErrorMessage(mutationError)}</div>}{classNotice && <p role="status">{classNotice}</p>}{classes.isError ? <p role="alert">No se pudo consultar la disponibilidad. <button onClick={() => classes.refetch()}>Reintentar</button></p> : classes.isLoading ? <div className="empty compact"><LoaderCircle className="spin"/><strong>Cargando clases…</strong></div> : upcomingClasses.length ? <><div className="portal-class-section-heading"><strong>Mis reservas</strong><span>{upcomingReservations.length ? 'Tu cupo ya está guardado.' : 'Todavía no tienes próximas reservas.'}</span></div>{upcomingReservations.length > 0 && <div className="portal-class-grid">{upcomingReservations.map((item) => <ClassCard key={item.id} schedule={item} membership={membership} reservePending={reserveClass.isPending} cancelPending={cancelClass.isPending} waitlistPending={joinWaitlist.isPending} leavePending={leaveWaitlist.isPending} offerPending={acceptOffer.isPending} serverTime={classes.data?.serverTime} receivedAt={classes.data?.receivedAt} offersEnabled={classes.data?.offersEnabled} onAcceptOffer={offerId => acceptOffer.mutate(offerId)} onOfferRefresh={refreshExpiredOffer} onReserve={() => reserveClass.mutate(item.id)} onCancel={() => item.myBooking && cancelClass.mutate(item.myBooking.id)} onJoinWaitlist={() => joinWaitlist.mutate(item.id)} onLeaveWaitlist={() => item.myWaitlist && leaveWaitlist.mutate(item.myWaitlist.id)}/>)}</div>}<div className="portal-class-section-heading"><strong>Clases disponibles</strong><span>Elige una fecha y confirma tu cupo.</span></div><div className="portal-class-grid">{availableClasses.map((item) => <ClassCard key={item.id} schedule={item} membership={membership} reservePending={reserveClass.isPending} cancelPending={cancelClass.isPending} waitlistPending={joinWaitlist.isPending} leavePending={leaveWaitlist.isPending} offerPending={acceptOffer.isPending} serverTime={classes.data?.serverTime} receivedAt={classes.data?.receivedAt} offersEnabled={classes.data?.offersEnabled} onAcceptOffer={offerId => acceptOffer.mutate(offerId)} onOfferRefresh={refreshExpiredOffer} onReserve={() => reserveClass.mutate(item.id)} onCancel={() => item.myBooking && cancelClass.mutate(item.myBooking.id)} onJoinWaitlist={() => joinWaitlist.mutate(item.id)} onLeaveWaitlist={() => item.myWaitlist && leaveWaitlist.mutate(item.myWaitlist.id)}/>)}</div></> : <div className="empty compact"><Dumbbell/><strong>No hay próximas clases publicadas</strong><span>Cuando el gimnasio programe una actividad aparecerá aquí.</span></div>}</section>}
    {section === 'classes' && <section className="panel portal-classes"><h2>Historial de mis clases</h2><label>Mes <input type="month" value={classHistoryMonth} onChange={e=>{if(e.target.value)setClassHistoryMonth(e.target.value);}}/></label>
    {historyClasses.isLoading ? <p>Cargando historial…</p> : historyClasses.isError ? <p role="alert">No se pudo cargar el historial. <button onClick={()=>historyClasses.refetch()}>Reintentar</button></p> : <div className="portal-class-grid">{(historyClasses.data?.schedules??[]).filter(item=>(item.myBooking||item.myWaitlist)&&(new Date(item.starts_at).getTime()<=Date.now()||item.status!=='scheduled')).map(item=><UnavailableClass key={item.id} schedule={item}/>)}</div>}</section>}

    {section === 'progress' && <ProgressView range={range} days={days} firstOffset={firstOffset} membership={membership} currentWeek={currentWeek} streak={streak} attendances={attendances.data ?? []} validCount={validAttendances.length} progress={progress.data} progressLoading={progress.isLoading} onRecordWeight={() => { setWeightValue(progress.data?.weights.at(-1)?.weightKg ? String(progress.data.weights.at(-1)!.weightKg) : ''); setWeightDate(range.today); setRecordingWeight(true); }} />}

    {section === 'profile' && <MemberSocialProfile owner={{name:displayName,avatarUrl:session?.gymUser?.profiles?.avatar_url??null,onEditAccount:()=>setEditing(true),onAvatarFile:file=>avatarUpload.mutate(file),avatarUploading:avatarUpload.isPending,avatarError:avatarUpload.error,activity:<><ProfileGoalSummary profile={fitnessProfile.data} progress={progress.data}/><MyTrainingSocial/></>}}/>}
    {section === 'settings'&&<ProfileSettingsView session={session} profile={fitnessProfile.data} onEdit={()=>setEditing(true)} onEditFitness={()=>setFitnessEditing(true)} onPrivacySave={(key,value)=>savePrivacy.mutate({key,value})} pending={savePrivacy.isPending} variables={savePrivacy.variables} error={savePrivacy.error} saved={savePrivacy.isSuccess}/>}

    {editing && <ProfileDialog title="Editar cuenta" onClose={()=>setEditing(false)} busy={saveProfile.isPending}><form className="profile-modal" onSubmit={submitProfile}><div className="checkout-form single"><label>Nombre completo<input required minLength={2} maxLength={150} value={profile.fullName} onChange={(event) => setProfile({ ...profile, fullName: event.target.value })}/></label><label>Teléfono<input maxLength={30} value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })}/></label><div className="form-divider"><strong>Actualizar contraseña</strong><span>Déjalo vacío si no deseas cambiarla.</span></div><label>Contraseña actual<input type="password" minLength={8} maxLength={128} autoComplete="current-password" value={passwords.current} onChange={(event) => setPasswords({ ...passwords, current: event.target.value })}/></label><label>Nueva contraseña<input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={passwords.next} onChange={(event) => setPasswords({ ...passwords, next: event.target.value })}/></label><label>Confirmar nueva contraseña<input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={passwords.confirmation} onChange={(event) => setPasswords({ ...passwords, confirmation: event.target.value })}/></label>{saveProfile.isError && <div className="alert error">{saveProfile.error instanceof Error && !('response' in saveProfile.error) ? saveProfile.error.message : apiErrorMessage(saveProfile.error)}</div>}<div className="modal-actions"><button type="button" className="ghost" disabled={saveProfile.isPending} onClick={() => setEditing(false)}>Cancelar</button><button className="primary" disabled={saveProfile.isPending}>{saveProfile.isPending ? 'Guardando…' : 'Guardar cambios'}</button></div></div></form></ProfileDialog>}
    {(fitnessSetupRequired || fitnessEditing) && (
      <div className={fitnessSetupRequired?'':'sports-edit-only'}><FitnessProfileModal
        initial={fitnessProfile.data}
        required={fitnessSetupRequired}
        pending={saveFitnessProfile.isPending}
        error={saveFitnessProfile.error}
        onClose={() => setFitnessEditing(false)}
        onSave={(form) => saveFitnessProfile.mutate(form)}
      /></div>
    )}
    {recordingWeight && <WeightEntryModal value={weightValue} date={weightDate} pending={recordWeight.isPending} error={recordWeight.error} onValueChange={setWeightValue} onDateChange={setWeightDate} onClose={() => { if (!recordWeight.isPending) setRecordingWeight(false); }} onSave={() => recordWeight.mutate()} maxDate={range.today} />}
  </>;
}

function HomeAnnouncement({ announcement }: { announcement: GymAnnouncement }) {
  return <article className="gym-announcement"><small>{announcement.location_id ? 'Tu sucursal' : 'Todas las sucursales'} · {new Date(announcement.created_at).toLocaleDateString('es-EC')}</small><p>{announcement.body}</p></article>;
}

function classReferenceIssue(s: PortalClassSchedule) {
  if (!s.activity || !s.location) return 'Información de sesión incompleta. Consulta con recepción.';
  if (s.activity.is_active === false && s.location.is_active === false) return 'Actividad y sucursal no disponibles. No se aceptan nuevas reservas.';
  if (s.activity.is_active === false) return 'Actividad no disponible. No se aceptan nuevas reservas.';
  if (s.location.is_active === false) return 'Sucursal no disponible. No se aceptan nuevas reservas.';
  return null;
}
function UnavailableClass({schedule,children}:{schedule:PortalClassSchedule;children?:import('react').ReactNode}) {
  const labels: Record<string,string> = {scheduled:'Programada',completed:'Finalizada',cancelled:'Cancelada',reserved:'Confirmada',attended:'Asististe',no_show:'No asististe',waiting:'En espera',offered:'Ofrecida',expired:'Vencida',included:'Incluido',pending:'Pendiente',confirmed:'Confirmado',refunded:'Reembolsado',registered:'Registrado',resolution_required:'Condiciones pendientes de resolución en recepción',voided:'Anulado',failed:'Fallido'};
  return <article className="portal-class-summary"><div className="portal-class-info"><span className="eyebrow">{schedule.location?.name ?? 'Referencia de sucursal ausente'}</span><h3>{schedule.activity?.name ?? 'Referencia de actividad ausente'}</h3><p>{new Date(schedule.starts_at).toLocaleString('es-EC')} – {new Date(schedule.ends_at).toLocaleTimeString('es-EC')} · {schedule.instructor?.name ?? 'Instructor por confirmar'}</p><p>Sesión: {labels[schedule.status] ?? schedule.status}</p>{classReferenceIssue(schedule) && <p role="status">{classReferenceIssue(schedule)}</p>}{schedule.myBooking && <p>Reserva: {labels[schedule.myBooking.status] ?? schedule.myBooking.status}</p>}{schedule.myBooking?.payment_state && <p>Pago: {labels[schedule.myBooking.payment_state] ?? schedule.myBooking.payment_state}</p>}{schedule.myBooking && <><ClassBookingConditions booking={schedule.myBooking}/>{schedule.myBooking.payment_state && <p>{classPaymentLabel(schedule.myBooking)}</p>}</>}{schedule.myWaitlist && <p>Lista de espera: {labels[schedule.myWaitlist.status] ?? schedule.myWaitlist.status}</p>}{children}</div></article>;
}
function ClassSummary({ schedule }: { schedule: PortalClassSchedule }) {
  if (!schedule.activity || !schedule.location || classReferenceIssue(schedule) || schedule.status !== 'scheduled') return <UnavailableClass schedule={schedule}><Link to="/portal/classes">Ver clase</Link></UnavailableClass>;
  return <article className="portal-class-summary"><div className="portal-class-date"><b>{new Date(schedule.starts_at).toLocaleDateString('es-EC', { day: '2-digit' })}</b><span>{new Date(schedule.starts_at).toLocaleDateString('es-EC', { month: 'short' })}</span></div><div className="portal-class-info"><span className="eyebrow">{schedule.location.name}</span><h3>{schedule.activity.name}</h3><p><Clock3 aria-hidden="true"/>{new Intl.DateTimeFormat('es-EC', { weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(schedule.starts_at))}</p><p><UserRound aria-hidden="true"/>{schedule.instructor?.name ?? 'Instructor por confirmar'}</p><small><UsersRound aria-hidden="true"/>{schedule.available} de {schedule.capacity} cupos disponibles</small>{schedule.myWaitlist && <small>{schedule.myWaitlist.status === 'offered' ? 'Se liberó un cupo para ti · abre Clases para responder' : `Lista de espera · posición #${schedule.myWaitlist.position}`}</small>}</div><Link className="primary" to="/portal/classes">Ver clase<ChevronRight aria-hidden="true"/></Link></article>;
}

function ClassCard({ schedule, membership, reservePending, cancelPending, waitlistPending, leavePending, offerPending, serverTime, receivedAt, offersEnabled, onReserve, onCancel, onJoinWaitlist, onLeaveWaitlist, onAcceptOffer, onOfferRefresh }: {
  schedule: PortalClassSchedule; membership?: Membership;
  reservePending?: boolean; cancelPending?: boolean; waitlistPending?: boolean; leavePending?: boolean; offerPending?: boolean;
  serverTime?: string; receivedAt?: number; offersEnabled?: boolean;
  onReserve?: () => void; onCancel?: () => void; onJoinWaitlist?: () => void; onLeaveWaitlist?: () => void;
  onAcceptOffer?: (offerId: string) => void; onOfferRefresh?: () => void;
}) {
  const booked = schedule.myBooking?.status === 'reserved';
  const waiting = schedule.myWaitlist?.status === 'waiting' || schedule.myWaitlist?.status === 'offered';
  const hasPaymentRecord = Boolean(schedule.myBooking?.payment_id || schedule.myBooking?.payment_summary);
  const started = Date.parse(schedule.starts_at) <= (serverTime ? Date.parse(serverTime) : Date.now());
  if (!schedule.activity || !schedule.location || classReferenceIssue(schedule) || schedule.status !== 'scheduled' || started) return <UnavailableClass schedule={schedule}>
    {started && <p role="status">La clase ya inició. No se aceptan nuevas reservas.</p>}
    {booked && <button className="small-button danger-text" disabled={cancelPending || hasPaymentRecord} onClick={onCancel}>{hasPaymentRecord ? 'Cancela en recepción' : 'Cancelar reserva'}</button>}
    {waiting && <button className="small-button danger-text" disabled={leavePending} onClick={onLeaveWaitlist}>Salir de lista</button>}
  </UnavailableClass>;
  const existingContract = schedule.myBooking && schedule.myBooking.status !== 'cancelled' ? schedule.myBooking : null;
  const additional = existingContract ? existingContract.economic_terms?.billing_mode === 'additional_fee' : schedule.activity.billing_mode === 'additional_fee';
  const paymentConfirmed = schedule.myBooking?.payment_state === 'confirmed';
  const offered = schedule.myWaitlist?.status === 'offered' && Boolean(schedule.myWaitlist.offer_id);
  const busy = reservePending || cancelPending || waitlistPending || leavePending || offerPending;
  return <article>
    <div className="portal-class-date"><b>{new Date(schedule.starts_at).toLocaleDateString('es-EC', { day: '2-digit' })}</b><span>{new Date(schedule.starts_at).toLocaleDateString('es-EC', { month: 'short' })}</span></div>
    <div className="portal-class-info">
      <span className="eyebrow">{schedule.location.name}</span><h3>{schedule.activity.name}</h3>
      <p>{new Intl.DateTimeFormat('es-EC', { weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(schedule.starts_at))} · {schedule.instructor?.name ?? 'Instructor por confirmar'}</p>
      <small>{schedule.available} de {schedule.capacity} cupos disponibles</small>
      {Boolean(schedule.offeredCount) && <small>{schedule.offeredCount} cupo(s) temporalmente ofrecido(s)</small>}
      {schedule.myBooking && <ClassBookingConditions booking={schedule.myBooking}/>}
      {!existingContract && additional && <small className="portal-class-payment-copy">{money(schedule.activity.price, schedule.activity.currency)} · precio actual para una nueva reserva; se confirma al aceptar o reservar</small>}
    </div>
    <div className="portal-class-action" style={offered ? { gridColumn: '1 / -1', alignItems: 'stretch', minWidth: 0 } : undefined}>{booked ? <>
      <span className="badge reserved">Reserva confirmada</span><strong className={paymentConfirmed ? 'payment-confirmed' : 'payment-pending'}>{classPaymentLabel(schedule.myBooking!)}</strong>
      <button className="small-button danger-text" disabled={busy || hasPaymentRecord} onClick={onCancel}>{hasPaymentRecord ? 'Cancela en recepción' : 'Cancelar reserva'}</button>
    </> : schedule.myBooking?.status === 'attended' || schedule.myBooking?.status === 'no_show' ? <>
      <span className={`badge ${schedule.myBooking.status}`}>{schedule.myBooking.status === 'attended' ? 'Asististe' : 'No asististe'}</span><small>{classPaymentLabel(schedule.myBooking)}</small>
    </> : offered ? <ClassWaitlistOffer entry={schedule.myWaitlist!} serverTime={serverTime} receivedAt={receivedAt} busy={busy} disabled={offersEnabled === false} onAccept={() => onAcceptOffer?.(schedule.myWaitlist!.offer_id!)} onReject={onLeaveWaitlist} onRefresh={onOfferRefresh}/>
    : waiting ? <>
      <span className="badge waitlisted">Espera #{schedule.myWaitlist?.position}</span>
      <small>La posición es informada por el servidor.</small>
      {offersEnabled === false && <small>La asignación automática de cupos aún no está habilitada.</small>}
      <button className="small-button danger-text" disabled={busy} onClick={onLeaveWaitlist}>Salir de lista</button>
    </> : schedule.myBooking?.payment_state === 'refunded' ? <>
      <span className="badge cancelled">Pago reembolsado</span><button className="ghost" disabled>Nueva reserva en recepción</button>
    </> : schedule.available < 1 ? <>
      <span className="badge waitlisted">Clase llena</span>
      <button className="ghost" disabled={!membership || busy} onClick={onJoinWaitlist}>{!membership ? 'Requiere membresía' : 'Unirme a lista de espera'}</button>
      <small>Entrar en espera no es una reserva ni congela el precio.</small>
    </> : <>
      {additional && <strong>{money(schedule.activity.price, schedule.activity.currency)}</strong>}
      <button className="primary" disabled={!membership || busy} onClick={onReserve}>{!membership ? 'Requiere membresía' : additional ? 'Reservar · pagar en recepción' : 'Reservar'}</button>
      {additional && <small>No se realizará ningún cobro en FitLab.</small>}
    </>}</div>
  </article>;
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
  return <div className="progress-page">
    <section className={`progress-motivation ${progress?.motivation.tone ?? 'neutral'}`} aria-label="Motivación"><Flame/><div><strong>{progressLoading ? 'Preparando tu resumen…' : progress?.motivation.title ?? 'Cada entrenamiento cuenta'}</strong><span>{progress?.motivation.message ?? 'Registra tu próxima asistencia para continuar avanzando.'}</span></div></section>
    <div className="progress-section-heading"><h2>Resumen de tu actividad</h2><span>Mantén la constancia <Activity/></span></div>
    <div className="portal-progress-stats"><article className="portal-card"><Activity/><span>Asistencias totales</span><strong>{totalAttendances}</strong><small>Registros válidos</small></article><article className="portal-card"><CalendarCheck/><span>Este mes</span><strong>{monthAttendances}</strong><small>Entradas registradas</small></article><article className="portal-card"><Activity/><span>Esta semana</span><strong>{weekAttendances}</strong><small>Desde el lunes</small></article><article className="portal-card streak"><Flame/><span>Racha actual</span><strong>{currentStreak}</strong><small>Mejor racha: {longestStreak}</small></article></div>
    <section className="panel progress-charts-panel"><div className="panel-title"><div><h2><Activity/> Asistencia en gráficas</h2><p>Últimos seis meses y frecuencia semanal</p></div></div><div className="progress-charts-grid"><div className="progress-month-chart"><h3><CalendarCheck/> Asistencia mensual</h3>{monthBuckets.length ? <div className="attendance-chart" aria-label="Asistencias por mes">{monthBuckets.map((bucket) => <div className="attendance-chart-column" key={bucket.period}><strong>{bucket.count}</strong><div className="attendance-bar-track"><span style={{ height: `${Math.max(8, (bucket.count / maxMonthCount) * 100)}%` }}/></div><small>{bucket.label}</small></div>)}</div> : <div className="empty compact"><Activity/><strong>Reuniendo tu historial</strong></div>}</div>{weekBuckets.length > 0 && <div className="progress-week-chart"><h3><Activity/> Frecuencia semanal</h3><div className="attendance-chart weekly" aria-label="Asistencias por semana">{weekBuckets.map((bucket) => <div className="attendance-chart-column" key={bucket.period}><strong>{bucket.count}</strong><div className="attendance-bar-track"><span style={{ height: `${Math.max(8, (bucket.count / maxWeekCount) * 100)}%` }}/></div><small>{bucket.label}</small></div>)}</div></div>}</div></section>
    <section className="panel weight-progress-panel"><div className="panel-title"><div><h2><Dumbbell/> Progreso de peso</h2><p>{goalLabel ? `Objetivo: ${goalLabel}` : 'Configura un objetivo para medir tu avance'}</p></div><a className="ghost progress-history-link" href="#progress-weight-history">Ver historial →</a></div>{progress?.goal ? <><div className="progress-weight-summary"><div className="weight-progress-values"><div><span>Inicial</span><strong>{progress.goal.initialWeightKg} kg</strong></div><div><span>Actual</span><strong>{progress.goal.currentWeightKg} kg</strong></div><div><span>Objetivo</span><strong>{progress.goal.targetWeightKg == null ? '—' : `${progress.goal.targetWeightKg} kg`}</strong></div></div><div className="progress-weight-action"><div className="weight-progress-caption"><strong>{progress.goal.progressPercent}% de avance</strong></div><div className="weight-progress-track" role="progressbar" aria-label="Progreso hacia el peso objetivo" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.goal.progressPercent}><span style={{ width: `${progress.goal.progressPercent}%` }}/></div><button className="primary" onClick={onRecordWeight}>Registrar peso</button></div></div>{weightEntries.length > 1 && <div className="weight-chart" aria-label="Evolución del peso">{weightEntries.map((entry) => <div className="weight-chart-column" key={entry.id}><strong>{entry.weightKg}</strong><div className="weight-chart-track"><span style={{ height: `${25 + ((entry.weightKg - minWeight) / weightSpan) * 75}%` }}/></div><small>{entry.measuredOn.slice(5)}</small></div>)}</div>}</> : <div className="empty compact"><Dumbbell/><strong>Sin progreso calculable todavía</strong><span>Indica un peso objetivo en tu encuesta para ver el porcentaje de avance.</span><button className="ghost" onClick={onRecordWeight}>Registrar peso</button></div>}</section>
    <div className="progress-detail-grid"><section className="panel progress-calendar"><div className="panel-title"><div><h2><CalendarCheck/> Calendario de {new Date(`${range.from}T12:00:00`).toLocaleDateString('es-EC', { month: 'long' })}</h2><p className="progress-calendar-legend"><span>Verde: asistencia</span><span>Amarillo: día adicional</span><span>Rojo: anulada</span></p></div></div><div className="month-weekdays">{['L','M','X','J','V','S','D'].map((day) => <span key={day}>{day}</span>)}</div><div className="month-grid">{Array.from({ length: firstOffset }, (_, index) => <span key={`empty-${index}`}/>)}{days.map((item) => <div key={item.date} title={`${item.date} · ${item.mode}`} className={`month-day ${item.date === range.today ? 'today' : ''} ${item.attendance?.status ?? item.mode}`}><span>{item.day}</span>{item.attendance && <Activity/>}</div>)}</div></section>
    <section className="panel progress-week-goal"><div className="panel-title"><div><h2><Flame/> Tu objetivo semanal</h2><p>{membership?.attendance_mode_snapshot === 'weekly' ? 'Meta incluida en tu plan' : 'Asistencia en días abiertos'}</p></div></div>{membership?.attendance_mode_snapshot === 'weekly' ? <div className="progress-block"><div><strong>{currentWeek?.completed_attendances ?? 0} de {currentWeek?.target_attendances ?? membership.weekly_target_snapshot ?? 0}</strong><span>{currentWeek?.is_grace_week ? 'Semana de gracia' : currentWeek?.goal_met ? 'Meta completada' : 'Sigue avanzando'}</span></div><progress aria-label="Tu objetivo semanal" value={currentWeek?.completed_attendances ?? 0} max={currentWeek?.target_attendances ?? membership.weekly_target_snapshot ?? 1}/></div> : <div className="daily-goal"><CalendarCheck/><div><strong>Plan de asistencia diaria</strong><span>Asiste los días obligatorios. Los días adicionales solamente suman.</span></div></div>}</section>
    <section className="panel progress-weight-history" id="progress-weight-history" tabIndex={-1}><div className="panel-title"><div><h2><Dumbbell/> Historial de peso</h2><p>Mediciones privadas, ordenadas por fecha</p></div><button className="ghost" onClick={onRecordWeight}>Registrar peso</button></div>{progress?.weights.length ? <div className="portal-history">{progress.weights.slice(-6).reverse().map((entry) => <article key={entry.id}><div><strong>{entry.weightKg} kg</strong><small>{entry.measuredOn}</small></div><span className="badge attended">{entry.source === 'onboarding' ? 'Inicial' : 'Registrado'}</span></article>)}</div> : <div className="empty compact"><Dumbbell/><strong>Aún no hay mediciones</strong></div>}</section></div>
    <section className="panel progress-recent-attendance"><div className="panel-title"><div><h2><Activity/> Asistencias recientes</h2><p>Tu historial permanece disponible</p></div></div>{attendances.length ? <div className="portal-history">{attendances.slice(0, 12).map((item) => <article key={item.id}><div><strong>{item.attendance_date}</strong><small>{item.source === 'qr' ? 'Entrada del miembro' : 'Registrada por recepción'}</small></div><span className={`badge ${item.status}`}>{item.status === 'valid' ? 'Válida' : 'Anulada'}</span></article>)}</div> : <div className="empty compact"><Activity/><strong>Sin asistencias todavía</strong></div>}</section>
  </div>;
}

function ProfileGoalSummary({profile,progress}:{profile?:FitnessProfile|null;progress?:MemberProgress}) {
 const goal=progress?.goal;const label=fitnessGoals.find(item=>item.value===profile?.goal_type)?.label??'Configura tu objetivo';
 const measurable=goal&&goal.targetWeightKg!=null&&goal.initialWeightKg!==goal.targetWeightKg;
 return <section className="profile-goal-summary"><p className="eyebrow">MI OBJETIVO</p><h2>{label}</h2>{measurable?<><div className="profile-goal-values"><span>{goal.initialWeightKg} kg iniciales</span><strong>{goal.progressPercent}%</strong><span>{goal.targetWeightKg} kg objetivo</span></div><progress aria-label="Avance hacia mi objetivo" max={100} value={goal.progressPercent}/><p>Peso registrado más reciente: {goal.currentWeightKg} kg</p></>:<p>{profile?`${profile.training_frequency_per_week} entrenamientos por semana · Sin datos suficientes para mostrar un porcentaje.`:'Completa tu perfil deportivo en Configuración.'}</p>}<Link to="/portal/progress">Ver progreso →</Link></section>;
}

const privacyOptions=[['showInCommunity','show_in_community','Aparecer en Comunidad'],['showProfilePhoto','show_profile_photo','Mostrar mi foto'],['showStreak','show_streak','Mostrar mi racha'],['showAttendanceCount','show_attendance_count','Mostrar asistencias'],['showWeightProgress','show_weight_progress','Mostrar progreso de peso'],['showGoal','show_goal','Mostrar mi objetivo']] as const;
type PrivacyKey=typeof privacyOptions[number][0];
function ProfileSettingsView({session,profile,onEdit,onEditFitness,onPrivacySave,pending,variables,error,saved}:{session:ReturnType<typeof useAuth>['session'];profile?:FitnessProfile|null;onEdit:()=>void;onEditFitness:()=>void;onPrivacySave:(key:PrivacyKey,value:boolean)=>void;pending:boolean;variables?:{key:PrivacyKey;value:boolean};error:unknown;saved:boolean}){
 const goal=fitnessGoals.find(item=>item.value===profile?.goal_type)?.label??'Sin configurar';
 return <div className="profile-dedicated-page"><Link to="/portal/profile" className="ghost">← Volver al perfil</Link><h1>Configuración</h1>
 <section className="panel"><h2>Cuenta</h2><div className="profile-lines"><div><span>Nombre</span><strong>{session?.gymUser?.profiles?.full_name}</strong></div><div><span>Correo</span><strong>{session?.user.email}</strong></div><div><span>Teléfono</span><strong>{session?.gymUser?.profiles?.phone??'Sin teléfono'}</strong></div></div><button className="ghost" onClick={onEdit}><Pencil/>Editar cuenta y contraseña</button></section>
 <section className="panel"><h2>Privacidad y comunidad</h2><p className="form-note">Cada cambio se guarda al instante. Tus preferencias se conservan; tu peso permanece privado salvo que decidas compartir su progreso.</p>{privacyOptions.map(([key,field,label])=><PrivacySwitch key={key} label={label} disabled={!profile||pending} checked={pending&&variables?.key===key?variables.value:Boolean(profile?.[field])} onChange={value=>onPrivacySave(key,value)}/>)}{pending&&<small role="status">Guardando…</small>}{saved&&<small role="status">✓ Guardado</small>}{error!=null&&<p className="alert error" role="alert">{apiErrorMessage(error)}</p>}<SocialPrivacySettings/><FriendRequestsPreference/><PokePreference/></section>
 <section className="panel"><h2>Perfil deportivo</h2>{profile?<><div className="fitness-profile-grid"><div><span>Objetivo</span><strong>{goal}</strong></div><div><span>Peso inicial</span><strong>{profile.weight_kg} kg</strong></div><div><span>Altura</span><strong>{profile.height_cm} cm</strong></div><div><span>Experiencia</span><strong>{experienceLabels[profile.experience_level]}</strong></div><div><span>Entrenamiento deseado</span><strong>{profile.training_frequency_per_week} veces por semana</strong></div><div><span>Tipo preferido</span><strong>{profile.preferred_training_type??'Sin especificar'}</strong></div><div><span>Peso objetivo</span><strong>{profile.target_weight_kg==null?'Sin especificar':`${profile.target_weight_kg} kg`}</strong></div><div><span>Plazo</span><strong>{profile.goal_horizon_months==null?'Sin especificar':`${profile.goal_horizon_months} meses`}</strong></div></div>{profile.public_message&&<p>{profile.public_message}</p>}</>:<p>Completa tu encuesta.</p>}<button className="ghost" disabled={pending} onClick={onEditFitness}><Pencil/>Editar datos deportivos</button><Link className="ghost" to="/portal/progress">Ver progreso</Link></section></div>;
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
