begin;

-- Una actividad puede estar incluida en la membresia o requerir un cobro
-- adicional por reserva. El precio historico se copia al pago confirmado.
create type public.class_billing_mode as enum ('included', 'additional_fee');

alter table public.extra_classes
  add column billing_mode public.class_billing_mode not null default 'included';

update public.extra_classes
set billing_mode = case when price > 0 then 'additional_fee'::public.class_billing_mode
                        else 'included'::public.class_billing_mode end;

alter table public.extra_classes
  add constraint extra_classes_billing_mode_price_chk check (
    (billing_mode = 'included' and price = 0)
    or (billing_mode = 'additional_fee' and price > 0)
  );

-- El instructor valida llegadas sin recibir permisos financieros ni de
-- administracion de clases.
insert into public.permission_catalog(
  key, name, description, supports_pin_elevation, is_sensitive
) values (
  'classes.attendance_manage', 'Controlar asistencia de clases',
  'Permite al instructor asignado marcar asistencia o inasistencia.', true, false
) on conflict (key) do nothing;

insert into public.staff_permissions(
  gym_id, staff_user_id, permission_key, access_mode, granted_by
)
select staff.gym_id, staff.id, 'classes.attendance_manage', 'denied', owner_user.id
from public.gym_users staff
join lateral (
  select owner_record.id
  from public.gym_users owner_record
  where owner_record.gym_id = staff.gym_id
    and owner_record.role = 'owner'
    and owner_record.status = 'active'
  order by owner_record.created_at
  limit 1
) owner_user on true
where staff.role = 'staff'
on conflict (staff_user_id, permission_key) do nothing;

-- Trazabilidad de programacion, reservas y control del instructor.
alter table public.class_schedules
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references public.gym_users(id),
  add column cancellation_reason text;

alter table public.class_bookings
  add column booked_by uuid references public.gym_users(id),
  add column cancelled_by uuid references public.gym_users(id),
  add column cancellation_reason text,
  add column attendance_marked_at timestamptz,
  add column attendance_marked_by uuid references public.gym_users(id);

update public.class_bookings set booked_by = member_user_id where booked_by is null;
alter table public.class_bookings alter column booked_by set not null;

-- Los pagos de clases comparten numeracion, recibos, anulaciones y reportes
-- con los cobros ya existentes, pero conservan su referencia de negocio.
alter table public.member_payments
  add column class_booking_id uuid references public.class_bookings(id);

alter table public.member_payments
  drop constraint member_payments_one_business_reference;

alter table public.member_payments
  add constraint member_payments_one_business_reference check (
    ((membership_id is not null)::integer
      + (sale_id is not null)::integer
      + (class_booking_id is not null)::integer) <= 1
  );

create unique index member_payments_one_live_class_booking_idx
  on public.member_payments(class_booking_id)
  where class_booking_id is not null and status in ('pending', 'confirmed');

create index class_schedules_gym_start_status_idx
  on public.class_schedules(gym_id, starts_at, status);
create index class_bookings_member_created_idx
  on public.class_bookings(gym_id, member_user_id, created_at desc);

-- Amplia la defensa en profundidad de pagos para validar el vinculo de clase.
create or replace function private.validate_member_payment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  member_role public.gym_role;
  member_gym_id uuid;
  membership_gym_id uuid;
  membership_member_id uuid;
  booking_gym_id uuid;
  booking_member_id uuid;
  booking_location_id uuid;
  actor_profile_id uuid;
  actor_role public.gym_role;
  actor_gym_id uuid;
  actor_status public.gym_user_status;
  location_gym_id uuid;
begin
  if new.member_user_id is not null then
    select gu.role, gu.gym_id into member_role, member_gym_id
    from public.gym_users gu where gu.id = new.member_user_id;
    if member_role is distinct from 'member' or member_gym_id is distinct from new.gym_id then
      raise exception 'PAYMENT_MEMBER_MUST_BELONG_TO_SAME_GYM' using errcode = '23514';
    end if;
  end if;

  if new.membership_id is not null then
    select m.gym_id, m.member_user_id into membership_gym_id, membership_member_id
    from public.memberships m where m.id = new.membership_id;
    if membership_gym_id is distinct from new.gym_id
       or new.member_user_id is null
       or membership_member_id is distinct from new.member_user_id then
      raise exception 'PAYMENT_MEMBERSHIP_MISMATCH' using errcode = '23514';
    end if;
  end if;

  if new.class_booking_id is not null then
    select cb.gym_id, cb.member_user_id, cs.location_id
      into booking_gym_id, booking_member_id, booking_location_id
    from public.class_bookings cb
    join public.class_schedules cs on cs.id = cb.class_schedule_id
    where cb.id = new.class_booking_id;
    if booking_gym_id is distinct from new.gym_id
       or booking_member_id is distinct from new.member_user_id
       or booking_location_id is distinct from new.location_id then
      raise exception 'PAYMENT_CLASS_BOOKING_MISMATCH' using errcode = '23514';
    end if;
  end if;

  select gl.gym_id into location_gym_id
  from public.gym_locations gl where gl.id = new.location_id and gl.is_active = true;
  if location_gym_id is distinct from new.gym_id then
    raise exception 'PAYMENT_LOCATION_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;

  select gu.profile_id, gu.role, gu.gym_id, gu.status
    into actor_profile_id, actor_role, actor_gym_id, actor_status
  from public.gym_users gu where gu.id = new.registered_by;
  if actor_role not in ('owner', 'staff')
     or actor_gym_id is distinct from new.gym_id
     or actor_status is distinct from 'active' then
    raise exception 'PAYMENT_REGISTERER_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and (select auth.uid()) is not null
     and actor_profile_id <> (select auth.uid()) then
    raise exception 'PAYMENT_REGISTERER_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
  end if;

  if new.status = 'voided' and not exists (
    select 1 from public.gym_users gu
    where gu.id = new.voided_by and gu.gym_id = new.gym_id
      and gu.role in ('owner', 'staff') and gu.status = 'active'
  ) then
    raise exception 'PAYMENT_VOIDER_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;
  if new.status = 'voided' and (select auth.uid()) is not null and not exists (
    select 1 from public.gym_users gu
    where gu.id = new.voided_by and gu.profile_id = (select auth.uid())
  ) then
    raise exception 'PAYMENT_VOIDER_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_member_payment() from public, anon, authenticated;

create or replace function private.protect_confirmed_payment_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'confirmed' and (
    new.gym_id is distinct from old.gym_id
    or new.location_id is distinct from old.location_id
    or new.member_user_id is distinct from old.member_user_id
    or new.membership_id is distinct from old.membership_id
    or new.sale_id is distinct from old.sale_id
    or new.class_booking_id is distinct from old.class_booking_id
    or new.amount is distinct from old.amount
    or new.currency is distinct from old.currency
    or new.payment_method is distinct from old.payment_method
    or new.external_reference is distinct from old.external_reference
    or new.registered_by is distinct from old.registered_by
    or new.paid_at is distinct from old.paid_at
  ) then
    raise exception 'CONFIRMED_PAYMENT_FINANCIAL_FIELDS_ARE_IMMUTABLE' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_confirmed_payment_fields() from public, anon, authenticated;

create or replace function private.authorize_class_backend_actor(
  target_gym_id uuid,
  target_actor_gym_user_id uuid,
  requested_permission text,
  supplied_used_pin_elevation boolean
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_record record;
  actor_access_mode public.permission_access_mode;
begin
  if requested_permission not in (
    'classes.manage', 'classes.bookings_manage', 'classes.attendance_manage'
  ) then
    raise exception 'INVALID_CLASS_PERMISSION' using errcode = '22023';
  end if;
  select gu.profile_id, gu.role, gu.status, gu.account_mode
    into actor_record
  from public.gym_users gu
  where gu.id = target_actor_gym_user_id and gu.gym_id = target_gym_id;
  if not found or actor_record.profile_id is null or actor_record.status <> 'active'
     or actor_record.account_mode <> 'portal' then
    raise exception 'CLASS_ACTOR_MUST_BE_ACTIVE_IN_GYM' using errcode = '42501';
  end if;
  if actor_record.role = 'owner' then return actor_record.profile_id; end if;
  if actor_record.role <> 'staff' then
    raise exception 'CLASS_ACTOR_ROLE_DENIED' using errcode = '42501';
  end if;
  select sp.access_mode into actor_access_mode
  from public.staff_permissions sp
  where sp.gym_id = target_gym_id
    and sp.staff_user_id = target_actor_gym_user_id
    and sp.permission_key = requested_permission;
  if actor_access_mode = 'allowed'
     or (actor_access_mode = 'requires_pin' and coalesce(supplied_used_pin_elevation, false)) then
    return actor_record.profile_id;
  end if;
  raise exception 'CLASS_PERMISSION_DENIED' using errcode = '42501';
end;
$$;

revoke all on function private.authorize_class_backend_actor(uuid, uuid, text, boolean)
  from public, anon, authenticated;

create or replace function private.class_member_coverage(
  target_gym_id uuid,
  target_member_user_id uuid,
  class_starts_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  covered_membership_id uuid;
  gym_timezone text;
  class_date date;
begin
  if not exists (
    select 1 from public.gym_users gu
    where gu.id = target_member_user_id and gu.gym_id = target_gym_id
      and gu.role = 'member' and gu.status = 'active'
  ) then
    raise exception 'CLASS_BOOKING_REQUIRES_ACTIVE_MEMBER' using errcode = '23514';
  end if;
  select g.timezone into gym_timezone from public.gyms g where g.id = target_gym_id;
  class_date := (class_starts_at at time zone gym_timezone)::date;
  select m.id into covered_membership_id
  from public.memberships m
  join public.membership_periods mp on mp.membership_id = m.id
  where m.gym_id = target_gym_id
    and m.member_user_id = target_member_user_id
    and m.status <> 'cancelled'
    and mp.status <> 'cancelled'
    and class_date between mp.starts_on and mp.ends_on
  order by mp.ends_on desc
  limit 1;
  if covered_membership_id is null then
    raise exception 'CLASS_ACTIVE_MEMBERSHIP_COVERAGE_REQUIRED' using errcode = '23514';
  end if;
  return covered_membership_id;
end;
$$;

revoke all on function private.class_member_coverage(uuid, uuid, timestamptz)
  from public, anon, authenticated;

create or replace function public.create_extra_class_backend(
  target_gym_id uuid,
  target_actor_gym_user_id uuid,
  supplied_name text,
  supplied_description text,
  supplied_billing_mode public.class_billing_mode,
  supplied_price numeric,
  supplied_currency text,
  supplied_capacity integer,
  supplied_duration_minutes integer,
  supplied_used_pin_elevation boolean
)
returns public.extra_classes
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  created_class public.extra_classes;
begin
  actor_profile_id := private.authorize_class_backend_actor(
    target_gym_id, target_actor_gym_user_id, 'classes.manage', supplied_used_pin_elevation
  );
  if supplied_name is null or char_length(trim(supplied_name)) not between 2 and 120
     or supplied_billing_mode is null or supplied_price is null
     or (supplied_billing_mode = 'included' and supplied_price <> 0)
     or (supplied_billing_mode = 'additional_fee' and supplied_price <= 0)
     or supplied_currency !~ '^[A-Z]{3}$'
     or supplied_capacity not between 1 and 10000
     or supplied_duration_minutes not between 10 and 1440 then
    raise exception 'INVALID_EXTRA_CLASS_INPUT' using errcode = '22023';
  end if;
  insert into public.extra_classes(
    gym_id, name, description, billing_mode, price, currency, capacity, duration_minutes
  ) values (
    target_gym_id, trim(supplied_name), nullif(trim(supplied_description), ''),
    supplied_billing_mode, supplied_price, supplied_currency,
    supplied_capacity, supplied_duration_minutes
  ) returning * into created_class;
  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'class.created', 'extra_class', created_class.id, 'classes.manage',
    coalesce(supplied_used_pin_elevation, false), to_jsonb(created_class)
  );
  return created_class;
end;
$$;

revoke all on function public.create_extra_class_backend(
  uuid, uuid, text, text, public.class_billing_mode, numeric, text, integer, integer, boolean
) from public, anon, authenticated;
grant execute on function public.create_extra_class_backend(
  uuid, uuid, text, text, public.class_billing_mode, numeric, text, integer, integer, boolean
) to service_role;

create or replace function public.update_extra_class_backend(
  target_gym_id uuid,
  target_extra_class_id uuid,
  target_actor_gym_user_id uuid,
  supplied_name text,
  supplied_description text,
  supplied_billing_mode public.class_billing_mode,
  supplied_price numeric,
  supplied_currency text,
  supplied_capacity integer,
  supplied_duration_minutes integer,
  supplied_is_active boolean,
  supplied_used_pin_elevation boolean
)
returns public.extra_classes
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  before_class public.extra_classes;
  updated_class public.extra_classes;
begin
  actor_profile_id := private.authorize_class_backend_actor(
    target_gym_id, target_actor_gym_user_id, 'classes.manage', supplied_used_pin_elevation
  );
  select * into before_class from public.extra_classes
  where id = target_extra_class_id and gym_id = target_gym_id for update;
  if not found then raise exception 'EXTRA_CLASS_NOT_FOUND' using errcode = 'P0002'; end if;
  if supplied_name is null or char_length(trim(supplied_name)) not between 2 and 120
     or supplied_billing_mode is null or supplied_price is null
     or (supplied_billing_mode = 'included' and supplied_price <> 0)
     or (supplied_billing_mode = 'additional_fee' and supplied_price <= 0)
     or supplied_currency !~ '^[A-Z]{3}$'
     or supplied_capacity not between 1 and 10000
     or supplied_duration_minutes not between 10 and 1440
     or supplied_is_active is null then
    raise exception 'INVALID_EXTRA_CLASS_INPUT' using errcode = '22023';
  end if;
  update public.extra_classes ec
  set name = trim(supplied_name), description = nullif(trim(supplied_description), ''),
      billing_mode = supplied_billing_mode, price = supplied_price,
      currency = supplied_currency, capacity = supplied_capacity,
      duration_minutes = supplied_duration_minutes, is_active = supplied_is_active
  where ec.id = target_extra_class_id and ec.gym_id = target_gym_id
  returning * into updated_class;
  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'class.updated', 'extra_class', updated_class.id, 'classes.manage',
    coalesce(supplied_used_pin_elevation, false), to_jsonb(before_class), to_jsonb(updated_class)
  );
  return updated_class;
end;
$$;

revoke all on function public.update_extra_class_backend(
  uuid, uuid, uuid, text, text, public.class_billing_mode, numeric, text, integer, integer, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.update_extra_class_backend(
  uuid, uuid, uuid, text, text, public.class_billing_mode, numeric, text, integer, integer, boolean, boolean
) to service_role;

create or replace function public.create_class_schedule_backend(
  target_gym_id uuid,
  target_extra_class_id uuid,
  target_location_id uuid,
  target_instructor_user_id uuid,
  supplied_starts_at timestamptz,
  supplied_capacity_override integer,
  target_actor_gym_user_id uuid,
  supplied_used_pin_elevation boolean
)
returns public.class_schedules
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  activity_record public.extra_classes;
  created_schedule public.class_schedules;
begin
  actor_profile_id := private.authorize_class_backend_actor(
    target_gym_id, target_actor_gym_user_id, 'classes.manage', supplied_used_pin_elevation
  );
  select * into activity_record from public.extra_classes
  where id = target_extra_class_id and gym_id = target_gym_id and is_active;
  if not found then raise exception 'EXTRA_CLASS_NOT_FOUND' using errcode = 'P0002'; end if;
  if supplied_starts_at is null or supplied_starts_at <= now()
     or (supplied_capacity_override is not null and supplied_capacity_override not between 1 and 10000) then
    raise exception 'INVALID_CLASS_SCHEDULE_INPUT' using errcode = '22023';
  end if;
  insert into public.class_schedules(
    gym_id, location_id, extra_class_id, instructor_user_id,
    starts_at, ends_at, capacity_override
  ) values (
    target_gym_id, target_location_id, target_extra_class_id,
    target_instructor_user_id, supplied_starts_at,
    supplied_starts_at + make_interval(mins => activity_record.duration_minutes),
    supplied_capacity_override
  ) returning * into created_schedule;
  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'class.schedule_created', 'class_schedule', created_schedule.id,
    'classes.manage', coalesce(supplied_used_pin_elevation, false),
    to_jsonb(created_schedule)
  );
  return created_schedule;
end;
$$;

revoke all on function public.create_class_schedule_backend(
  uuid, uuid, uuid, uuid, timestamptz, integer, uuid, boolean
) from public, anon, authenticated;
grant execute on function public.create_class_schedule_backend(
  uuid, uuid, uuid, uuid, timestamptz, integer, uuid, boolean
) to service_role;

create or replace function public.cancel_class_schedule_backend(
  target_gym_id uuid,
  target_class_schedule_id uuid,
  target_actor_gym_user_id uuid,
  supplied_reason text,
  supplied_used_pin_elevation boolean
)
returns public.class_schedules
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  before_schedule public.class_schedules;
  cancelled_schedule public.class_schedules;
begin
  actor_profile_id := private.authorize_class_backend_actor(
    target_gym_id, target_actor_gym_user_id, 'classes.manage', supplied_used_pin_elevation
  );
  if nullif(trim(supplied_reason), '') is null then
    raise exception 'CLASS_CANCELLATION_REASON_REQUIRED' using errcode = '22023';
  end if;
  select * into before_schedule from public.class_schedules
  where id = target_class_schedule_id and gym_id = target_gym_id
    and status = 'scheduled' for update;
  if not found then raise exception 'CLASS_SCHEDULE_NOT_CANCELLABLE' using errcode = 'P0002'; end if;
  if exists (
    select 1
    from public.class_bookings cb
    join public.member_payments mp on mp.id = cb.payment_id
    where cb.class_schedule_id = target_class_schedule_id
      and cb.status = 'reserved'
      and mp.status = 'confirmed'
  ) then
    raise exception 'CLASS_SCHEDULE_HAS_PAID_BOOKINGS' using errcode = '23514';
  end if;
  update public.class_schedules cs
  set status = 'cancelled', cancelled_at = now(), cancelled_by = target_actor_gym_user_id,
      cancellation_reason = trim(supplied_reason)
  where cs.id = target_class_schedule_id
  returning * into cancelled_schedule;
  update public.class_bookings cb
  set status = 'cancelled', cancelled_at = now(), cancelled_by = target_actor_gym_user_id,
      cancellation_reason = 'Clase cancelada: ' || trim(supplied_reason)
  where cb.class_schedule_id = target_class_schedule_id and cb.status = 'reserved';
  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'class.schedule_cancelled', 'class_schedule', target_class_schedule_id,
    'classes.manage', coalesce(supplied_used_pin_elevation, false),
    to_jsonb(before_schedule), to_jsonb(cancelled_schedule)
  );
  return cancelled_schedule;
end;
$$;

revoke all on function public.cancel_class_schedule_backend(uuid, uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.cancel_class_schedule_backend(uuid, uuid, uuid, text, boolean)
  to service_role;

create or replace function public.reserve_included_class_backend(
  target_gym_id uuid,
  target_class_schedule_id uuid,
  target_member_user_id uuid,
  target_actor_gym_user_id uuid,
  supplied_used_pin_elevation boolean
)
returns public.class_bookings
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_record record;
  actor_profile_id uuid;
  schedule_record record;
  existing_booking public.class_bookings;
  reserved_booking public.class_bookings;
begin
  select gu.profile_id, gu.role, gu.status, gu.account_mode
    into actor_record from public.gym_users gu
  where gu.id = target_actor_gym_user_id and gu.gym_id = target_gym_id;
  if not found or actor_record.profile_id is null or actor_record.status <> 'active'
     or actor_record.account_mode <> 'portal' then
    raise exception 'CLASS_ACTOR_MUST_BE_ACTIVE_IN_GYM' using errcode = '42501';
  end if;
  if actor_record.role = 'member' then
    if target_actor_gym_user_id is distinct from target_member_user_id then
      raise exception 'MEMBER_CAN_ONLY_BOOK_SELF' using errcode = '42501';
    end if;
    actor_profile_id := actor_record.profile_id;
  else
    actor_profile_id := private.authorize_class_backend_actor(
      target_gym_id, target_actor_gym_user_id, 'classes.bookings_manage',
      supplied_used_pin_elevation
    );
  end if;
  select cs.starts_at, cs.status, ec.billing_mode
    into schedule_record
  from public.class_schedules cs
  join public.extra_classes ec on ec.id = cs.extra_class_id
  where cs.id = target_class_schedule_id and cs.gym_id = target_gym_id
  for update of cs;
  if not found or schedule_record.status <> 'scheduled' or schedule_record.starts_at <= now() then
    raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode = '23514';
  end if;
  if schedule_record.billing_mode <> 'included' then
    raise exception 'CLASS_REQUIRES_RECEPTION_PAYMENT' using errcode = '23514';
  end if;
  perform private.class_member_coverage(target_gym_id, target_member_user_id, schedule_record.starts_at);
  select * into existing_booking from public.class_bookings cb
  where cb.class_schedule_id = target_class_schedule_id
    and cb.member_user_id = target_member_user_id for update;
  if found and existing_booking.status <> 'cancelled' then
    raise exception 'CLASS_BOOKING_ALREADY_EXISTS' using errcode = '23505';
  end if;
  if found then
    update public.class_bookings cb
    set status = 'reserved', booked_at = now(), booked_by = target_actor_gym_user_id,
        cancelled_at = null, cancelled_by = null, cancellation_reason = null,
        attendance_marked_at = null, attendance_marked_by = null, payment_id = null
    where cb.id = existing_booking.id returning * into reserved_booking;
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
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'class.booking_created', 'class_booking', reserved_booking.id,
    case when actor_record.role = 'member' then null else 'classes.bookings_manage' end,
    case when actor_record.role = 'member' then false else coalesce(supplied_used_pin_elevation, false) end,
    jsonb_build_object('schedule_id', target_class_schedule_id, 'member_user_id', target_member_user_id, 'billing_mode', 'included')
  );
  return reserved_booking;
end;
$$;

revoke all on function public.reserve_included_class_backend(uuid, uuid, uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.reserve_included_class_backend(uuid, uuid, uuid, uuid, boolean)
  to service_role;

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
begin
  actor_profile_id := private.authorize_class_backend_actor(
    target_gym_id, target_actor_gym_user_id, 'classes.bookings_manage',
    supplied_used_pin_elevation
  );
  -- El PIN consumido pertenece a reservas. Para cobrar, payments.register debe
  -- estar permitido directamente; un segundo PIN nunca se reutiliza.
  perform private.authorize_financial_backend_actor(
    target_gym_id, target_actor_gym_user_id, 'payments.register', false
  );
  select cs.starts_at, cs.status, cs.location_id, ec.billing_mode,
         ec.price, ec.currency, ec.name
    into schedule_record
  from public.class_schedules cs
  join public.extra_classes ec on ec.id = cs.extra_class_id
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
  perform private.class_member_coverage(target_gym_id, target_member_user_id, schedule_record.starts_at);
  select * into existing_booking from public.class_bookings cb
  where cb.class_schedule_id = target_class_schedule_id
    and cb.member_user_id = target_member_user_id for update;
  if found and existing_booking.status <> 'cancelled' then
    raise exception 'CLASS_BOOKING_ALREADY_EXISTS' using errcode = '23505';
  end if;
  if found then
    update public.class_bookings cb
    set status = 'reserved', booked_at = now(), booked_by = target_actor_gym_user_id,
        cancelled_at = null, cancelled_by = null, cancellation_reason = null,
        attendance_marked_at = null, attendance_marked_by = null, payment_id = null
    where cb.id = existing_booking.id returning * into reserved_booking;
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
  update public.class_bookings cb set payment_id = created_payment.id
  where cb.id = reserved_booking.id returning * into reserved_booking;
  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'class.paid_booking_created', 'class_booking', reserved_booking.id,
    'classes.bookings_manage', coalesce(supplied_used_pin_elevation, false),
    jsonb_build_object('schedule_id', target_class_schedule_id, 'member_user_id', target_member_user_id,
      'payment_id', created_payment.id, 'receipt_number', created_payment.receipt_number,
      'amount', created_payment.amount, 'currency', created_payment.currency)
  );
  return query select reserved_booking.id, created_payment.id, created_payment.receipt_number;
end;
$$;

revoke all on function public.reserve_paid_class_backend(
  uuid, uuid, uuid, uuid, public.member_payment_method, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.reserve_paid_class_backend(
  uuid, uuid, uuid, uuid, public.member_payment_method, text, text, boolean
) to service_role;

create or replace function public.cancel_class_booking_backend(
  target_gym_id uuid,
  target_class_booking_id uuid,
  target_actor_gym_user_id uuid,
  supplied_reason text,
  supplied_used_pin_elevation boolean
)
returns public.class_bookings
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_record record;
  actor_profile_id uuid;
  before_booking public.class_bookings;
  cancelled_booking public.class_bookings;
  class_starts_at timestamptz;
begin
  if nullif(trim(supplied_reason), '') is null then
    raise exception 'CLASS_BOOKING_CANCELLATION_REASON_REQUIRED' using errcode = '22023';
  end if;
  select gu.profile_id, gu.role, gu.status, gu.account_mode
    into actor_record from public.gym_users gu
  where gu.id = target_actor_gym_user_id and gu.gym_id = target_gym_id;
  if not found or actor_record.profile_id is null or actor_record.status <> 'active'
     or actor_record.account_mode <> 'portal' then
    raise exception 'CLASS_ACTOR_MUST_BE_ACTIVE_IN_GYM' using errcode = '42501';
  end if;
  select cb.* into before_booking
  from public.class_bookings cb
  where cb.id = target_class_booking_id and cb.gym_id = target_gym_id
    and cb.status = 'reserved' for update of cb;
  if not found then raise exception 'CLASS_BOOKING_NOT_CANCELLABLE' using errcode = 'P0002'; end if;
  select cs.starts_at into class_starts_at from public.class_schedules cs
  where cs.id = before_booking.class_schedule_id;
  if class_starts_at <= now() then
    raise exception 'PAST_CLASS_BOOKING_CANNOT_BE_CANCELLED' using errcode = '23514';
  end if;
  if actor_record.role = 'member' then
    if before_booking.member_user_id is distinct from target_actor_gym_user_id then
      raise exception 'MEMBER_CAN_ONLY_CANCEL_SELF' using errcode = '42501';
    end if;
    if before_booking.payment_id is not null then
      raise exception 'PAID_CLASS_CANCELLATION_REQUIRES_RECEPTION' using errcode = '23514';
    end if;
    actor_profile_id := actor_record.profile_id;
  else
    actor_profile_id := private.authorize_class_backend_actor(
      target_gym_id, target_actor_gym_user_id, 'classes.bookings_manage', supplied_used_pin_elevation
    );
  end if;
  update public.class_bookings cb
  set status = 'cancelled', cancelled_at = now(), cancelled_by = target_actor_gym_user_id,
      cancellation_reason = trim(supplied_reason)
  where cb.id = target_class_booking_id returning * into cancelled_booking;
  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'class.booking_cancelled', 'class_booking', target_class_booking_id,
    case when actor_record.role = 'member' then null else 'classes.bookings_manage' end,
    case when actor_record.role = 'member' then false else coalesce(supplied_used_pin_elevation, false) end,
    to_jsonb(before_booking), to_jsonb(cancelled_booking)
  );
  return cancelled_booking;
end;
$$;

revoke all on function public.cancel_class_booking_backend(uuid, uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.cancel_class_booking_backend(uuid, uuid, uuid, text, boolean)
  to service_role;

create or replace function public.mark_class_booking_attendance_backend(
  target_gym_id uuid,
  target_class_booking_id uuid,
  target_actor_gym_user_id uuid,
  target_status public.class_booking_status,
  supplied_used_pin_elevation boolean
)
returns public.class_bookings
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  booking_record record;
  updated_booking public.class_bookings;
begin
  actor_profile_id := private.authorize_class_backend_actor(
    target_gym_id, target_actor_gym_user_id, 'classes.attendance_manage',
    supplied_used_pin_elevation
  );
  if target_status not in ('attended', 'no_show') then
    raise exception 'INVALID_CLASS_ATTENDANCE_STATUS' using errcode = '22023';
  end if;
  select cb.*, cs.starts_at, cs.ends_at, cs.status as schedule_status,
         cs.instructor_user_id
    into booking_record
  from public.class_bookings cb
  join public.class_schedules cs on cs.id = cb.class_schedule_id
  where cb.id = target_class_booking_id and cb.gym_id = target_gym_id
    and cb.status = 'reserved' for update of cb;
  if not found or booking_record.schedule_status = 'cancelled' then
    raise exception 'CLASS_BOOKING_NOT_READY_FOR_ATTENDANCE' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.gym_users gu
    where gu.id = target_actor_gym_user_id and gu.gym_id = target_gym_id
      and (gu.role = 'owner' or booking_record.instructor_user_id = gu.id)
  ) then
    raise exception 'ONLY_ASSIGNED_INSTRUCTOR_CAN_MARK_ATTENDANCE' using errcode = '42501';
  end if;
  if target_status = 'attended'
     and now() not between booking_record.starts_at - interval '2 hours'
                       and booking_record.ends_at + interval '24 hours' then
    raise exception 'CLASS_ATTENDANCE_OUTSIDE_ALLOWED_WINDOW' using errcode = '23514';
  end if;
  if target_status = 'no_show' and now() < booking_record.ends_at then
    raise exception 'CLASS_NO_SHOW_ONLY_AFTER_END' using errcode = '23514';
  end if;
  update public.class_bookings cb
  set status = target_status, attendance_marked_at = now(),
      attendance_marked_by = target_actor_gym_user_id
  where cb.id = target_class_booking_id returning * into updated_booking;
  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    case when target_status = 'attended' then 'class.booking_attended' else 'class.booking_no_show' end,
    'class_booking', target_class_booking_id, 'classes.attendance_manage',
    coalesce(supplied_used_pin_elevation, false),
    jsonb_build_object('status', 'reserved'), jsonb_build_object('status', target_status)
  );
  return updated_booking;
end;
$$;

revoke all on function public.mark_class_booking_attendance_backend(
  uuid, uuid, uuid, public.class_booking_status, boolean
) from public, anon, authenticated;
grant execute on function public.mark_class_booking_attendance_backend(
  uuid, uuid, uuid, public.class_booking_status, boolean
) to service_role;

create or replace function public.refund_class_booking_backend(
  target_gym_id uuid,
  target_class_booking_id uuid,
  target_actor_gym_user_id uuid,
  supplied_reason text,
  supplied_used_pin_elevation boolean
)
returns table(booking_id uuid, payment_id uuid, payment_status public.payment_status)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  booking_record public.class_bookings;
  payment_record public.member_payments;
begin
  actor_profile_id := private.authorize_financial_backend_actor(
    target_gym_id, target_actor_gym_user_id, 'payments.void', supplied_used_pin_elevation
  );
  -- Ademas del permiso financiero, el operador debe administrar reservas sin
  -- reutilizar la elevacion financiera como autorizacion de clases.
  perform private.authorize_class_backend_actor(
    target_gym_id, target_actor_gym_user_id, 'classes.bookings_manage', false
  );
  if nullif(trim(supplied_reason), '') is null then
    raise exception 'CLASS_REFUND_REASON_REQUIRED' using errcode = '22023';
  end if;
  select * into booking_record from public.class_bookings cb
  where cb.id = target_class_booking_id and cb.gym_id = target_gym_id for update;
  if not found or booking_record.payment_id is null then
    raise exception 'PAID_CLASS_BOOKING_NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into payment_record from public.member_payments mp
  where mp.id = booking_record.payment_id and mp.gym_id = target_gym_id
    and mp.class_booking_id = booking_record.id and mp.status = 'confirmed' for update;
  if not found then raise exception 'REVERSIBLE_CLASS_PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if booking_record.status = 'reserved' then
    update public.class_bookings cb
    set status = 'cancelled', cancelled_at = now(), cancelled_by = target_actor_gym_user_id,
        cancellation_reason = 'Reembolso: ' || trim(supplied_reason)
    where cb.id = booking_record.id;
  end if;
  update public.member_payments mp
  set status = 'refunded', refunded_at = now(), refunded_by = target_actor_gym_user_id,
      refund_reason = trim(supplied_reason)
  where mp.id = payment_record.id;
  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'class.booking_refunded', 'class_booking', booking_record.id,
    'payments.void', coalesce(supplied_used_pin_elevation, false),
    jsonb_build_object('payment_status', 'confirmed'),
    jsonb_build_object('payment_status', 'refunded', 'reason', trim(supplied_reason))
  );
  return query select booking_record.id, payment_record.id, 'refunded'::public.payment_status;
end;
$$;

revoke all on function public.refund_class_booking_backend(uuid, uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.refund_class_booking_backend(uuid, uuid, uuid, text, boolean)
  to service_role;

commit;
