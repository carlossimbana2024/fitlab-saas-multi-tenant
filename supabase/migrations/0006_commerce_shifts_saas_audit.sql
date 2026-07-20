begin;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 150),
  sku text not null check (char_length(trim(sku)) between 1 and 80),
  description text,
  sale_price numeric(12,2) not null check (sale_price >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  minimum_stock integer not null default 0 check (minimum_stock >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index products_sku_case_insensitive_idx
  on public.products(gym_id, lower(trim(sku)));

create table private.product_costs (
  product_id uuid primary key references public.products(id) on delete cascade,
  gym_id uuid not null references public.gyms(id) on delete cascade,
  cost_price numeric(12,2) check (cost_price >= 0),
  updated_at timestamptz not null default now()
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  location_id uuid not null references public.gym_locations(id),
  member_user_id uuid references public.gym_users(id),
  seller_user_id uuid not null references public.gym_users(id),
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  discount numeric(12,2) not null default 0 check (discount >= 0),
  total numeric(12,2) not null default 0 check (total >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  status public.sale_status not null default 'draft',
  sold_at timestamptz,
  voided_at timestamptz,
  voided_by uuid references public.gym_users(id),
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (total = subtotal - discount),
  check (
    (status = 'voided' and voided_at is not null and voided_by is not null and nullif(trim(void_reason), '') is not null)
    or (status <> 'voided' and voided_at is null and voided_by is null and void_reason is null)
  ),
  check ((status = 'completed' and sold_at is not null) or status <> 'completed')
);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_name_snapshot text not null,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  line_total numeric(12,2) generated always as (unit_price * quantity) stored,
  unique (sale_id, product_id)
);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  product_id uuid not null references public.products(id),
  location_id uuid references public.gym_locations(id),
  movement_type public.inventory_movement_type not null,
  quantity_delta integer not null check (quantity_delta <> 0),
  stock_before integer not null check (stock_before >= 0),
  stock_after integer not null check (stock_after >= 0),
  sale_id uuid references public.sales(id),
  performed_by uuid not null references public.gym_users(id),
  reason text,
  created_at timestamptz not null default now(),
  check (stock_after = stock_before + quantity_delta),
  check (
    (movement_type in ('purchase', 'return') and quantity_delta > 0)
    or (movement_type in ('sale', 'loss') and quantity_delta < 0)
    or movement_type = 'adjustment'
  ),
  check ((movement_type in ('sale', 'return') and sale_id is not null) or movement_type not in ('sale', 'return'))
);

create index inventory_movements_product_created_idx
  on public.inventory_movements(product_id, created_at, id);
create unique index inventory_movements_sale_product_type_idx
  on public.inventory_movements(sale_id, product_id, movement_type)
  where sale_id is not null and movement_type in ('sale', 'return');

create view public.product_stock_levels
with (security_invoker = true)
as
select p.id as product_id,
       p.gym_id,
       coalesce(sum(im.quantity_delta), 0)::bigint as current_stock
from public.products p
left join public.inventory_movements im on im.product_id = p.id
group by p.id, p.gym_id;

create table public.work_shifts (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  location_id uuid not null references public.gym_locations(id),
  staff_user_id uuid not null references public.gym_users(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  opening_cash numeric(12,2) not null default 0 check (opening_cash >= 0),
  closing_cash numeric(12,2) check (closing_cash >= 0),
  expected_cash numeric(12,2) check (expected_cash >= 0),
  difference numeric(12,2) generated always as (closing_cash - expected_cash) stored,
  status public.work_shift_status not null default 'open',
  reviewed_by uuid references public.gym_users(id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'open' and ended_at is null) or (status <> 'open' and ended_at is not null)),
  check (ended_at is null or ended_at > started_at),
  check ((status = 'reviewed' and reviewed_by is not null) or status <> 'reviewed')
);

create unique index work_shifts_one_open_per_staff_idx
  on public.work_shifts(staff_user_id)
  where status = 'open';

create table public.saas_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  price numeric(12,2) not null check (price >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  trial_days integer not null default 0 check (trial_days >= 0),
  features jsonb not null default '{}'::jsonb check (jsonb_typeof(features) = 'object'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index saas_plans_name_case_insensitive_idx
  on public.saas_plans(lower(trim(name)));

create table public.gym_subscriptions (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  saas_plan_id uuid not null references public.saas_plans(id),
  provider text not null check (provider in ('stripe', 'deuna')),
  provider_customer_id text,
  provider_subscription_id text,
  plan_name_snapshot text not null,
  price_snapshot numeric(12,2) not null check (price_snapshot >= 0),
  currency_snapshot text not null check (currency_snapshot ~ '^[A-Z]{3}$'),
  billing_interval_snapshot text not null check (billing_interval_snapshot in ('month', 'year')),
  features_snapshot jsonb not null check (jsonb_typeof(features_snapshot) = 'object'),
  status public.subscription_status not null default 'trialing',
  trial_ends_at timestamptz,
  current_period_starts_at timestamptz,
  current_period_ends_at timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_period_ends_at is null or current_period_starts_at is not null),
  check (current_period_ends_at is null or current_period_ends_at > current_period_starts_at),
  check ((status = 'trialing' and trial_ends_at is not null) or status <> 'trialing')
);

create unique index gym_subscriptions_one_current_idx
  on public.gym_subscriptions(gym_id)
  where status in ('trialing', 'active', 'past_due');
create unique index gym_subscriptions_provider_subscription_idx
  on public.gym_subscriptions(provider, provider_subscription_id)
  where provider_subscription_id is not null;

create table public.saas_payment_transactions (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  gym_subscription_id uuid not null references public.gym_subscriptions(id),
  provider text not null check (provider in ('stripe', 'deuna')),
  provider_payment_id text not null,
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  status public.payment_status not null,
  paid_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_payment_id),
  check ((status = 'failed' and failure_reason is not null) or status <> 'failed')
);

create table private.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'deuna')),
  provider_event_id text not null,
  event_type text not null,
  payload jsonb not null,
  signature_verified boolean not null default false,
  processing_status text not null default 'received' check (processing_status in ('received', 'processed', 'failed', 'ignored')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  received_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  processed_at timestamptz,
  error_message text,
  unique (provider, provider_event_id),
  check (processing_status <> 'processed' or signature_verified = true),
  check ((processing_status = 'processed' and processed_at is not null) or processing_status <> 'processed')
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  gym_id uuid references public.gyms(id) on delete set null,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  actor_gym_user_id uuid references public.gym_users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  permission_key text references public.permission_catalog(key),
  used_pin_elevation boolean not null default false,
  before_data jsonb,
  after_data jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index audit_logs_gym_created_idx on public.audit_logs(gym_id, created_at desc);

alter table public.member_payments add column sale_id uuid references public.sales(id);
alter table public.member_payments add constraint member_payments_one_business_reference
  check (not (membership_id is not null and sale_id is not null));

-- RLS se activa inmediatamente; 0007_rls.sql incorporará las políticas.
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.work_shifts enable row level security;
alter table public.saas_plans enable row level security;
alter table public.gym_subscriptions enable row level security;
alter table public.saas_payment_transactions enable row level security;
alter table public.audit_logs enable row level security;

create or replace function private.validate_sale()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
begin
  if not exists (select 1 from public.gym_locations gl where gl.id = new.location_id and gl.gym_id = new.gym_id and gl.is_active) then
    raise exception 'SALE_LOCATION_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;
  if new.member_user_id is not null and not exists (
    select 1 from public.gym_users gu where gu.id = new.member_user_id and gu.gym_id = new.gym_id and gu.role = 'member' and gu.status = 'active'
  ) then
    raise exception 'SALE_MEMBER_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;
  select gu.profile_id into actor_profile_id from public.gym_users gu
  where gu.id = new.seller_user_id and gu.gym_id = new.gym_id and gu.role in ('owner', 'staff') and gu.status = 'active';
  if actor_profile_id is null then
    raise exception 'SALE_SELLER_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and (select auth.uid()) is not null and actor_profile_id <> (select auth.uid()) then
    raise exception 'SALE_SELLER_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' and (
    new.gym_id is distinct from old.gym_id or new.location_id is distinct from old.location_id
    or new.member_user_id is distinct from old.member_user_id or new.seller_user_id is distinct from old.seller_user_id
    or new.subtotal is distinct from old.subtotal or new.discount is distinct from old.discount
    or new.total is distinct from old.total or new.currency is distinct from old.currency
  ) then
    raise exception 'FINALIZED_SALE_FINANCIAL_FIELDS_ARE_IMMUTABLE' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.status in ('voided', 'refunded') and new.status <> old.status then
    raise exception 'TERMINAL_SALE_CANNOT_CHANGE' using errcode = '23514';
  end if;
  if new.status = 'voided' then
    select gu.profile_id into actor_profile_id from public.gym_users gu
    where gu.id = new.voided_by and gu.gym_id = new.gym_id
      and gu.role in ('owner', 'staff') and gu.status = 'active';
    if actor_profile_id is null then raise exception 'SALE_VOIDER_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514'; end if;
    if (select auth.uid()) is not null and actor_profile_id <> (select auth.uid()) then
      raise exception 'SALE_VOIDER_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.validate_sale() from public, anon, authenticated;
create trigger sales_validate before insert or update on public.sales
for each row execute function private.validate_sale();

create or replace function private.validate_sale_item()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  sale_status public.sale_status;
  sale_gym_id uuid;
  product_gym_id uuid;
  product_name text;
  product_price numeric(12,2);
begin
  select s.status, s.gym_id into sale_status, sale_gym_id from public.sales s where s.id = new.sale_id;
  select p.gym_id, p.name, p.sale_price into product_gym_id, product_name, product_price
  from public.products p where p.id = new.product_id and p.is_active;
  if sale_status is distinct from 'draft' or sale_gym_id is distinct from new.gym_id or product_gym_id is distinct from new.gym_id then
    raise exception 'SALE_ITEM_REQUIRES_DRAFT_SALE_AND_ACTIVE_PRODUCT_IN_SAME_GYM' using errcode = '23514';
  end if;
  new.product_name_snapshot := product_name;
  new.unit_price := product_price;
  return new;
end;
$$;

revoke all on function private.validate_sale_item() from public, anon, authenticated;
create trigger sale_items_validate before insert or update on public.sale_items
for each row execute function private.validate_sale_item();

create or replace function private.validate_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  product_gym_id uuid;
  calculated_stock integer;
begin
  select p.gym_id into product_gym_id from public.products p where p.id = new.product_id for update;
  if product_gym_id is distinct from new.gym_id then
    raise exception 'INVENTORY_PRODUCT_TENANT_MISMATCH' using errcode = '23514';
  end if;
  if new.location_id is not null and not exists (
    select 1 from public.gym_locations gl where gl.id = new.location_id and gl.gym_id = new.gym_id and gl.is_active
  ) then
    raise exception 'INVENTORY_LOCATION_TENANT_MISMATCH' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.gym_users gu where gu.id = new.performed_by and gu.gym_id = new.gym_id
      and gu.role in ('owner', 'staff') and gu.status = 'active'
  ) then
    raise exception 'INVENTORY_ACTOR_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;
  if new.movement_type in ('sale', 'return') and not exists (
    select 1 from public.sale_items si
    where si.sale_id = new.sale_id and si.product_id = new.product_id and si.gym_id = new.gym_id
  ) then
    raise exception 'SALE_INVENTORY_MOVEMENT_REQUIRES_MATCHING_ITEM' using errcode = '23514';
  end if;
  select coalesce(sum(im.quantity_delta), 0)::integer into calculated_stock
  from public.inventory_movements im where im.product_id = new.product_id;
  new.stock_before := calculated_stock;
  new.stock_after := calculated_stock + new.quantity_delta;
  if new.stock_after < 0 then
    raise exception 'INSUFFICIENT_STOCK' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_inventory_movement() from public, anon, authenticated;
create trigger inventory_movements_validate before insert on public.inventory_movements
for each row execute function private.validate_inventory_movement();

create or replace function private.prevent_immutable_row_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$ begin raise exception 'HISTORICAL_ROW_IS_IMMUTABLE' using errcode = '55000'; end; $$;
revoke all on function private.prevent_immutable_row_change() from public, anon, authenticated;
create trigger inventory_movements_immutable before update on public.inventory_movements
for each row execute function private.prevent_immutable_row_change();
create trigger audit_logs_immutable before update on public.audit_logs
for each row execute function private.prevent_immutable_row_change();

create or replace function private.process_sale_status_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  calculated_subtotal numeric(12,2);
  item record;
begin
  if old.status = 'draft' and new.status = 'completed' then
    select coalesce(sum(si.line_total), 0) into calculated_subtotal from public.sale_items si where si.sale_id = new.id;
    if calculated_subtotal <= 0 then raise exception 'SALE_REQUIRES_ITEMS' using errcode = '23514'; end if;
    new.subtotal := calculated_subtotal;
    new.total := calculated_subtotal - new.discount;
    new.sold_at := coalesce(new.sold_at, now());
    if new.total < 0 then raise exception 'SALE_DISCOUNT_EXCEEDS_SUBTOTAL' using errcode = '23514'; end if;
    if (select coalesce(sum(mp.amount), 0) from public.member_payments mp where mp.sale_id = new.id and mp.status = 'confirmed') <> new.total then
      raise exception 'CONFIRMED_PAYMENTS_MUST_EQUAL_SALE_TOTAL' using errcode = '23514';
    end if;
    for item in select si.product_id, si.quantity from public.sale_items si where si.sale_id = new.id loop
      insert into public.inventory_movements(gym_id, product_id, location_id, movement_type, quantity_delta, stock_before, stock_after, sale_id, performed_by, reason)
      values (new.gym_id, item.product_id, new.location_id, 'sale', -item.quantity, 0, 0, new.id, new.seller_user_id, 'Venta completada');
    end loop;
  elsif old.status = 'completed' and new.status in ('voided', 'refunded') then
    for item in select si.product_id, si.quantity from public.sale_items si where si.sale_id = new.id loop
      insert into public.inventory_movements(gym_id, product_id, location_id, movement_type, quantity_delta, stock_before, stock_after, sale_id, performed_by, reason)
      values (new.gym_id, item.product_id, new.location_id, 'return', item.quantity, 0, 0, new.id, coalesce(new.voided_by, new.seller_user_id), 'Reversión de venta');
    end loop;
  elsif new.status <> old.status then
    raise exception 'INVALID_SALE_STATUS_TRANSITION' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.process_sale_status_change() from public, anon, authenticated;
create trigger sales_process_status before update of status on public.sales
for each row execute function private.process_sale_status_change();

create or replace function private.validate_work_shift()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from public.gym_locations gl where gl.id = new.location_id and gl.gym_id = new.gym_id and gl.is_active) then
    raise exception 'SHIFT_LOCATION_TENANT_MISMATCH' using errcode = '23514';
  end if;
  if not exists (select 1 from public.gym_users gu where gu.id = new.staff_user_id and gu.gym_id = new.gym_id and gu.role = 'staff' and gu.status = 'active') then
    raise exception 'SHIFT_REQUIRES_ACTIVE_STAFF' using errcode = '23514';
  end if;
  if new.reviewed_by is not null and not exists (select 1 from public.gym_users gu where gu.id = new.reviewed_by and gu.gym_id = new.gym_id and gu.role in ('owner','staff') and gu.status = 'active') then
    raise exception 'SHIFT_REVIEWER_TENANT_MISMATCH' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.status = 'reviewed' then raise exception 'REVIEWED_SHIFT_IS_IMMUTABLE' using errcode = '55000'; end if;
  if tg_op = 'UPDATE' and old.status = 'closed' and new.status = 'open' then raise exception 'CLOSED_SHIFT_CANNOT_REOPEN' using errcode = '23514'; end if;
  return new;
end;
$$;
revoke all on function private.validate_work_shift() from public, anon, authenticated;
create trigger work_shifts_validate before insert or update on public.work_shifts
for each row execute function private.validate_work_shift();

create or replace function private.populate_subscription_snapshot()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare plan_record record;
begin
  select sp.name, sp.price, sp.currency, sp.billing_interval, sp.features, sp.is_active into plan_record
  from public.saas_plans sp where sp.id = new.saas_plan_id;
  if plan_record.name is null or (tg_op = 'INSERT' and not plan_record.is_active) then
    raise exception 'ACTIVE_SAAS_PLAN_REQUIRED' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    new.plan_name_snapshot := plan_record.name; new.price_snapshot := plan_record.price;
    new.currency_snapshot := plan_record.currency; new.billing_interval_snapshot := plan_record.billing_interval;
    new.features_snapshot := plan_record.features;
  elsif new.saas_plan_id is distinct from old.saas_plan_id
     or new.plan_name_snapshot is distinct from old.plan_name_snapshot
     or new.price_snapshot is distinct from old.price_snapshot
     or new.currency_snapshot is distinct from old.currency_snapshot
     or new.billing_interval_snapshot is distinct from old.billing_interval_snapshot
     or new.features_snapshot is distinct from old.features_snapshot then
    raise exception 'SUBSCRIPTION_SNAPSHOT_IS_IMMUTABLE' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.populate_subscription_snapshot() from public, anon, authenticated;
create trigger gym_subscriptions_snapshot before insert or update on public.gym_subscriptions
for each row execute function private.populate_subscription_snapshot();

create or replace function private.validate_webhook_event_update()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.provider is distinct from old.provider
     or new.provider_event_id is distinct from old.provider_event_id
     or new.event_type is distinct from old.event_type
     or new.payload is distinct from old.payload
     or new.received_at is distinct from old.received_at then
    raise exception 'WEBHOOK_EVENT_IDENTITY_IS_IMMUTABLE' using errcode = '23514';
  end if;
  if old.signature_verified and not new.signature_verified then
    raise exception 'WEBHOOK_SIGNATURE_VERIFICATION_CANNOT_BE_REVOKED' using errcode = '23514';
  end if;
  if old.processing_status = 'processed' and new.processing_status <> old.processing_status then
    raise exception 'PROCESSED_WEBHOOK_IS_TERMINAL' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_webhook_event_update() from public, anon, authenticated;
create trigger payment_webhook_events_validate_update before update on private.payment_webhook_events
for each row execute function private.validate_webhook_event_update();

create or replace function private.validate_saas_transaction()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare subscription_record record;
begin
  select gs.gym_id, gs.provider into subscription_record from public.gym_subscriptions gs where gs.id = new.gym_subscription_id;
  if subscription_record.gym_id is distinct from new.gym_id or subscription_record.provider is distinct from new.provider then
    raise exception 'SAAS_TRANSACTION_SUBSCRIPTION_MISMATCH' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.gym_id is distinct from old.gym_id or new.gym_subscription_id is distinct from old.gym_subscription_id
    or new.provider is distinct from old.provider or new.provider_payment_id is distinct from old.provider_payment_id
    or new.amount is distinct from old.amount or new.currency is distinct from old.currency) then
    raise exception 'SAAS_TRANSACTION_FINANCIAL_FIELDS_ARE_IMMUTABLE' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_saas_transaction() from public, anon, authenticated;
create trigger saas_transactions_validate before insert or update on public.saas_payment_transactions
for each row execute function private.validate_saas_transaction();

create or replace function private.validate_audit_log()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.gym_id is not null and new.actor_gym_user_id is not null and not exists (
    select 1 from public.gym_users gu where gu.id = new.actor_gym_user_id and gu.gym_id = new.gym_id
  ) then raise exception 'AUDIT_ACTOR_TENANT_MISMATCH' using errcode = '23514'; end if;
  if new.gym_id is null and new.actor_profile_id is not null and not exists (
    select 1 from private.platform_admins pa where pa.profile_id = new.actor_profile_id and pa.status = 'active'
  ) then raise exception 'PLATFORM_AUDIT_REQUIRES_ACTIVE_ADMIN' using errcode = '23514'; end if;
  return new;
end;
$$;
revoke all on function private.validate_audit_log() from public, anon, authenticated;
create trigger audit_logs_validate before insert on public.audit_logs
for each row execute function private.validate_audit_log();

create or replace function private.validate_payment_sale_link()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare sale_record record;
begin
  if tg_op = 'UPDATE' and old.status = 'confirmed' and new.sale_id is distinct from old.sale_id then
    raise exception 'CONFIRMED_PAYMENT_BUSINESS_REFERENCE_IS_IMMUTABLE' using errcode = '23514';
  end if;
  if new.sale_id is not null then
    select s.gym_id, s.member_user_id into sale_record from public.sales s where s.id = new.sale_id;
    if sale_record.gym_id is distinct from new.gym_id or sale_record.member_user_id is distinct from new.member_user_id then
      raise exception 'PAYMENT_SALE_MISMATCH' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.validate_payment_sale_link() from public, anon, authenticated;
create trigger member_payments_validate_sale before insert or update of sale_id on public.member_payments
for each row execute function private.validate_payment_sale_link();

create or replace function private.validate_product_cost()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from public.products p where p.id = new.product_id and p.gym_id = new.gym_id) then
    raise exception 'PRODUCT_COST_TENANT_MISMATCH' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_product_cost() from public, anon, authenticated;
create trigger product_costs_validate before insert or update on private.product_costs
for each row execute function private.validate_product_cost();

create trigger products_set_updated_at before update on public.products for each row execute function private.set_updated_at();
create trigger sales_set_updated_at before update on public.sales for each row execute function private.set_updated_at();
create trigger work_shifts_set_updated_at before update on public.work_shifts for each row execute function private.set_updated_at();
create trigger saas_plans_set_updated_at before update on public.saas_plans for each row execute function private.set_updated_at();
create trigger gym_subscriptions_set_updated_at before update on public.gym_subscriptions for each row execute function private.set_updated_at();
create trigger saas_transactions_set_updated_at before update on public.saas_payment_transactions for each row execute function private.set_updated_at();
create trigger product_costs_set_updated_at before update on private.product_costs for each row execute function private.set_updated_at();

commit;
