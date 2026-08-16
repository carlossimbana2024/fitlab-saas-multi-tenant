begin;

-- Un recibo es un comprobante interno correlativo por gimnasio. No reemplaza
-- una factura tributaria ni modifica los identificadores históricos del pago.
alter table public.member_payments
  add column receipt_number bigint,
  add column receipt_issued_at timestamptz,
  add column refunded_at timestamptz,
  add column refunded_by uuid references public.gym_users(id),
  add column refund_reason text;

with numbered as (
  select payment.id,
         row_number() over (
           partition by payment.gym_id
           order by payment.paid_at, payment.created_at, payment.id
         ) as receipt_number
  from public.member_payments payment
  where payment.status in ('confirmed', 'voided', 'refunded')
)
update public.member_payments payment
set receipt_number = numbered.receipt_number,
    receipt_issued_at = payment.paid_at
from numbered
where numbered.id = payment.id;

-- Normaliza cualquier reembolso historico antes de exigir su trazabilidad.
update public.member_payments
set refunded_at = coalesce(voided_at, updated_at, paid_at, created_at),
    refunded_by = coalesce(voided_by, registered_by),
    refund_reason = coalesce(nullif(trim(void_reason), ''), 'Reembolso historico migrado'),
    voided_at = null,
    voided_by = null,
    void_reason = null
where status = 'refunded';

create unique index member_payments_receipt_number_idx
  on public.member_payments(gym_id, receipt_number)
  where receipt_number is not null;

alter table public.member_payments
  add constraint member_payments_receipt_positive_chk check (
    receipt_number is null or receipt_number > 0
  ),
  add constraint member_payments_receipt_state_chk check (
    (status in ('confirmed', 'voided', 'refunded')
      and receipt_number is not null and receipt_issued_at is not null)
    or
    (status not in ('confirmed', 'voided', 'refunded')
      and receipt_number is null and receipt_issued_at is null)
  ),
  add constraint member_payments_refund_metadata_chk check (
    (status = 'refunded'
      and refunded_at is not null and refunded_by is not null
      and nullif(trim(refund_reason), '') is not null)
    or
    (status <> 'refunded'
      and refunded_at is null and refunded_by is null and refund_reason is null)
  );

create table private.gym_receipt_counters (
  gym_id uuid primary key references public.gyms(id) on delete cascade,
  next_number bigint not null check (next_number > 0)
);

insert into private.gym_receipt_counters(gym_id, next_number)
select gym.id, coalesce(max(payment.receipt_number), 0) + 1
from public.gyms gym
left join public.member_payments payment on payment.gym_id = gym.id
group by gym.id;

revoke all on private.gym_receipt_counters from public, anon, authenticated;

create or replace function private.assign_payment_receipt()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_op = 'UPDATE' and old.receipt_number is not null and (
    new.receipt_number is distinct from old.receipt_number
    or new.receipt_issued_at is distinct from old.receipt_issued_at
  ) then
    raise exception 'PAYMENT_RECEIPT_IDENTITY_IS_IMMUTABLE' using errcode = '23514';
  end if;

  if new.status in ('confirmed', 'voided', 'refunded')
     and new.receipt_number is null then
    insert into private.gym_receipt_counters(gym_id, next_number)
    values (new.gym_id, 2)
    on conflict (gym_id) do update
    set next_number = private.gym_receipt_counters.next_number + 1
    returning next_number - 1 into new.receipt_number;
    new.receipt_issued_at := coalesce(new.paid_at, now());
  end if;

  return new;
end;
$$;

revoke all on function private.assign_payment_receipt()
  from public, anon, authenticated;
create trigger member_payments_assign_receipt
before insert or update of status, receipt_number, receipt_issued_at
on public.member_payments
for each row execute function private.assign_payment_receipt();

-- Cada periodo conserva el precio exacto que se cobro al crearlo. Esto permite
-- renovar aunque el precio actual del plan sea diferente al primer contrato.
alter table public.membership_periods
  add column charged_amount numeric(12,2),
  add column currency text;

update public.membership_periods period
set charged_amount = coalesce(
      (select payment.amount
       from public.member_payments payment
       where payment.id = period.payment_id),
      (select membership.price_at_purchase
       from public.memberships membership
       where membership.id = period.membership_id)
    ),
    currency = coalesce(
      (select payment.currency
       from public.member_payments payment
       where payment.id = period.payment_id),
      (select membership.currency
       from public.memberships membership
       where membership.id = period.membership_id)
    );

alter table public.membership_periods
  alter column charged_amount set not null,
  alter column currency set not null,
  add constraint membership_periods_charged_amount_chk check (charged_amount >= 0),
  add constraint membership_periods_currency_chk check (currency ~ '^[A-Z]{3}$');

-- Motivo y actor de la cancelacion contractual. Los registros cancelados antes
-- de 0025 se normalizan para cumplir la misma trazabilidad.
alter table public.memberships
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references public.gym_users(id),
  add column cancellation_reason text;

update public.memberships
set cancelled_at = updated_at,
    cancelled_by = created_by,
    cancellation_reason = 'Cancelacion historica migrada'
where status = 'cancelled';

alter table public.memberships
  add constraint memberships_cancellation_metadata_chk check (
    (status = 'cancelled'
      and cancelled_at is not null and cancelled_by is not null
      and nullif(trim(cancellation_reason), '') is not null)
    or
    (status <> 'cancelled'
      and cancelled_at is null and cancelled_by is null
      and cancellation_reason is null)
  );

create or replace function private.authorize_financial_backend_actor(
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
  if requested_permission not in ('payments.register', 'payments.void') then
    raise exception 'INVALID_FINANCIAL_PERMISSION' using errcode = '22023';
  end if;

  select actor.profile_id, actor.role, actor.status, actor.account_mode
    into actor_record
  from public.gym_users actor
  where actor.id = target_actor_gym_user_id
    and actor.gym_id = target_gym_id;

  if not found
     or actor_record.profile_id is null
     or actor_record.status <> 'active'
     or actor_record.account_mode <> 'portal' then
    raise exception 'FINANCIAL_ACTOR_MUST_BE_ACTIVE_IN_GYM' using errcode = '42501';
  end if;

  if actor_record.role = 'owner' then
    return actor_record.profile_id;
  end if;
  if actor_record.role <> 'staff' then
    raise exception 'FINANCIAL_ACTOR_ROLE_DENIED' using errcode = '42501';
  end if;

  select permission.access_mode into actor_access_mode
  from public.staff_permissions permission
  where permission.gym_id = target_gym_id
    and permission.staff_user_id = target_actor_gym_user_id
    and permission.permission_key = requested_permission;

  if actor_access_mode = 'allowed'
     or (actor_access_mode = 'requires_pin' and supplied_used_pin_elevation) then
    return actor_record.profile_id;
  end if;

  raise exception 'FINANCIAL_PERMISSION_DENIED' using errcode = '42501';
end;
$$;

revoke all on function private.authorize_financial_backend_actor(
  uuid, uuid, text, boolean
) from public, anon, authenticated;

-- La nueva firma mantiene los nueve parametros anteriores y agrega al final
-- la evidencia de elevacion PIN. El valor por defecto permite desplegar la
-- migracion antes que el nuevo backend sin interrumpir cobros existentes.
drop function public.register_manual_membership_checkout(
  uuid, uuid, uuid, uuid, uuid, public.member_payment_method, text, text, uuid
);

create function public.register_manual_membership_checkout(
  target_gym_id uuid,
  target_location_id uuid,
  target_member_user_id uuid,
  target_plan_id uuid,
  target_registered_by uuid,
  selected_payment_method public.member_payment_method,
  supplied_external_reference text default null,
  supplied_notes text default null,
  target_membership_id uuid default null,
  supplied_used_pin_elevation boolean default false
)
returns table(
  membership_id uuid,
  payment_id uuid,
  membership_period_id uuid,
  coverage_starts_on date,
  coverage_ends_on date,
  charged_amount numeric,
  charged_currency text,
  receipt_number bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  gym_record record;
  plan_record record;
  membership_record record;
  actor_profile_id uuid;
  gym_today date;
  last_coverage_end date;
  new_membership_id uuid;
  new_payment_id uuid;
  new_period_id uuid;
  new_receipt_number bigint;
  new_starts_on date;
  new_ends_on date;
begin
  actor_profile_id := private.authorize_financial_backend_actor(
    target_gym_id, target_registered_by, 'payments.register',
    coalesce(supplied_used_pin_elevation, false)
  );

  select gym.id, gym.timezone, gym.currency::text as currency
    into gym_record
  from public.gyms gym
  where gym.id = target_gym_id;
  if gym_record.id is null then
    raise exception 'GYM_NOT_FOUND' using errcode = '23503';
  end if;
  gym_today := (now() at time zone gym_record.timezone)::date;

  if not exists (
    select 1 from public.gym_locations location
    where location.id = target_location_id
      and location.gym_id = target_gym_id
      and location.is_active
  ) then
    raise exception 'CHECKOUT_REQUIRES_ACTIVE_LOCATION_IN_SAME_GYM' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.gym_users member
    where member.id = target_member_user_id
      and member.gym_id = target_gym_id
      and member.role = 'member'
      and member.status = 'active'
  ) then
    raise exception 'CHECKOUT_REQUIRES_ACTIVE_MEMBER_IN_SAME_GYM' using errcode = '23514';
  end if;

  select plan.id, plan.price, plan.currency, plan.duration_unit,
         plan.duration_value, plan.attendance_mode, plan.weekly_target
    into plan_record
  from public.plans plan
  where plan.id = target_plan_id
    and plan.gym_id = target_gym_id
    and plan.is_active;
  if plan_record.id is null then
    raise exception 'CHECKOUT_REQUIRES_ACTIVE_PLAN_IN_SAME_GYM' using errcode = '23514';
  end if;
  if plan_record.currency is distinct from gym_record.currency then
    raise exception 'CURRENCY_MUST_MATCH_BUSINESS_CONTEXT' using errcode = '23514';
  end if;
  if plan_record.price <= 0 then
    raise exception 'MANUAL_CHECKOUT_REQUIRES_POSITIVE_PRICE' using errcode = '23514';
  end if;
  if selected_payment_method in ('bank_transfer', 'external_card', 'external_deuna')
     and nullif(trim(supplied_external_reference), '') is null then
    raise exception 'EXTERNAL_REFERENCE_REQUIRED_FOR_PAYMENT_METHOD' using errcode = '23514';
  end if;

  if target_membership_id is null then
    if exists (
      select 1 from public.memberships active_membership
      where active_membership.member_user_id = target_member_user_id
        and active_membership.status = 'active'
    ) then
      raise exception 'ACTIVE_MEMBERSHIP_REQUIRES_RENEWAL' using errcode = '23514';
    end if;

    insert into public.memberships(
      gym_id, member_user_id, plan_id, status, price_at_purchase, currency,
      attendance_mode_snapshot, weekly_target_snapshot, created_by
    ) values (
      target_gym_id, target_member_user_id, target_plan_id, 'pending',
      plan_record.price, plan_record.currency, plan_record.attendance_mode,
      plan_record.weekly_target, target_registered_by
    ) returning id into new_membership_id;
  else
    select membership.id, membership.gym_id, membership.member_user_id,
           membership.plan_id, membership.status
      into membership_record
    from public.memberships membership
    where membership.id = target_membership_id
    for update;

    if membership_record.id is null
       or membership_record.gym_id is distinct from target_gym_id
       or membership_record.member_user_id is distinct from target_member_user_id
       or membership_record.plan_id is distinct from target_plan_id
       or membership_record.status = 'cancelled' then
      raise exception 'INVALID_MEMBERSHIP_FOR_RENEWAL' using errcode = '23514';
    end if;
    new_membership_id := membership_record.id;
  end if;

  select max(period.ends_on) into last_coverage_end
  from public.membership_periods period
  where period.membership_id = new_membership_id
    and period.status <> 'cancelled';

  new_starts_on := greatest(gym_today, coalesce(last_coverage_end + 1, gym_today));
  new_ends_on := case plan_record.duration_unit
    when 'days' then new_starts_on + plan_record.duration_value - 1
    when 'weeks' then new_starts_on + (plan_record.duration_value * 7) - 1
    when 'months' then (new_starts_on + make_interval(months => plan_record.duration_value))::date - 1
  end;

  insert into public.member_payments(
    gym_id, location_id, member_user_id, membership_id, amount, currency,
    payment_method, status, external_reference, notes, registered_by, paid_at
  ) values (
    target_gym_id, target_location_id, target_member_user_id,
    new_membership_id, plan_record.price, plan_record.currency,
    selected_payment_method, 'confirmed',
    nullif(trim(supplied_external_reference), ''),
    nullif(trim(supplied_notes), ''), target_registered_by, now()
  ) returning id, member_payments.receipt_number
    into new_payment_id, new_receipt_number;

  insert into public.membership_periods(
    gym_id, membership_id, starts_on, ends_on, status, payment_id,
    charged_amount, currency
  ) values (
    target_gym_id, new_membership_id, new_starts_on, new_ends_on,
    'active', new_payment_id, plan_record.price, plan_record.currency
  ) returning id into new_period_id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, after_data
  ) values (
    target_gym_id, actor_profile_id, target_registered_by,
    case when target_membership_id is null
      then 'membership.created_with_payment'
      else 'membership.renewed'
    end,
    'member_payment', new_payment_id, 'payments.register',
    coalesce(supplied_used_pin_elevation, false),
    jsonb_build_object(
      'membership_id', new_membership_id,
      'period_id', new_period_id,
      'starts_on', new_starts_on,
      'ends_on', new_ends_on,
      'amount', plan_record.price,
      'currency', plan_record.currency,
      'receipt_number', new_receipt_number
    )
  );

  return query select new_membership_id, new_payment_id, new_period_id,
    new_starts_on, new_ends_on, plan_record.price::numeric,
    plan_record.currency::text, new_receipt_number;
end;
$$;

revoke all on function public.register_manual_membership_checkout(
  uuid, uuid, uuid, uuid, uuid, public.member_payment_method,
  text, text, uuid, boolean
) from public, anon, authenticated;
grant execute on function public.register_manual_membership_checkout(
  uuid, uuid, uuid, uuid, uuid, public.member_payment_method,
  text, text, uuid, boolean
) to service_role;

create or replace function public.cancel_membership_backend(
  target_gym_id uuid,
  target_membership_id uuid,
  target_cancelled_by uuid,
  supplied_reason text,
  supplied_used_pin_elevation boolean
)
returns table(
  membership_id uuid,
  membership_status public.membership_status,
  cancelled_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  membership_record record;
  gym_today date;
  cancellation_time timestamptz := now();
begin
  if nullif(trim(supplied_reason), '') is null
     or char_length(trim(supplied_reason)) not between 3 and 500 then
    raise exception 'INVALID_MEMBERSHIP_CANCELLATION_REASON' using errcode = '22023';
  end if;

  actor_profile_id := private.authorize_members_backend_actor(
    target_gym_id, target_cancelled_by,
    coalesce(supplied_used_pin_elevation, false)
  );

  select membership.id, membership.status, membership.member_user_id,
         membership.plan_id
    into membership_record
  from public.memberships membership
  where membership.id = target_membership_id
    and membership.gym_id = target_gym_id
    and membership.status <> 'cancelled'
  for update;
  if not found then
    raise exception 'CANCELLABLE_MEMBERSHIP_NOT_FOUND' using errcode = 'P0002';
  end if;

  select (now() at time zone gym.timezone)::date into gym_today
  from public.gyms gym where gym.id = target_gym_id;

  update public.membership_periods
  set status = 'cancelled'
  where membership_periods.membership_id = target_membership_id
    and membership_periods.status <> 'cancelled'
    and membership_periods.ends_on >= gym_today;

  update public.memberships
  set status = 'cancelled',
      cancelled_at = cancellation_time,
      cancelled_by = target_cancelled_by,
      cancellation_reason = trim(supplied_reason)
  where id = target_membership_id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_cancelled_by,
    'membership.cancelled', 'membership', target_membership_id,
    'members.manage', coalesce(supplied_used_pin_elevation, false),
    jsonb_build_object('status', membership_record.status),
    jsonb_build_object(
      'status', 'cancelled', 'reason', trim(supplied_reason),
      'cancelled_at', cancellation_time,
      'payments_unchanged', true,
      'history_preserved', true
    )
  );

  return query select target_membership_id,
    'cancelled'::public.membership_status, cancellation_time;
end;
$$;

revoke all on function public.cancel_membership_backend(
  uuid, uuid, uuid, text, boolean
) from public, anon, authenticated;
grant execute on function public.cancel_membership_backend(
  uuid, uuid, uuid, text, boolean
) to service_role;

create or replace function private.validate_member_payment_status_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('pending', 'confirmed') then
      raise exception 'MEMBER_PAYMENT_INITIAL_STATUS_MUST_BE_PENDING_OR_CONFIRMED'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.status is not distinct from old.status then return new; end if;
  if not (
    (old.status = 'pending' and new.status in ('confirmed', 'failed', 'voided'))
    or (old.status = 'confirmed' and new.status in ('voided', 'refunded'))
    or (old.status = 'failed' and new.status = 'pending')
  ) then
    raise exception 'INVALID_MEMBER_PAYMENT_STATUS_TRANSITION: % -> %', old.status, new.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function private.cancel_coverage_for_reversed_payment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  affected_membership_id uuid;
  gym_today date;
begin
  if old.status = 'confirmed' and new.status in ('voided', 'refunded') then
    select period.membership_id into affected_membership_id
    from public.membership_periods period
    where period.payment_id = new.id
    limit 1;

    if affected_membership_id is not null then
      update public.membership_periods
      set status = 'cancelled'
      where payment_id = new.id and status <> 'cancelled';

      select (now() at time zone gym.timezone)::date into gym_today
      from public.gyms gym where gym.id = new.gym_id;

      if not exists (
        select 1 from public.membership_periods period
        where period.membership_id = affected_membership_id
          and period.status = 'active'
          and gym_today between period.starts_on and period.ends_on
      ) then
        update public.memberships
        set status = 'paused'
        where id = affected_membership_id and status = 'active';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.reverse_member_payment_backend(
  target_gym_id uuid,
  target_payment_id uuid,
  target_reversed_by uuid,
  target_reversal_status public.payment_status,
  supplied_reason text,
  supplied_used_pin_elevation boolean
)
returns table(
  payment_id uuid,
  payment_status public.payment_status,
  receipt_number bigint,
  reversed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  payment_record record;
  reversal_time timestamptz := now();
begin
  if target_reversal_status not in ('voided', 'refunded')
     or nullif(trim(supplied_reason), '') is null
     or char_length(trim(supplied_reason)) not between 3 and 500 then
    raise exception 'INVALID_PAYMENT_REVERSAL' using errcode = '22023';
  end if;

  actor_profile_id := private.authorize_financial_backend_actor(
    target_gym_id, target_reversed_by, 'payments.void',
    coalesce(supplied_used_pin_elevation, false)
  );

  select payment.id, payment.status, payment.member_user_id,
         payment.membership_id, payment.amount, payment.currency,
         payment.receipt_number
    into payment_record
  from public.member_payments payment
  where payment.id = target_payment_id
    and payment.gym_id = target_gym_id
    and payment.membership_id is not null
    and payment.status = 'confirmed'
  for update;
  if not found then
    raise exception 'REVERSIBLE_PAYMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if target_reversal_status = 'voided' then
    update public.member_payments
    set status = 'voided',
        voided_at = reversal_time,
        voided_by = target_reversed_by,
        void_reason = trim(supplied_reason)
    where id = target_payment_id;
  else
    update public.member_payments
    set status = 'refunded',
        refunded_at = reversal_time,
        refunded_by = target_reversed_by,
        refund_reason = trim(supplied_reason)
    where id = target_payment_id;
  end if;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_reversed_by,
    case target_reversal_status
      when 'voided' then 'payment.voided'
      else 'payment.refunded'
    end,
    'member_payment', target_payment_id, 'payments.void',
    coalesce(supplied_used_pin_elevation, false),
    jsonb_build_object('status', payment_record.status),
    jsonb_build_object(
      'status', target_reversal_status,
      'reason', trim(supplied_reason),
      'amount', payment_record.amount,
      'currency', payment_record.currency,
      'receipt_number', payment_record.receipt_number,
      'coverage_cancelled', true
    )
  );

  return query select target_payment_id, target_reversal_status,
    payment_record.receipt_number, reversal_time;
end;
$$;

revoke all on function public.reverse_member_payment_backend(
  uuid, uuid, uuid, public.payment_status, text, boolean
) from public, anon, authenticated;
grant execute on function public.reverse_member_payment_backend(
  uuid, uuid, uuid, public.payment_status, text, boolean
) to service_role;

commit;
