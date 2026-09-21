begin;
set local lock_timeout = '5s';

-- A member may reserve either an included class or an additional-fee class.
-- Additional-fee reservations deliberately remain unpaid until reception
-- records the real-world payment. Capacity is still protected by the existing
-- class_bookings trigger while the schedule row is locked here.
create or replace function public.reserve_member_class_backend(
  target_gym_id uuid,
  target_class_schedule_id uuid,
  target_member_user_id uuid,
  target_actor_gym_user_id uuid
)
returns public.class_bookings
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_record record;
  schedule_record record;
  existing_booking public.class_bookings;
  reserved_booking public.class_bookings;
  booking_exists boolean := false;
begin
  select gu.profile_id, gu.role, gu.status, gu.account_mode
    into actor_record
  from public.gym_users gu
  where gu.id = target_actor_gym_user_id
    and gu.gym_id = target_gym_id;

  if not found or actor_record.profile_id is null
     or actor_record.role <> 'member'
     or actor_record.status <> 'active'
     or actor_record.account_mode <> 'portal'
     or target_actor_gym_user_id is distinct from target_member_user_id then
    raise exception 'MEMBER_CAN_ONLY_BOOK_SELF' using errcode = '42501';
  end if;

  select cs.starts_at, cs.status, ec.billing_mode, ec.price, ec.currency
    into schedule_record
  from public.class_schedules cs
  join public.extra_classes ec
    on ec.id = cs.extra_class_id and ec.gym_id = cs.gym_id
  where cs.id = target_class_schedule_id
    and cs.gym_id = target_gym_id
    and ec.is_active = true
  for update of cs;

  if not found or schedule_record.status <> 'scheduled' or schedule_record.starts_at <= now() then
    raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode = '23514';
  end if;
  if schedule_record.billing_mode not in ('included', 'additional_fee') then
    raise exception 'CLASS_BILLING_MODE_NOT_SUPPORTED' using errcode = '23514';
  end if;
  if schedule_record.billing_mode = 'additional_fee' and schedule_record.price <= 0 then
    raise exception 'CLASS_ADDITIONAL_PRICE_REQUIRED' using errcode = '23514';
  end if;

  perform private.class_member_coverage(
    target_gym_id, target_member_user_id, schedule_record.starts_at
  );

  select * into existing_booking
  from public.class_bookings cb
  where cb.class_schedule_id = target_class_schedule_id
    and cb.member_user_id = target_member_user_id
  for update;
  booking_exists := found;

  if booking_exists and existing_booking.status <> 'cancelled' then
    raise exception 'CLASS_BOOKING_ALREADY_EXISTS' using errcode = '23505';
  end if;
  if booking_exists and existing_booking.payment_id is not null then
    raise exception 'CLASS_BOOKING_REQUIRES_RECEPTION' using errcode = '23514';
  end if;

  if booking_exists then
    update public.class_bookings cb
    set status = 'reserved', booked_at = now(), booked_by = target_actor_gym_user_id,
        cancelled_at = null, cancelled_by = null, cancellation_reason = null,
        attendance_marked_at = null, attendance_marked_by = null, payment_id = null
    where cb.id = existing_booking.id
    returning * into reserved_booking;
  else
    insert into public.class_bookings(
      gym_id, class_schedule_id, member_user_id, status, booked_by
    ) values (
      target_gym_id, target_class_schedule_id, target_member_user_id,
      'reserved', target_actor_gym_user_id
    ) returning * into reserved_booking;
  end if;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, after_data
  ) values (
    target_gym_id, actor_record.profile_id, target_actor_gym_user_id,
    case when schedule_record.billing_mode = 'additional_fee'
      then 'class.unpaid_booking_created'
      else 'class.booking_created'
    end,
    'class_booking', reserved_booking.id, null, false,
    jsonb_build_object(
      'schedule_id', target_class_schedule_id,
      'member_user_id', target_member_user_id,
      'billing_mode', schedule_record.billing_mode,
      'payment_status', case when schedule_record.billing_mode = 'additional_fee'
        then 'pending_at_reception' else 'included' end,
      'amount', case when schedule_record.billing_mode = 'additional_fee'
        then schedule_record.price else 0 end,
      'currency', schedule_record.currency
    )
  );

  return reserved_booking;
end;
$$;

revoke all on function public.reserve_member_class_backend(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_member_class_backend(uuid, uuid, uuid, uuid)
  to service_role;

-- Reception can now confirm payment against an existing unpaid reservation.
-- The booking row is locked before creating the payment, making retries safe
-- and preventing two cashiers from charging the same reservation twice.
create or replace function public.reserve_paid_class_backend(
  target_gym_id uuid,
  target_class_schedule_id uuid,
  target_member_user_id uuid,
  target_actor_gym_user_id uuid,
  supplied_payment_method public.member_payment_method,
  supplied_external_reference text,
  supplied_notes text,
  supplied_used_pin_elevation boolean
)
returns table(booking_id uuid, payment_id uuid, receipt_number bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  schedule_record record;
  existing_booking public.class_bookings;
  reserved_booking public.class_bookings;
  created_payment public.member_payments;
  booking_exists boolean := false;
  booking_preexisted boolean := false;
begin
  actor_profile_id := private.authorize_class_backend_actor(
    target_gym_id, target_actor_gym_user_id, 'classes.bookings_manage',
    supplied_used_pin_elevation
  );
  perform private.authorize_financial_backend_actor(
    target_gym_id, target_actor_gym_user_id, 'payments.register', false
  );

  select cs.starts_at, cs.status, cs.location_id, ec.billing_mode,
         ec.price, ec.currency, ec.name
    into schedule_record
  from public.class_schedules cs
  join public.extra_classes ec
    on ec.id = cs.extra_class_id and ec.gym_id = cs.gym_id
  where cs.id = target_class_schedule_id and cs.gym_id = target_gym_id
  for update of cs;

  if not found or schedule_record.status <> 'scheduled' or schedule_record.starts_at <= now() then
    raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode = '23514';
  end if;
  if schedule_record.billing_mode <> 'additional_fee' or schedule_record.price <= 0 then
    raise exception 'CLASS_DOES_NOT_REQUIRE_ADDITIONAL_PAYMENT' using errcode = '23514';
  end if;
  if supplied_payment_method is null then
    raise exception 'CLASS_PAYMENT_METHOD_REQUIRED' using errcode = '22023';
  end if;
  if supplied_payment_method in ('bank_transfer', 'external_card', 'external_deuna')
     and nullif(trim(supplied_external_reference), '') is null then
    raise exception 'EXTERNAL_REFERENCE_REQUIRED_FOR_PAYMENT_METHOD' using errcode = '22023';
  end if;

  perform private.class_member_coverage(
    target_gym_id, target_member_user_id, schedule_record.starts_at
  );

  select * into existing_booking
  from public.class_bookings cb
  where cb.class_schedule_id = target_class_schedule_id
    and cb.member_user_id = target_member_user_id
  for update;
  booking_exists := found;

  if booking_exists and existing_booking.status = 'reserved'
     and existing_booking.payment_id is null then
    reserved_booking := existing_booking;
    booking_preexisted := true;
  elsif booking_exists and existing_booking.status = 'cancelled'
        and existing_booking.payment_id is null then
    update public.class_bookings cb
    set status = 'reserved', booked_at = now(), booked_by = target_actor_gym_user_id,
        cancelled_at = null, cancelled_by = null, cancellation_reason = null,
        attendance_marked_at = null, attendance_marked_by = null, payment_id = null
    where cb.id = existing_booking.id
    returning * into reserved_booking;
  elsif booking_exists then
    raise exception 'CLASS_BOOKING_ALREADY_EXISTS' using errcode = '23505';
  else
    insert into public.class_bookings(
      gym_id, class_schedule_id, member_user_id, status, booked_by
    ) values (
      target_gym_id, target_class_schedule_id, target_member_user_id,
      'reserved', target_actor_gym_user_id
    ) returning * into reserved_booking;
  end if;

  insert into public.member_payments(
    gym_id, location_id, member_user_id, class_booking_id, amount, currency,
    payment_method, status, external_reference, notes, registered_by, paid_at
  ) values (
    target_gym_id, schedule_record.location_id, target_member_user_id,
    reserved_booking.id, schedule_record.price, schedule_record.currency,
    supplied_payment_method, 'confirmed', nullif(trim(supplied_external_reference), ''),
    coalesce(nullif(trim(supplied_notes), ''), 'Actividad: ' || schedule_record.name),
    target_actor_gym_user_id, now()
  ) returning * into created_payment;

  update public.class_bookings cb
  set payment_id = created_payment.id
  where cb.id = reserved_booking.id
  returning * into reserved_booking;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    case when booking_preexisted
      then 'class.booking_payment_confirmed'
      else 'class.paid_booking_created'
    end,
    'class_booking', reserved_booking.id, 'classes.bookings_manage',
    coalesce(supplied_used_pin_elevation, false),
    jsonb_build_object(
      'schedule_id', target_class_schedule_id,
      'member_user_id', target_member_user_id,
      'payment_id', created_payment.id,
      'receipt_number', created_payment.receipt_number,
      'amount', created_payment.amount,
      'currency', created_payment.currency,
      'preexisting_reservation', booking_preexisted
    )
  );

  return query
  select reserved_booking.id, created_payment.id, created_payment.receipt_number;
end;
$$;

revoke all on function public.reserve_paid_class_backend(
  uuid, uuid, uuid, uuid, public.member_payment_method, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.reserve_paid_class_backend(
  uuid, uuid, uuid, uuid, public.member_payment_method, text, text, boolean
) to service_role;

commit;
