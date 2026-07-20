begin;

-- Registra de forma atómica un cobro manual, su membresía y el periodo de
-- cobertura. Solo el backend con service_role puede ejecutar esta operación.
create or replace function public.register_manual_membership_checkout(
  target_gym_id uuid,
  target_location_id uuid,
  target_member_user_id uuid,
  target_plan_id uuid,
  target_registered_by uuid,
  selected_payment_method public.member_payment_method,
  supplied_external_reference text default null,
  supplied_notes text default null,
  target_membership_id uuid default null
)
returns table(
  membership_id uuid,
  payment_id uuid,
  membership_period_id uuid,
  coverage_starts_on date,
  coverage_ends_on date,
  charged_amount numeric,
  charged_currency text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  gym_record record;
  plan_record record;
  membership_record record;
  gym_today date;
  last_coverage_end date;
  new_membership_id uuid;
  new_payment_id uuid;
  new_period_id uuid;
  new_starts_on date;
  new_ends_on date;
begin
  select g.id, g.timezone, g.currency::text as currency
    into gym_record
  from public.gyms g
  where g.id = target_gym_id;

  if gym_record.id is null then
    raise exception 'GYM_NOT_FOUND' using errcode = '23503';
  end if;

  gym_today := (now() at time zone gym_record.timezone)::date;

  if not exists (
    select 1
    from public.gym_locations gl
    where gl.id = target_location_id
      and gl.gym_id = target_gym_id
      and gl.is_active
  ) then
    raise exception 'CHECKOUT_REQUIRES_ACTIVE_LOCATION_IN_SAME_GYM'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.gym_users member_user
    where member_user.id = target_member_user_id
      and member_user.gym_id = target_gym_id
      and member_user.role = 'member'
      and member_user.status = 'active'
  ) then
    raise exception 'CHECKOUT_REQUIRES_ACTIVE_MEMBER_IN_SAME_GYM'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.gym_users actor
    where actor.id = target_registered_by
      and actor.gym_id = target_gym_id
      and actor.role in ('owner', 'staff')
      and actor.status = 'active'
  ) then
    raise exception 'CHECKOUT_REQUIRES_ACTIVE_OPERATOR_IN_SAME_GYM'
      using errcode = '23514';
  end if;

  select p.id, p.price, p.currency, p.duration_unit, p.duration_value,
         p.attendance_mode, p.weekly_target
    into plan_record
  from public.plans p
  where p.id = target_plan_id
    and p.gym_id = target_gym_id
    and p.is_active;

  if plan_record.id is null then
    raise exception 'CHECKOUT_REQUIRES_ACTIVE_PLAN_IN_SAME_GYM'
      using errcode = '23514';
  end if;

  if plan_record.currency is distinct from gym_record.currency then
    raise exception 'CURRENCY_MUST_MATCH_BUSINESS_CONTEXT'
      using errcode = '23514';
  end if;

  if selected_payment_method in ('bank_transfer', 'external_card', 'external_deuna')
     and nullif(trim(supplied_external_reference), '') is null then
    raise exception 'EXTERNAL_REFERENCE_REQUIRED_FOR_PAYMENT_METHOD'
      using errcode = '23514';
  end if;

  if target_membership_id is null then
    if exists (
      select 1
      from public.memberships active_membership
      where active_membership.member_user_id = target_member_user_id
        and active_membership.status = 'active'
    ) then
      raise exception 'ACTIVE_MEMBERSHIP_REQUIRES_RENEWAL'
        using errcode = '23514';
    end if;

    insert into public.memberships(
      gym_id, member_user_id, plan_id, status, price_at_purchase, currency,
      attendance_mode_snapshot, weekly_target_snapshot, created_by
    ) values (
      target_gym_id, target_member_user_id, target_plan_id, 'pending',
      plan_record.price, plan_record.currency, plan_record.attendance_mode,
      plan_record.weekly_target, target_registered_by
    )
    returning id into new_membership_id;
  else
    select m.id, m.gym_id, m.member_user_id, m.plan_id, m.status,
           m.price_at_purchase, m.currency
      into membership_record
    from public.memberships m
    where m.id = target_membership_id
    for update;

    if membership_record.id is null
       or membership_record.gym_id is distinct from target_gym_id
       or membership_record.member_user_id is distinct from target_member_user_id
       or membership_record.plan_id is distinct from target_plan_id
       or membership_record.status = 'cancelled' then
      raise exception 'INVALID_MEMBERSHIP_FOR_RENEWAL'
        using errcode = '23514';
    end if;

    if membership_record.price_at_purchase is distinct from plan_record.price
       or membership_record.currency is distinct from plan_record.currency then
      raise exception 'PLAN_PRICE_CHANGED_REQUIRES_NEW_MEMBERSHIP'
        using errcode = '23514';
    end if;

    new_membership_id := membership_record.id;
  end if;

  select max(mp.ends_on)
    into last_coverage_end
  from public.membership_periods mp
  where mp.membership_id = new_membership_id
    and mp.status <> 'cancelled';

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
    selected_payment_method, 'confirmed', nullif(trim(supplied_external_reference), ''),
    nullif(trim(supplied_notes), ''), target_registered_by, now()
  )
  returning id into new_payment_id;

  insert into public.membership_periods(
    gym_id, membership_id, starts_on, ends_on, status, payment_id
  ) values (
    target_gym_id, new_membership_id, new_starts_on, new_ends_on,
    'active', new_payment_id
  )
  returning id into new_period_id;

  return query select
    new_membership_id,
    new_payment_id,
    new_period_id,
    new_starts_on,
    new_ends_on,
    plan_record.price::numeric,
    plan_record.currency::text;
end;
$$;

revoke all on function public.register_manual_membership_checkout(
  uuid, uuid, uuid, uuid, uuid, public.member_payment_method, text, text, uuid
) from public, anon, authenticated;

grant execute on function public.register_manual_membership_checkout(
  uuid, uuid, uuid, uuid, uuid, public.member_payment_method, text, text, uuid
) to service_role;

comment on function public.register_manual_membership_checkout(
  uuid, uuid, uuid, uuid, uuid, public.member_payment_method, text, text, uuid
) is 'Backend-only. Registra atómicamente pago manual, membresía y cobertura.';

commit;
