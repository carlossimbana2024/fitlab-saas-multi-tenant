import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { classBookingEconomics } from '../utils/classBookingEconomics.js';
import { historyCursorFilter, historyCursorParam, historyPage, historyTimestamp, MEMBER_HISTORY_PAGE_SIZE, parseHistoryInput } from '../utils/memberHistoryPagination.js';
import { fromSupabaseError } from '../utils/supabaseError.js';

const filters = z.object({ from: historyTimestamp, to: historyTimestamp, cursor: historyCursorParam })
  .refine(({ from, to }) => {
    const span = Date.parse(to) - Date.parse(from);
    return span > 0 && span <= 32 * 86_400_000;
  });

export async function listMemberClassHistory(request: Request, response: Response) {
  const { role, gymId, gymUserId } = request.tenant!;
  if (role !== 'member') throw new AppError(403, 'MEMBER_REQUIRED', 'Esta opción pertenece al portal del miembro.');
  const { from, to, cursor } = parseHistoryInput(filters, request.query);
  // The OR on the filtered embeds selects only sessions linked to this member.
  // No availability RPC: historical reads must not process queues or issue offers.
  let query = supabaseAdmin.from('class_schedules').select(`
    id,starts_at,ends_at,status,
    activity:extra_classes(name,is_active),location:gym_locations(name,timezone,is_active),
    instructor:gym_users!class_schedules_instructor_user_id_fkey(managed_full_name,profiles(full_name)),
    bookings:class_bookings(id,status,payment_id,economic_versions:class_booking_terms(version,billing_mode,agreed_amount,currency,contracted_at,cancelled_at,evidence_state,source,payment_evidence_id)),
    waitlist:class_waitlists(status)
  `).eq('gym_id', gymId).gte('starts_at', from).lt('starts_at', to)
    .eq('activity.gym_id', gymId).eq('location.gym_id', gymId).eq('instructor.gym_id', gymId)
    .in('instructor.role', ['owner', 'staff'])
    .eq('bookings.gym_id', gymId).eq('bookings.member_user_id', gymUserId)
    .eq('bookings.economic_versions.gym_id', gymId)
    .eq('waitlist.gym_id', gymId).eq('waitlist.member_user_id', gymUserId).in('waitlist.status', ['waiting', 'offered'])
    .or('bookings.not.is.null,waitlist.not.is.null')
    .or(`starts_at.lte.${new Date().toISOString()},status.neq.scheduled`)
    .order('starts_at').order('id').limit(MEMBER_HISTORY_PAGE_SIZE + 1);
  if (cursor) query = query.or(historyCursorFilter(cursor, 'starts_at', true));
  const { data, error } = await query;
  if (error) throw fromSupabaseError(error);
  const { items, nextCursor } = historyPage(data ?? [], row => row.starts_at);
  const ownBookings = items.flatMap(row => row.bookings?.[0] ? [row.bookings[0]] : []).map(booking => {
    const latest = [...(booking.economic_versions ?? [])].sort((a, b) => b.version - a.version)[0];
    return { booking, paymentId: booking.payment_id ?? latest?.payment_evidence_id };
  });
  const paymentIds = [...new Set(ownBookings.flatMap(({ paymentId }) => paymentId ? [paymentId] : []))];
  const payments = paymentIds.length ? await supabaseAdmin.from('member_payments').select('id,amount,currency,status')
    .eq('gym_id', gymId).eq('member_user_id', gymUserId).in('id', paymentIds) : { data: [], error: null };
  if (payments.error) throw fromSupabaseError(payments.error);
  const paymentById = new Map((payments.data ?? []).map(payment => [payment.id, payment]));
  const bookingById = new Map(ownBookings.map(({ booking, paymentId }) => [booking.id, {
    id: booking.id, status: booking.status, payment_id: booking.payment_id,
    ...classBookingEconomics(booking, booking.economic_versions ?? [], paymentId ? paymentById.get(paymentId) : undefined),
  }]));
  response.setHeader('Cache-Control', 'no-store');
  response.json({ nextCursor, items: items.map(({ bookings, waitlist, instructor, ...schedule }) => {
    const person = Array.isArray(instructor) ? instructor[0] : instructor;
    const profile = Array.isArray(person?.profiles) ? person.profiles[0] : person?.profiles;
    return { ...schedule,
      activity: Array.isArray(schedule.activity) ? schedule.activity[0] ?? null : schedule.activity,
      location: Array.isArray(schedule.location) ? schedule.location[0] ?? null : schedule.location,
      instructor: person ? { name: profile?.full_name ?? person.managed_full_name ?? 'Sin nombre' } : null,
      myBooking: bookings?.[0] ? bookingById.get(bookings[0].id) : null,
      myWaitlist: waitlist?.[0] ?? null,
    };
  }) });
}
