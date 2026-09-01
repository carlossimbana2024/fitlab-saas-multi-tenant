import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import {
  activitiesListSchema,
  activitySchema,
  bookingCancellationSchema,
  classAttendanceSchema,
  classScheduleSchema,
  managedClassBookingSchema,
} from '../validators/activity.validator.js';

const uuid = z.string().uuid();

function relatedOne<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

function gymUserName(user: { managed_full_name?: string | null; profiles?: { full_name?: string | null } | Array<{ full_name?: string | null }> | null } | undefined) {
  return relatedOne(user?.profiles)?.full_name ?? user?.managed_full_name ?? 'Sin nombre';
}

type ClassAccess = { manage: boolean; bookings: boolean; attendance: boolean };

async function ensureClassReadAccess(request: Request): Promise<ClassAccess> {
  if (request.tenant!.role === 'owner') return { manage: true, bookings: true, attendance: true };
  if (request.tenant!.role === 'member') return { manage: false, bookings: false, attendance: false };
  const { data, error } = await request.supabase!.from('staff_permissions')
    .select('permission_key,access_mode').eq('gym_id', request.tenant!.gymId)
    .eq('staff_user_id', request.tenant!.gymUserId)
    .in('permission_key', ['classes.manage', 'classes.bookings_manage', 'classes.attendance_manage']);
  if (error) throw fromSupabaseError(error);
  const allowed = new Set((data ?? []).filter((permission) => permission.access_mode !== 'denied').map((permission) => permission.permission_key));
  if (!allowed.size) {
    throw new AppError(403, 'PERMISSION_DENIED', 'No tienes permiso para consultar actividades.');
  }
  return {
    manage: allowed.has('classes.manage'),
    bookings: allowed.has('classes.bookings_manage'),
    attendance: allowed.has('classes.attendance_manage'),
  };
}

export async function listActivities(request: Request, response: Response) {
  const classAccess = await ensureClassReadAccess(request);
  const input = activitiesListSchema.safeParse(request.query);
  if (!input.success) throw new AppError(400, 'INVALID_ACTIVITY_FILTERS', 'Los filtros de actividades no son válidos.');
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const defaultTo = new Date(now.getTime() + 60 * 86_400_000).toISOString();
  const from = input.data.from ?? defaultFrom;
  const to = input.data.to ?? defaultTo;
  const isMember = request.tenant!.role === 'member';

  let activitiesQuery = supabaseAdmin.from('extra_classes')
    .select('id,name,description,billing_mode,price,currency,capacity,duration_minutes,is_active,created_at,updated_at')
    .eq('gym_id', request.tenant!.gymId).order('name');
  if (isMember || !input.data.includeInactive) activitiesQuery = activitiesQuery.eq('is_active', true);

  let schedulesQuery = supabaseAdmin.from('class_schedules')
    .select('id,location_id,extra_class_id,instructor_user_id,starts_at,ends_at,capacity_override,status,cancelled_at,cancellation_reason,created_at')
    .eq('gym_id', request.tenant!.gymId).gte('starts_at', from).lte('starts_at', to)
    .order('starts_at').limit(500);
  if (input.data.locationId) schedulesQuery = schedulesQuery.eq('location_id', input.data.locationId);
  if (isMember) schedulesQuery = schedulesQuery.eq('status', 'scheduled');
  if (request.tenant!.role === 'staff' && classAccess.attendance && !classAccess.manage && !classAccess.bookings) {
    schedulesQuery = schedulesQuery.eq('instructor_user_id', request.tenant!.gymUserId);
  }

  const [activitiesResult, schedulesResult, locationsResult] = await Promise.all([
    activitiesQuery,
    schedulesQuery,
    supabaseAdmin.from('gym_locations').select('id,name,is_main,is_active,timezone')
      .eq('gym_id', request.tenant!.gymId).eq('is_active', true)
      .order('is_main', { ascending: false }).order('name'),
  ]);
  const baseError = activitiesResult.error ?? schedulesResult.error ?? locationsResult.error;
  if (baseError) throw fromSupabaseError(baseError);
  const activities = activitiesResult.data ?? [];
  const schedules = schedulesResult.data ?? [];
  const scheduleIds = schedules.map((schedule) => schedule.id);

  let bookingsQuery = scheduleIds.length
    ? supabaseAdmin.from('class_bookings')
      .select('id,class_schedule_id,member_user_id,status,payment_id,booked_at,booked_by,cancelled_at,cancellation_reason,attendance_marked_at,attendance_marked_by')
      .eq('gym_id', request.tenant!.gymId).in('class_schedule_id', scheduleIds)
      .order('booked_at', { ascending: false })
    : null;
  if (bookingsQuery && isMember) bookingsQuery = bookingsQuery.eq('member_user_id', request.tenant!.gymUserId);

  const [bookingsResult, peopleResult] = await Promise.all([
    bookingsQuery ?? Promise.resolve({ data: [], error: null }),
    isMember
      ? Promise.resolve({ data: [], error: null })
      : supabaseAdmin.from('gym_users')
        .select('id,role,status,default_location_id,managed_full_name,managed_phone,profiles(full_name,phone)')
        .eq('gym_id', request.tenant!.gymId).in('role', ['owner', 'staff', 'member'])
        .in('status', ['active', 'suspended']).order('created_at'),
  ]);
  const relatedError = bookingsResult.error ?? peopleResult.error;
  if (relatedError) throw fromSupabaseError(relatedError);
  const bookings = bookingsResult.data ?? [];
  const paymentIds = classAccess.bookings
    ? bookings.map((booking) => booking.payment_id).filter(Boolean) as string[]
    : [];
  const paymentsResult = paymentIds.length
    ? await supabaseAdmin.from('member_payments')
      .select('id,class_booking_id,amount,currency,payment_method,status,receipt_number,paid_at,external_reference,refund_reason')
      .eq('gym_id', request.tenant!.gymId).in('id', paymentIds)
    : { data: [], error: null };
  if (paymentsResult.error) throw fromSupabaseError(paymentsResult.error);
  const waitlistsResult = scheduleIds.length && (isMember || classAccess.bookings)
    ? await supabaseAdmin.from('class_waitlists')
      .select('id,class_schedule_id,member_user_id,status,joined_at,offered_at,cancelled_at,cancellation_reason')
      .eq('gym_id', request.tenant!.gymId).in('class_schedule_id', scheduleIds)
      .in('status', ['waiting', 'offered']).order('joined_at')
    : { data: [], error: null };
  if (waitlistsResult.error) throw fromSupabaseError(waitlistsResult.error);
  const waitlists = isMember
    ? (waitlistsResult.data ?? []).filter((waitlist) => waitlist.member_user_id === request.tenant!.gymUserId)
    : waitlistsResult.data ?? [];

  const activityById = new Map(activities.map((activity) => [activity.id, activity]));
  const locationById = new Map((locationsResult.data ?? []).map((location) => [location.id, location]));
  const people = peopleResult.data ?? [];
  const personById = new Map(people.map((person) => [person.id, person]));
  const paymentById = new Map((paymentsResult.data ?? []).map((payment) => [payment.id, payment]));
  const bookingsBySchedule = new Map<string, typeof bookings>();
  for (const booking of bookings) {
    bookingsBySchedule.set(booking.class_schedule_id, [...(bookingsBySchedule.get(booking.class_schedule_id) ?? []), booking]);
  }

  response.json({
    access: classAccess,
    activities,
    locations: locationsResult.data ?? [],
    instructors: classAccess.manage ? people.filter((person) => person.status === 'active' && ['owner', 'staff'].includes(person.role))
      .map((person) => ({ id: person.id, name: gymUserName(person), defaultLocationId: person.default_location_id })) : [],
    members: classAccess.bookings ? people.filter((person) => person.role === 'member' && person.status === 'active')
      .map((person) => ({ id: person.id, name: gymUserName(person), phone: relatedOne(person.profiles)?.phone ?? person.managed_phone ?? null })) : [],
    schedules: schedules.map((schedule) => {
      const scheduleBookings = bookingsBySchedule.get(schedule.id) ?? [];
      const occupied = scheduleBookings.filter((booking) => ['reserved', 'attended'].includes(booking.status)).length;
      const activity = activityById.get(schedule.extra_class_id);
      const capacity = schedule.capacity_override ?? activity?.capacity ?? 0;
      return {
        ...schedule,
        activity: activity ?? null,
        location: locationById.get(schedule.location_id) ?? null,
        instructor: schedule.instructor_user_id ? { id: schedule.instructor_user_id, name: gymUserName(personById.get(schedule.instructor_user_id)) } : null,
        occupied,
        capacity,
        available: Math.max(0, capacity - occupied),
        myBooking: isMember ? scheduleBookings[0] ?? null : null,
        waitlistCount: isMember ? undefined : waitlists.filter((waitlist) => waitlist.class_schedule_id === schedule.id).length,
        myWaitlist: isMember ? waitlists.find((waitlist) => waitlist.class_schedule_id === schedule.id) ?? null : null,
      };
    }),
    bookings: isMember ? [] : bookings.map((booking) => ({
      ...booking,
      member: { id: booking.member_user_id, name: gymUserName(personById.get(booking.member_user_id)), phone: relatedOne(personById.get(booking.member_user_id)?.profiles)?.phone ?? personById.get(booking.member_user_id)?.managed_phone ?? null },
      payment: classAccess.bookings && booking.payment_id ? paymentById.get(booking.payment_id) ?? null : null,
    })),
    waitlists: isMember || classAccess.bookings ? waitlists.map((waitlist) => ({
      ...waitlist,
      member: isMember ? null : { id: waitlist.member_user_id, name: gymUserName(personById.get(waitlist.member_user_id)) },
      position: waitlists.filter((item) => item.class_schedule_id === waitlist.class_schedule_id && item.joined_at <= waitlist.joined_at).length,
    })) : [],
  });
}

export async function getActivitySummary(request: Request, response: Response) {
  const classAccess = await ensureClassReadAccess(request);
  if (request.tenant!.role === 'member') {
    throw new AppError(403, 'PERMISSION_DENIED', 'El resumen de actividades es solo para el equipo del gimnasio.');
  }
  const input = activitiesListSchema.safeParse(request.query);
  if (!input.success) throw new AppError(400, 'INVALID_ACTIVITY_FILTERS', 'Los filtros de actividades no son válidos.');
  const now = new Date();
  const from = input.data.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const to = input.data.to ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999)).toISOString();
  let schedulesQuery = supabaseAdmin.from('class_schedules').select('id,extra_class_id,location_id,starts_at').eq('gym_id', request.tenant!.gymId).gte('starts_at', from).lte('starts_at', to);
  if (input.data.locationId) schedulesQuery = schedulesQuery.eq('location_id', input.data.locationId);
  if (request.tenant!.role === 'staff' && classAccess.attendance && !classAccess.manage && !classAccess.bookings) schedulesQuery = schedulesQuery.eq('instructor_user_id', request.tenant!.gymUserId);
  const schedulesResult = await schedulesQuery;
  if (schedulesResult.error) throw fromSupabaseError(schedulesResult.error);
  const scheduleRows = schedulesResult.data ?? [];
  const scheduleIds = scheduleRows.map((item) => item.id);
  const [bookingsResult, activitiesResult, locationsResult] = await Promise.all([
    scheduleIds.length ? supabaseAdmin.from('class_bookings').select('id,class_schedule_id,status').eq('gym_id', request.tenant!.gymId).in('class_schedule_id', scheduleIds) : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from('extra_classes').select('id,name').eq('gym_id', request.tenant!.gymId),
    supabaseAdmin.from('gym_locations').select('id,name').eq('gym_id', request.tenant!.gymId),
  ]);
  const error = bookingsResult.error ?? activitiesResult.error ?? locationsResult.error;
  if (error) throw fromSupabaseError(error);
  const bookings = bookingsResult.data ?? [];
  const activityNames = new Map((activitiesResult.data ?? []).map((item) => [item.id, item.name]));
  const locationNames = new Map((locationsResult.data ?? []).map((item) => [item.id, item.name]));
  const count = (status: string) => bookings.filter((booking) => booking.status === status).length;
  const attended = count('attended'); const noShow = count('no_show');
  const byActivity = new Map<string, { name: string; reservations: number; attended: number; noShow: number }>();
  for (const schedule of scheduleRows) {
    const name = activityNames.get(schedule.extra_class_id) ?? 'Actividad';
    const row = byActivity.get(schedule.extra_class_id) ?? { name, reservations: 0, attended: 0, noShow: 0 };
    const rows = bookings.filter((booking) => booking.class_schedule_id === schedule.id);
    row.reservations += rows.length; row.attended += rows.filter((booking) => booking.status === 'attended').length; row.noShow += rows.filter((booking) => booking.status === 'no_show').length;
    byActivity.set(schedule.extra_class_id, row);
  }
  const byLocation = new Map<string, { name: string; classes: number; reservations: number }>();
  for (const schedule of scheduleRows) {
    const row = byLocation.get(schedule.location_id) ?? { name: locationNames.get(schedule.location_id) ?? 'Sucursal', classes: 0, reservations: 0 };
    row.classes += 1; row.reservations += bookings.filter((booking) => booking.class_schedule_id === schedule.id).length; byLocation.set(schedule.location_id, row);
  }
  response.json({ from, to, totals: { classes: scheduleRows.length, reservations: bookings.length, reserved: count('reserved'), attended, noShow, cancelled: count('cancelled'), attendanceRate: attended + noShow ? Math.round((attended / (attended + noShow)) * 100) : null }, byActivity: [...byActivity.values()].sort((a, b) => b.reservations - a.reservations), byLocation: [...byLocation.values()].sort((a, b) => b.reservations - a.reservations) });
}

export async function createActivity(request: Request, response: Response) {
  const input = activitySchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_EXTRA_CLASS_INPUT', 'Revisa los datos de la actividad.', input.error.flatten());
  const { data, error } = await supabaseAdmin.rpc('create_extra_class_backend', {
    target_gym_id: request.tenant!.gymId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_name: input.data.name,
    supplied_description: input.data.description ?? null,
    supplied_billing_mode: input.data.billingMode,
    supplied_price: input.data.price,
    supplied_currency: input.data.currency,
    supplied_capacity: input.data.capacity,
    supplied_duration_minutes: input.data.durationMinutes,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.status(201).json({ activity: data });
}

export async function updateActivity(request: Request, response: Response) {
  const activityId = request.params.id;
  const input = activitySchema.safeParse(request.body);
  if (!activityId || !uuid.safeParse(activityId).success || !input.success) {
    throw new AppError(400, 'INVALID_EXTRA_CLASS_INPUT', 'Revisa los datos de la actividad.');
  }
  const { data, error } = await supabaseAdmin.rpc('update_extra_class_backend', {
    target_gym_id: request.tenant!.gymId,
    target_extra_class_id: activityId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_name: input.data.name,
    supplied_description: input.data.description ?? null,
    supplied_billing_mode: input.data.billingMode,
    supplied_price: input.data.price,
    supplied_currency: input.data.currency,
    supplied_capacity: input.data.capacity,
    supplied_duration_minutes: input.data.durationMinutes,
    supplied_is_active: input.data.isActive,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.json({ activity: data });
}

export async function createClassSchedule(request: Request, response: Response) {
  const input = classScheduleSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_CLASS_SCHEDULE_INPUT', 'Revisa la programación de la clase.', input.error.flatten());
  const { data, error } = await supabaseAdmin.rpc('create_class_schedule_backend', {
    target_gym_id: request.tenant!.gymId,
    target_extra_class_id: input.data.activityId,
    target_location_id: input.data.locationId,
    target_instructor_user_id: input.data.instructorUserId ?? null,
    supplied_starts_at: input.data.startsAt,
    supplied_capacity_override: input.data.capacityOverride ?? null,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.status(201).json({ schedule: data });
}

export async function cancelClassSchedule(request: Request, response: Response) {
  const scheduleId = request.params.id;
  const input = bookingCancellationSchema.safeParse(request.body);
  if (!scheduleId || !uuid.safeParse(scheduleId).success || !input.success) throw new AppError(400, 'INVALID_CLASS_CANCELLATION', 'Indica un motivo válido.');
  const { data, error } = await supabaseAdmin.rpc('cancel_class_schedule_backend', {
    target_gym_id: request.tenant!.gymId,
    target_class_schedule_id: scheduleId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_reason: input.data.reason,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.json({ schedule: data });
}

export async function reserveClassForSelf(request: Request, response: Response) {
  const scheduleId = request.params.id;
  if (request.tenant!.role !== 'member' || !scheduleId || !uuid.safeParse(scheduleId).success) {
    throw new AppError(403, 'MEMBER_SELF_BOOKING_REQUIRED', 'Esta reserva debe realizarla el propio miembro.');
  }
  const { data, error } = await supabaseAdmin.rpc('reserve_included_class_backend', {
    target_gym_id: request.tenant!.gymId,
    target_class_schedule_id: scheduleId,
    target_member_user_id: request.tenant!.gymUserId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_used_pin_elevation: false,
  });
  if (error) throw fromSupabaseError(error);
  response.status(201).json({ booking: data });
}

export async function joinClassWaitlist(request: Request, response: Response) {
  const scheduleId = request.params.id;
  if (request.tenant!.role !== 'member' || !scheduleId || !uuid.safeParse(scheduleId).success) throw new AppError(403, 'MEMBER_SELF_BOOKING_REQUIRED', 'Esta acción debe realizarla el propio miembro.');
  const { data, error } = await supabaseAdmin.rpc('join_class_waitlist_backend', { target_gym_id: request.tenant!.gymId, target_class_schedule_id: scheduleId, target_member_user_id: request.tenant!.gymUserId, target_actor_gym_user_id: request.tenant!.gymUserId });
  if (error) throw fromSupabaseError(error);
  response.status(201).json({ waitlist: Array.isArray(data) ? data[0] : data });
}

export async function leaveClassWaitlist(request: Request, response: Response) {
  const waitlistId = request.params.id;
  if (request.tenant!.role !== 'member' || !waitlistId || !uuid.safeParse(waitlistId).success) throw new AppError(403, 'MEMBER_SELF_CANCELLATION_REQUIRED', 'Esta acción debe realizarla el propio miembro.');
  const reason = typeof request.body?.reason === 'string' ? request.body.reason : 'Salida voluntaria de la lista';
  const { data, error } = await supabaseAdmin.rpc('leave_class_waitlist_backend', { target_gym_id: request.tenant!.gymId, target_waitlist_id: waitlistId, target_actor_gym_user_id: request.tenant!.gymUserId, supplied_reason: reason });
  if (error) throw fromSupabaseError(error);
  response.json({ waitlist: data });
}

export async function reserveClassForMember(request: Request, response: Response) {
  const scheduleId = request.params.id;
  const input = managedClassBookingSchema.safeParse(request.body);
  if (!scheduleId || !uuid.safeParse(scheduleId).success || !input.success) throw new AppError(400, 'INVALID_CLASS_BOOKING', 'Revisa los datos de la reserva.');
  if (input.data.payment) {
    const { data, error } = await supabaseAdmin.rpc('reserve_paid_class_backend', {
      target_gym_id: request.tenant!.gymId,
      target_class_schedule_id: scheduleId,
      target_member_user_id: input.data.memberUserId,
      target_actor_gym_user_id: request.tenant!.gymUserId,
      supplied_payment_method: input.data.payment.method,
      supplied_external_reference: input.data.payment.externalReference ?? null,
      supplied_notes: input.data.payment.notes ?? null,
      supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
    });
    if (error) throw fromSupabaseError(error);
    return response.status(201).json({ booking: Array.isArray(data) ? data[0] : data });
  }
  const { data, error } = await supabaseAdmin.rpc('reserve_included_class_backend', {
    target_gym_id: request.tenant!.gymId,
    target_class_schedule_id: scheduleId,
    target_member_user_id: input.data.memberUserId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.status(201).json({ booking: data });
}

async function cancelBooking(request: Request, response: Response, self: boolean) {
  const bookingId = request.params.id;
  const input = bookingCancellationSchema.safeParse(request.body);
  if (!bookingId || !uuid.safeParse(bookingId).success || !input.success) throw new AppError(400, 'INVALID_CLASS_BOOKING_CANCELLATION', 'Indica un motivo válido.');
  if (self && request.tenant!.role !== 'member') throw new AppError(403, 'MEMBER_SELF_CANCELLATION_REQUIRED', 'Esta cancelación corresponde al miembro.');
  const { data, error } = await supabaseAdmin.rpc('cancel_class_booking_backend', {
    target_gym_id: request.tenant!.gymId,
    target_class_booking_id: bookingId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_reason: input.data.reason,
    supplied_used_pin_elevation: self ? false : request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.json({ booking: data });
}

export async function cancelOwnClassBooking(request: Request, response: Response) { return cancelBooking(request, response, true); }
export async function cancelManagedClassBooking(request: Request, response: Response) { return cancelBooking(request, response, false); }

export async function markClassAttendance(request: Request, response: Response) {
  const bookingId = request.params.id;
  const input = classAttendanceSchema.safeParse(request.body);
  if (!bookingId || !uuid.safeParse(bookingId).success || !input.success) throw new AppError(400, 'INVALID_CLASS_ATTENDANCE', 'El estado de asistencia no es válido.');
  const { data, error } = await supabaseAdmin.rpc('mark_class_booking_attendance_backend', {
    target_gym_id: request.tenant!.gymId,
    target_class_booking_id: bookingId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    target_status: input.data.status,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.json({ booking: data });
}

export async function refundClassBooking(request: Request, response: Response) {
  const bookingId = request.params.id;
  const input = bookingCancellationSchema.safeParse(request.body);
  if (!bookingId || !uuid.safeParse(bookingId).success || !input.success) throw new AppError(400, 'INVALID_CLASS_REFUND', 'Indica un motivo válido para el reembolso.');
  const { data, error } = await supabaseAdmin.rpc('refund_class_booking_backend', {
    target_gym_id: request.tenant!.gymId,
    target_class_booking_id: bookingId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_reason: input.data.reason,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.json({ refund: Array.isArray(data) ? data[0] : data });
}

export async function getClassReceipt(request: Request, response: Response) {
  const bookingId = request.params.id;
  if (!bookingId || !uuid.safeParse(bookingId).success) throw new AppError(400, 'INVALID_CLASS_BOOKING', 'La reserva no es válida.');
  const bookingResult = await supabaseAdmin.from('class_bookings')
    .select('id,class_schedule_id,member_user_id,status,payment_id')
    .eq('id', bookingId).eq('gym_id', request.tenant!.gymId).maybeSingle();
  if (bookingResult.error) throw fromSupabaseError(bookingResult.error);
  const booking = bookingResult.data;
  if (!booking?.payment_id) throw new AppError(404, 'CLASS_RECEIPT_NOT_FOUND', 'La reserva no tiene un recibo de pago.');
  if (request.tenant!.role === 'member' && booking.member_user_id !== request.tenant!.gymUserId) {
    throw new AppError(404, 'CLASS_RECEIPT_NOT_FOUND', 'El recibo no existe.');
  }
  if (request.tenant!.role === 'staff') {
    const classAccess = await ensureClassReadAccess(request);
    if (!classAccess.bookings) throw new AppError(403, 'PERMISSION_DENIED', 'No tienes permiso para consultar recibos de clases.');
  }
  const [paymentResult, scheduleResult, gymResult, memberResult] = await Promise.all([
    supabaseAdmin.from('member_payments').select('id,location_id,amount,currency,payment_method,status,receipt_number,receipt_issued_at,receipt_verification_token,external_reference,notes,paid_at,refunded_at,refund_reason,registered_by').eq('id', booking.payment_id).eq('gym_id', request.tenant!.gymId).single(),
    supabaseAdmin.from('class_schedules').select('id,location_id,extra_class_id,instructor_user_id,starts_at,ends_at').eq('id', booking.class_schedule_id).eq('gym_id', request.tenant!.gymId).single(),
    supabaseAdmin.from('gyms').select('name,legal_name,email,phone,whatsapp_phone,logo_url').eq('id', request.tenant!.gymId).single(),
    supabaseAdmin.from('gym_users').select('managed_full_name,managed_phone,profiles(full_name,phone)').eq('id', booking.member_user_id).eq('gym_id', request.tenant!.gymId).single(),
  ]);
  const baseError = paymentResult.error ?? scheduleResult.error ?? gymResult.error ?? memberResult.error;
  if (baseError) throw fromSupabaseError(baseError);
  const payment = paymentResult.data;
  const schedule = scheduleResult.data;
  const gym = gymResult.data;
  const member = memberResult.data;
  if (!payment || !schedule || !gym || !member) {
    throw new AppError(404, 'CLASS_RECEIPT_NOT_FOUND', 'No fue posible completar los datos del recibo.');
  }
  const [activityResult, locationResult, instructorResult, registererResult] = await Promise.all([
    supabaseAdmin.from('extra_classes').select('name,description,billing_mode').eq('id', schedule.extra_class_id).single(),
    supabaseAdmin.from('gym_locations').select('name,address,city,email,phone,whatsapp_phone').eq('id', schedule.location_id).eq('gym_id', request.tenant!.gymId).single(),
    schedule.instructor_user_id ? supabaseAdmin.from('gym_users').select('managed_full_name,profiles(full_name)').eq('id', schedule.instructor_user_id).single() : Promise.resolve({ data: null, error: null }),
    supabaseAdmin.from('gym_users').select('managed_full_name,profiles(full_name)').eq('id', payment.registered_by).single(),
  ]);
  const relatedError = activityResult.error ?? locationResult.error ?? instructorResult.error ?? registererResult.error;
  if (relatedError) throw fromSupabaseError(relatedError);
  response.json({ receipt: {
    number: payment.receipt_number,
    issuedAt: payment.receipt_issued_at,
    verificationToken: payment.receipt_verification_token,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    paymentMethod: payment.payment_method,
    externalReference: payment.external_reference,
    notes: payment.notes,
    paidAt: payment.paid_at,
    refundReason: payment.refund_reason,
    refundedAt: payment.refunded_at,
    gym,
    location: locationResult.data,
    member: { name: gymUserName(member), phone: relatedOne(member.profiles)?.phone ?? member.managed_phone ?? null },
    activity: activityResult.data,
    schedule: { startsAt: schedule.starts_at, endsAt: schedule.ends_at },
    instructor: instructorResult.data ? { name: gymUserName(instructorResult.data) } : null,
    registeredBy: { name: gymUserName(registererResult.data ?? undefined) },
    bookingStatus: booking.status,
  } });
}
