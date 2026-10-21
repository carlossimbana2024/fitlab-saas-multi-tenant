begin;
set local lock_timeout = '5s';

-- FIT-MEMBER-004. No existing bookings or payments are rewritten.
-- Version 1 for legacy rows means "imported current contracting episode",
-- not a claim that no earlier contracting episodes existed.
create table if not exists public.class_booking_terms (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id),
  booking_id uuid not null references public.class_bookings(id),
  version integer not null check (version > 0),
  billing_mode public.class_billing_mode,
  agreed_amount numeric(12,2),
  currency text check (currency ~ '^[A-Z]{3}$'),
  contracted_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  evidence_state text not null check (evidence_state in ('verified','partial','unknown')),
  source text not null check (source in ('reservation','audit_event','historical_unknown','manual_resolution')),
  audit_event_id bigint references public.audit_logs(id),
  payment_evidence_id uuid references public.member_payments(id),
  cancelled_at timestamptz,
  resolved_by uuid references public.gym_users(id),
  resolved_at timestamptz,
  resolution_reason text,
  supersedes_id uuid references public.class_booking_terms(id),
  unique (booking_id, version),
  check (
    (evidence_state = 'unknown' and billing_mode is null and agreed_amount is null and currency is null)
    or (evidence_state = 'partial' and billing_mode is not null and agreed_amount is not null
      and billing_mode = 'included' and agreed_amount = 0 and currency is null)
    or (evidence_state = 'verified' and billing_mode is not null and agreed_amount is not null and currency is not null
      and ((billing_mode = 'included' and agreed_amount = 0) or (billing_mode = 'additional_fee' and agreed_amount > 0)))
  ),
  check ((source = 'audit_event' and audit_event_id is not null) or (source <> 'audit_event' and audit_event_id is null)),
  check ((source = 'manual_resolution' and resolved_by is not null and resolved_at is not null
    and nullif(trim(resolution_reason),'') is not null and supersedes_id is not null)
    or (source <> 'manual_resolution' and resolved_by is null and resolved_at is null and resolution_reason is null))
);
alter table public.class_booking_terms enable row level security;
revoke all on public.class_booking_terms from public, anon, authenticated, service_role;
grant select on public.class_booking_terms to service_role;

-- Future manual resolution can append a version with attribution. No manual
-- resolution RPC or write permission is introduced by this migration.
create or replace function private.validate_class_booking_terms()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then raise exception 'CLASS_TERMS_ARE_IMMUTABLE'; end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'cancelled_at' - 'payment_evidence_id')
       is distinct from (to_jsonb(old) - 'cancelled_at' - 'payment_evidence_id')
       or (old.cancelled_at is not null and new.cancelled_at is distinct from old.cancelled_at)
       or (old.payment_evidence_id is not null and new.payment_evidence_id is distinct from old.payment_evidence_id) then
      raise exception 'CLASS_TERMS_ARE_IMMUTABLE';
    end if;
  end if;
  if not exists(select 1 from public.class_bookings b where b.id=new.booking_id and b.gym_id=new.gym_id) then
    raise exception 'CLASS_TERMS_TENANT_MISMATCH';
  end if;
  if new.audit_event_id is not null and not exists(select 1 from public.audit_logs a
    where a.id=new.audit_event_id and a.gym_id=new.gym_id and a.entity_id=new.booking_id and a.entity_type='class_booking') then
    raise exception 'CLASS_TERMS_EVIDENCE_MISMATCH';
  end if;
  if new.payment_evidence_id is not null and not exists(select 1 from public.member_payments p
    where p.id=new.payment_evidence_id and p.gym_id=new.gym_id and p.class_booking_id=new.booking_id) then
    raise exception 'CLASS_TERMS_PAYMENT_MISMATCH';
  end if;
  if new.supersedes_id is not null and not exists(select 1 from public.class_booking_terms t
    where t.id=new.supersedes_id and t.gym_id=new.gym_id and t.booking_id=new.booking_id and t.version<new.version) then
    raise exception 'CLASS_TERMS_VERSION_MISMATCH';
  end if;
  if new.resolved_by is not null and not exists(select 1 from public.gym_users u
    where u.id=new.resolved_by and u.gym_id=new.gym_id and u.role in ('owner','staff')) then
    raise exception 'CLASS_TERMS_RESOLVER_MISMATCH';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_class_booking_terms() from public, anon, authenticated;
drop trigger if exists class_booking_terms_validate on public.class_booking_terms;
create trigger class_booking_terms_validate before insert or update or delete on public.class_booking_terms
for each row execute function private.validate_class_booking_terms();

-- The exact transaction timestamp and unique creation event must match the
-- current booked_at episode. Ambiguous/malformed evidence stays unknown.
create or replace function private.import_legacy_class_booking_terms(target_booking uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  b public.class_bookings; a public.audit_logs; candidates integer;
  mode public.class_billing_mode; amount numeric; money_currency text;
  state text := 'unknown'; origin text := 'historical_unknown'; evidence bigint;
  paid_id uuid;
begin
  select * into b from public.class_bookings where id=target_booking for update;
  if not found or exists(select 1 from public.class_booking_terms where booking_id=b.id) then return; end if;
  select count(*) into candidates from public.audit_logs
    where gym_id=b.gym_id and entity_id=b.id and entity_type='class_booking'
      and created_at=b.booked_at
      and action in ('class.booking_created','class.unpaid_booking_created','class.paid_booking_created');
  if candidates=1 then
    select * into a from public.audit_logs
      where gym_id=b.gym_id and entity_id=b.id and entity_type='class_booking'
        and created_at=b.booked_at
        and action in ('class.booking_created','class.unpaid_booking_created','class.paid_booking_created');
    if a.after_data->>'schedule_id'=b.class_schedule_id::text
       and a.after_data->>'member_user_id'=b.member_user_id::text then
      if a.after_data->>'billing_mode'='included' then
        -- Included proves zero obligation, but not an unrecorded currency.
        if not (a.after_data ? 'amount') or a.after_data->>'amount' ~ '^0([.]0+)?$' then
          mode:='included'; amount:=0; state:='partial'; origin:='audit_event'; evidence:=a.id;
          if a.after_data->>'currency' ~ '^[A-Z]{3}$' then money_currency:=a.after_data->>'currency'; state:='verified'; end if;
        end if;
      elsif a.after_data->>'billing_mode'='additional_fee'
         and a.after_data->>'amount' ~ '^[0-9]{1,10}([.][0-9]{1,2})?$'
         and a.after_data->>'currency' ~ '^[A-Z]{3}$' then
        if (a.after_data->>'amount')::numeric>0 then
          mode:='additional_fee'; amount:=(a.after_data->>'amount')::numeric;
          money_currency:=a.after_data->>'currency'; state:='verified'; origin:='audit_event'; evidence:=a.id;
        end if;
      end if;
    end if;
  end if;
  select p.id into paid_id from public.member_payments p
    where p.id=b.payment_id and p.gym_id=b.gym_id and p.class_booking_id=b.id;
  insert into public.class_booking_terms(gym_id,booking_id,version,billing_mode,agreed_amount,currency,
    contracted_at,evidence_state,source,audit_event_id,payment_evidence_id,cancelled_at)
  values(b.gym_id,b.id,1,mode,amount,money_currency,b.booked_at,state,origin,evidence,paid_id,b.cancelled_at);
end;
$$;
revoke all on function private.import_legacy_class_booking_terms(uuid) from public, anon, authenticated, service_role;

-- Hold writers while importing and installing capture triggers; timeout rather
-- than wait indefinitely. A retry does not append/reinterpret imported terms.
lock table public.class_bookings, public.member_payments in share row exclusive mode;
do $$ declare b record; begin
  for b in select cb.id from public.class_bookings cb
    where not exists(select 1 from public.class_booking_terms t where t.booking_id=cb.id)
  loop perform private.import_legacy_class_booking_terms(b.id); end loop;
end; $$;

create or replace function private.capture_class_booking_terms()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  a public.extra_classes; next_version integer; previous_id uuid; capture boolean;
begin
  if tg_op='INSERT' then capture:=true;
  else
    if old.gym_id is distinct from new.gym_id or old.class_schedule_id is distinct from new.class_schedule_id
       or old.member_user_id is distinct from new.member_user_id then
      raise exception 'CLASS_TERMS_BOOKING_IDENTITY_IMMUTABLE';
    end if;
    capture := old.status='cancelled' and new.status='reserved';
    if new.status='cancelled' and old.status<>'cancelled' then
      update public.class_booking_terms set cancelled_at=new.cancelled_at
      where id=(select id from public.class_booking_terms where booking_id=new.id order by version desc limit 1);
    end if;
  end if;
  if capture then
    select ec.* into a from public.extra_classes ec
    join public.class_schedules cs on cs.extra_class_id=ec.id and cs.gym_id=ec.gym_id
    where cs.id=new.class_schedule_id and cs.gym_id=new.gym_id for share of ec;
    if not found then raise exception 'CLASS_TERMS_ACTIVITY_MISSING'; end if;
    select id,version+1 into previous_id,next_version from public.class_booking_terms
      where booking_id=new.id order by version desc limit 1;
    insert into public.class_booking_terms(gym_id,booking_id,version,billing_mode,agreed_amount,currency,
      contracted_at,evidence_state,source,supersedes_id)
    values(new.gym_id,new.id,coalesce(next_version,1),a.billing_mode,a.price,a.currency,
      new.booked_at,'verified','reservation',previous_id);
  end if;
  return new;
end;
$$;
revoke all on function private.capture_class_booking_terms() from public, anon, authenticated;
drop trigger if exists class_bookings_capture_terms on public.class_bookings;
create trigger class_bookings_capture_terms after insert or update on public.class_bookings
for each row execute function private.capture_class_booking_terms();

-- Defense for all new class payments, not only the reception RPC.
-- Existing payments and refunds are not recalculated.
create or replace function private.validate_new_class_payment_terms()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare t public.class_booking_terms;
begin
  if tg_op='UPDATE' then
    if new.class_booking_id is distinct from old.class_booking_id then raise exception 'CLASS_PAYMENT_BOOKING_IMMUTABLE'; end if;
    -- Preserve old confirmed payments/refunds, but do not let a pending payment
    -- bypass frozen terms by changing its amount or confirming it later.
    if old.status <> 'pending' or new.status in ('voided','failed') then return new; end if;
  end if;
  if new.class_booking_id is null then return new; end if;
  perform 1 from public.class_bookings where id=new.class_booking_id and gym_id=new.gym_id for update;
  select * into t from public.class_booking_terms
    where booking_id=new.class_booking_id and gym_id=new.gym_id order by version desc limit 1;
  if not found or t.evidence_state='unknown' then raise exception 'CLASS_TERMS_RESOLUTION_REQUIRED'; end if;
  if t.billing_mode='included' then raise exception 'CLASS_DOES_NOT_REQUIRE_ADDITIONAL_PAYMENT'; end if;
  if t.evidence_state<>'verified' then raise exception 'CLASS_TERMS_RESOLUTION_REQUIRED'; end if;
  if new.amount is distinct from t.agreed_amount or new.currency is distinct from t.currency then
    raise exception 'CLASS_PAYMENT_TERMS_MISMATCH';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_new_class_payment_terms() from public, anon, authenticated;
drop trigger if exists member_payments_class_terms on public.member_payments;
create trigger member_payments_class_terms before insert or update on public.member_payments
for each row execute function private.validate_new_class_payment_terms();

create or replace function private.link_class_payment_evidence()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.class_booking_id is not null then
    update public.class_booking_terms set payment_evidence_id=new.id
      where id=(select id from public.class_booking_terms where booking_id=new.class_booking_id
        and gym_id=new.gym_id order by version desc limit 1);
  end if;
  return new;
end;
$$;
revoke all on function private.link_class_payment_evidence() from public, anon, authenticated;
drop trigger if exists member_payments_link_terms on public.member_payments;
create trigger member_payments_link_terms after insert on public.member_payments
for each row execute function private.link_class_payment_evidence();

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
  for update of cs for share of ec;

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
  for update of cs for share of ec;
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
  terms_record public.class_booking_terms;
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

  select t.* into terms_record from public.class_booking_terms t
  where t.booking_id=reserved_booking.id and t.gym_id=target_gym_id order by t.version desc limit 1;
  if not found or terms_record.evidence_state='unknown' then
    raise exception 'CLASS_TERMS_RESOLUTION_REQUIRED';
  end if;
  if terms_record.billing_mode='included' then
    raise exception 'CLASS_DOES_NOT_REQUIRE_ADDITIONAL_PAYMENT' using errcode='23514';
  end if;
  if terms_record.evidence_state<>'verified' then raise exception 'CLASS_TERMS_RESOLUTION_REQUIRED'; end if;

  insert into public.member_payments(
    gym_id, location_id, member_user_id, class_booking_id, amount, currency,
    payment_method, status, external_reference, notes, registered_by, paid_at
  ) values (
    target_gym_id, schedule_record.location_id, target_member_user_id,
    reserved_booking.id, terms_record.agreed_amount, terms_record.currency,
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
