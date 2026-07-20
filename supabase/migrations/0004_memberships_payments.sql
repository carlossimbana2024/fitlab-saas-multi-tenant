begin;

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  description text,
  price numeric(12,2) not null check (price >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  duration_unit public.duration_unit not null,
  duration_value integer not null check (duration_value > 0),
  attendance_mode public.attendance_mode not null,
  weekly_target smallint,
  allows_extra_classes boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((attendance_mode = 'weekly' and weekly_target between 1 and 7) or
         (attendance_mode = 'daily' and weekly_target is null))
);

create unique index plans_name_case_insensitive_idx
  on public.plans(gym_id, lower(trim(name)));

comment on column public.plans.allows_extra_classes is
  'Indica si la asistencia a una clase extra puede contar para la racha; no implica que la clase sea gratuita.';

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  member_user_id uuid not null references public.gym_users(id),
  plan_id uuid not null references public.plans(id),
  status public.membership_status not null default 'pending',
  price_at_purchase numeric(12,2) not null check (price_at_purchase >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  attendance_mode_snapshot public.attendance_mode not null,
  weekly_target_snapshot smallint,
  created_by uuid not null references public.gym_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((attendance_mode_snapshot = 'weekly' and weekly_target_snapshot between 1 and 7) or
         (attendance_mode_snapshot = 'daily' and weekly_target_snapshot is null))
);

comment on table public.memberships is
  'Relación contractual del miembro. La cobertura efectiva se determina exclusivamente mediante membership_periods.';

create index memberships_member_idx on public.memberships(gym_id, member_user_id);
create unique index memberships_one_active_per_member_idx
  on public.memberships(member_user_id)
  where status = 'active';

create table public.membership_periods (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  status public.membership_status not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  unique (membership_id, starts_on, ends_on)
);

create index membership_periods_coverage_idx
  on public.membership_periods(membership_id, starts_on, ends_on, status);

create table public.member_payments (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  location_id uuid not null references public.gym_locations(id),
  member_user_id uuid references public.gym_users(id),
  membership_id uuid references public.memberships(id),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  payment_method public.member_payment_method not null,
  status public.payment_status not null default 'confirmed',
  external_reference text,
  notes text,
  registered_by uuid not null references public.gym_users(id),
  paid_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references public.gym_users(id),
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'voided' and voided_at is not null and voided_by is not null and nullif(trim(void_reason), '') is not null)
    or
    (status <> 'voided' and voided_at is null and voided_by is null and void_reason is null)
  ),
  check (
    payment_method not in ('bank_transfer', 'external_card', 'external_deuna')
    or nullif(trim(external_reference), '') is not null
  )
);

create index member_payments_gym_paid_idx on public.member_payments(gym_id, paid_at desc);
create index member_payments_member_idx on public.member_payments(member_user_id, paid_at desc);

alter table public.membership_periods
  add column payment_id uuid references public.member_payments(id);

create unique index membership_periods_one_period_per_payment_idx
  on public.membership_periods(payment_id)
  where payment_id is not null;

-- Denegar acceso por defecto hasta que 0007_rls.sql incorpore las políticas.
alter table public.plans enable row level security;
alter table public.memberships enable row level security;
alter table public.membership_periods enable row level security;
alter table public.member_payments enable row level security;

create or replace function private.validate_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  member_role public.gym_role;
  member_status public.gym_user_status;
  member_gym_id uuid;
  creator_profile_id uuid;
  creator_role public.gym_role;
  creator_status public.gym_user_status;
  creator_gym_id uuid;
  plan_gym_id uuid;
  plan_attendance_mode public.attendance_mode;
  plan_weekly_target smallint;
begin
  select gu.role, gu.status, gu.gym_id
    into member_role, member_status, member_gym_id
  from public.gym_users gu where gu.id = new.member_user_id;

  if member_role is distinct from 'member'
     or member_status is distinct from 'active'
     or member_gym_id is distinct from new.gym_id then
    raise exception 'MEMBERSHIP_REQUIRES_ACTIVE_MEMBER_IN_SAME_GYM' using errcode = '23514';
  end if;

  select p.gym_id, p.attendance_mode, p.weekly_target
    into plan_gym_id, plan_attendance_mode, plan_weekly_target
  from public.plans p where p.id = new.plan_id and p.is_active = true;

  if plan_gym_id is distinct from new.gym_id then
    raise exception 'MEMBERSHIP_REQUIRES_ACTIVE_PLAN_IN_SAME_GYM' using errcode = '23514';
  end if;

  if new.attendance_mode_snapshot is distinct from plan_attendance_mode
     or new.weekly_target_snapshot is distinct from plan_weekly_target then
    raise exception 'MEMBERSHIP_ATTENDANCE_RULES_MUST_MATCH_PLAN' using errcode = '23514';
  end if;

  select gu.profile_id, gu.role, gu.status, gu.gym_id
    into creator_profile_id, creator_role, creator_status, creator_gym_id
  from public.gym_users gu where gu.id = new.created_by;

  if creator_role not in ('owner', 'staff')
     or creator_status is distinct from 'active'
     or creator_gym_id is distinct from new.gym_id then
    raise exception 'MEMBERSHIP_CREATOR_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;

  if (select auth.uid()) is not null and creator_profile_id <> (select auth.uid()) then
    raise exception 'MEMBERSHIP_CREATOR_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function private.validate_membership() from public, anon, authenticated;
create trigger memberships_validate
before insert or update of gym_id, member_user_id, plan_id, attendance_mode_snapshot, weekly_target_snapshot, created_by
on public.memberships
for each row execute function private.validate_membership();

create or replace function private.validate_membership_period()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  membership_gym_id uuid;
  membership_member_id uuid;
  payment_gym_id uuid;
  payment_membership_id uuid;
  payment_member_id uuid;
  linked_payment_status public.payment_status;
begin
  select m.gym_id, m.member_user_id
    into membership_gym_id, membership_member_id
  from public.memberships m where m.id = new.membership_id;

  if membership_gym_id is distinct from new.gym_id then
    raise exception 'MEMBERSHIP_PERIOD_TENANT_MISMATCH' using errcode = '23514';
  end if;

  if new.status <> 'cancelled' and exists (
    select 1
    from public.membership_periods mp
    join public.memberships other_membership on other_membership.id = mp.membership_id
    where other_membership.member_user_id = membership_member_id
      and mp.id <> new.id
      and mp.status <> 'cancelled'
      and daterange(mp.starts_on, mp.ends_on, '[]') && daterange(new.starts_on, new.ends_on, '[]')
  ) then
    raise exception 'MEMBER_COVERAGE_PERIODS_CANNOT_OVERLAP' using errcode = '23P01';
  end if;

  -- Un periodo cancelado conserva el vínculo histórico con su pago aunque ese
  -- pago ya haya sido anulado o reembolsado.
  if new.payment_id is not null and new.status <> 'cancelled' then
    select p.gym_id, p.membership_id, p.member_user_id, p.status
      into payment_gym_id, payment_membership_id, payment_member_id, linked_payment_status
    from public.member_payments p where p.id = new.payment_id;

    if payment_gym_id is distinct from new.gym_id
       or payment_membership_id is distinct from new.membership_id
       or payment_member_id is distinct from membership_member_id
       or linked_payment_status is distinct from 'confirmed' then
      raise exception 'MEMBERSHIP_PERIOD_PAYMENT_MISMATCH' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.validate_membership_period() from public, anon, authenticated;
create trigger membership_periods_validate
before insert or update on public.membership_periods
for each row execute function private.validate_membership_period();

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

  if tg_op = 'INSERT' and (select auth.uid()) is not null and actor_profile_id <> (select auth.uid()) then
    raise exception 'PAYMENT_REGISTERER_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
  end if;

  if new.status = 'voided' and not exists (
    select 1 from public.gym_users gu
    where gu.id = new.voided_by
      and gu.gym_id = new.gym_id
      and gu.role in ('owner', 'staff')
      and gu.status = 'active'
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
create trigger member_payments_validate
before insert or update on public.member_payments
for each row execute function private.validate_member_payment();

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
create trigger member_payments_protect_confirmed
before update on public.member_payments
for each row execute function private.protect_confirmed_payment_fields();

create trigger plans_set_updated_at before update on public.plans
for each row execute function private.set_updated_at();
create trigger memberships_set_updated_at before update on public.memberships
for each row execute function private.set_updated_at();
create trigger membership_periods_set_updated_at before update on public.membership_periods
for each row execute function private.set_updated_at();
create trigger member_payments_set_updated_at before update on public.member_payments
for each row execute function private.set_updated_at();

commit;
