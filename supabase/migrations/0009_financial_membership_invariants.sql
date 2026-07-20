begin;

-- Toda operación del gimnasio usa su moneda configurada. Las suscripciones SaaS
-- son globales y se comparan contra el snapshot de la suscripción.
create or replace function private.validate_business_currency()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  expected_currency text;
begin
  if tg_table_name = 'memberships' then
    select p.currency into expected_currency
    from public.plans p
    where p.id = new.plan_id and p.gym_id = new.gym_id;
  elsif tg_table_name = 'saas_payment_transactions' then
    select gs.currency_snapshot into expected_currency
    from public.gym_subscriptions gs
    where gs.id = new.gym_subscription_id and gs.gym_id = new.gym_id;
  else
    select g.currency::text into expected_currency
    from public.gyms g where g.id = new.gym_id;
  end if;

  if expected_currency is null or new.currency::text is distinct from expected_currency then
    raise exception 'CURRENCY_MUST_MATCH_BUSINESS_CONTEXT' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.validate_business_currency() from public, anon, authenticated;

create trigger plans_currency_matches_gym
before insert or update of gym_id, currency on public.plans
for each row execute function private.validate_business_currency();

create trigger memberships_currency_matches_plan
before insert or update of gym_id, plan_id, currency on public.memberships
for each row execute function private.validate_business_currency();

create trigger member_payments_currency_matches_gym
before insert or update of gym_id, currency on public.member_payments
for each row execute function private.validate_business_currency();

create trigger extra_classes_currency_matches_gym
before insert or update of gym_id, currency on public.extra_classes
for each row execute function private.validate_business_currency();

create trigger products_currency_matches_gym
before insert or update of gym_id, currency on public.products
for each row execute function private.validate_business_currency();

create trigger sales_currency_matches_gym
before insert or update of gym_id, currency on public.sales
for each row execute function private.validate_business_currency();

create trigger saas_transactions_currency_matches_subscription
before insert or update of gym_id, gym_subscription_id, currency on public.saas_payment_transactions
for each row execute function private.validate_business_currency();

-- Cambiar la etiqueta de moneda no convierte importes históricos. Solo se permite
-- mientras el gimnasio todavía no tenga información comercial o financiera.
create or replace function private.prevent_gym_currency_change_with_financial_data()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.currency is distinct from old.currency and (
    exists (select 1 from public.plans p where p.gym_id = old.id)
    or exists (select 1 from public.memberships m where m.gym_id = old.id)
    or exists (select 1 from public.member_payments mp where mp.gym_id = old.id)
    or exists (select 1 from public.extra_classes ec where ec.gym_id = old.id)
    or exists (select 1 from public.products p where p.gym_id = old.id)
    or exists (select 1 from public.sales s where s.gym_id = old.id)
  ) then
    raise exception 'GYM_CURRENCY_CANNOT_CHANGE_AFTER_FINANCIAL_DATA_EXISTS'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_gym_currency_change_with_financial_data()
  from public, anon, authenticated;
create trigger gyms_protect_currency
before update of currency on public.gyms
for each row execute function private.prevent_gym_currency_change_with_financial_data();

-- Un pago asociado a una venta debe usar exactamente la moneda de esa venta.
create or replace function private.validate_payment_business_currency()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reference_currency text;
begin
  if new.membership_id is not null then
    select m.currency into reference_currency
    from public.memberships m where m.id = new.membership_id;
  elsif new.sale_id is not null then
    select s.currency into reference_currency
    from public.sales s where s.id = new.sale_id;
  end if;

  if reference_currency is not null and new.currency is distinct from reference_currency then
    raise exception 'PAYMENT_CURRENCY_MUST_MATCH_BUSINESS_REFERENCE' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_payment_business_currency() from public, anon, authenticated;
create trigger member_payments_reference_currency
before insert or update of membership_id, sale_id, currency on public.member_payments
for each row execute function private.validate_payment_business_currency();

-- Evita convertir importes de monedas diferentes en un subtotal numérico falso.
create or replace function private.validate_sale_item_currency()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.sales s
    join public.products p on p.id = new.product_id
    where s.id = new.sale_id
      and s.gym_id = new.gym_id
      and p.gym_id = new.gym_id
      and p.currency = s.currency
  ) then
    raise exception 'SALE_ITEM_CURRENCY_MISMATCH' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_sale_item_currency() from public, anon, authenticated;
create trigger sale_items_currency_validate
before insert or update of gym_id, sale_id, product_id on public.sale_items
for each row execute function private.validate_sale_item_currency();

-- Máquina de estados mínima para pagos manuales del gimnasio.
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

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
    (old.status = 'pending' and new.status in ('confirmed', 'failed', 'voided'))
    or (old.status = 'confirmed' and new.status = 'voided')
    or (old.status = 'failed' and new.status = 'pending')
  ) then
    raise exception 'INVALID_MEMBER_PAYMENT_STATUS_TRANSITION: % -> %', old.status, new.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_member_payment_status_transition() from public, anon, authenticated;
create trigger member_payments_status_transition
before insert or update of status on public.member_payments
for each row execute function private.validate_member_payment_status_transition();

-- Las membresías canceladas son terminales. Expired puede reactivarse mediante
-- una renovación; paused puede reanudarse sin perder la racha.
create or replace function private.validate_membership_status_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'MEMBERSHIP_INITIAL_STATUS_MUST_BE_PENDING' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
    (old.status = 'pending' and new.status in ('active', 'cancelled'))
    or (old.status = 'active' and new.status in ('paused', 'expired', 'cancelled'))
    or (old.status = 'paused' and new.status in ('active', 'expired', 'cancelled'))
    or (old.status = 'expired' and new.status in ('active', 'cancelled'))
  ) then
    raise exception 'INVALID_MEMBERSHIP_STATUS_TRANSITION: % -> %', old.status, new.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_membership_status_transition() from public, anon, authenticated;
create trigger memberships_status_transition
before insert or update of status on public.memberships
for each row execute function private.validate_membership_status_transition();

-- Al retirar un pago confirmado, su cobertura deja de estar activa. La membresía
-- se pausa solamente si hoy ya no queda otro periodo activo que la cubra.
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
  if old.status = 'confirmed' and new.status = 'voided' then
    select mp.membership_id into affected_membership_id
    from public.membership_periods mp
    where mp.payment_id = new.id
    limit 1;

    if affected_membership_id is not null then
      update public.membership_periods
      set status = 'cancelled'
      where payment_id = new.id and status <> 'cancelled';

      select (now() at time zone g.timezone)::date into gym_today
      from public.gyms g where g.id = new.gym_id;

      if not exists (
        select 1 from public.membership_periods mp
        where mp.membership_id = affected_membership_id
          and mp.status = 'active'
          and gym_today between mp.starts_on and mp.ends_on
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

revoke all on function private.cancel_coverage_for_reversed_payment() from public, anon, authenticated;
create trigger member_payments_cancel_coverage
after update of status on public.member_payments
for each row execute function private.cancel_coverage_for_reversed_payment();

commit;
