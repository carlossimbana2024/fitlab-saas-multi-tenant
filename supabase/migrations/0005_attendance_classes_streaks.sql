begin;

create table public.extra_classes (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  description text,
  price numeric(12,2) not null default 0 check (price >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  capacity integer not null check (capacity > 0),
  duration_minutes integer not null check (duration_minutes > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index extra_classes_name_case_insensitive_idx
  on public.extra_classes(gym_id, lower(trim(name)));

create table public.class_schedules (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  location_id uuid not null references public.gym_locations(id),
  extra_class_id uuid not null references public.extra_classes(id),
  instructor_user_id uuid references public.gym_users(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity_override integer check (capacity_override > 0),
  status public.class_schedule_status not null default 'scheduled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index class_schedules_location_start_idx
  on public.class_schedules(gym_id, location_id, starts_at);

create table public.class_bookings (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  class_schedule_id uuid not null references public.class_schedules(id) on delete cascade,
  member_user_id uuid not null references public.gym_users(id),
  status public.class_booking_status not null default 'reserved',
  payment_id uuid references public.member_payments(id),
  booked_at timestamptz not null default now(),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'cancelled' and cancelled_at is not null)
    or (status <> 'cancelled' and cancelled_at is null)
  ),
  unique (class_schedule_id, member_user_id)
);

create index class_bookings_schedule_status_idx
  on public.class_bookings(class_schedule_id, status);

create table public.attendances (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  location_id uuid not null references public.gym_locations(id),
  member_user_id uuid not null references public.gym_users(id),
  membership_id uuid not null references public.memberships(id),
  attendance_date date not null,
  checked_in_at timestamptz not null default now(),
  source public.attendance_source not null,
  class_booking_id uuid references public.class_bookings(id),
  counts_toward_streak boolean not null default true,
  status public.attendance_status not null default 'valid',
  registered_by uuid references public.gym_users(id),
  voided_at timestamptz,
  voided_by uuid references public.gym_users(id),
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'voided' and voided_at is not null and voided_by is not null and nullif(trim(void_reason), '') is not null)
    or (status = 'valid' and voided_at is null and voided_by is null and void_reason is null)
  )
);

create unique index attendances_one_valid_per_day_idx
  on public.attendances(member_user_id, attendance_date)
  where status = 'valid';
create index attendances_gym_date_idx on public.attendances(gym_id, attendance_date desc);

create table public.attendance_events (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  attendance_id uuid not null references public.attendances(id) on delete cascade,
  event_type text not null check (event_type in ('created', 'corrected', 'voided')),
  performed_by uuid references public.gym_users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.user_streaks (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  member_user_id uuid not null references public.gym_users(id) on delete cascade,
  current_streak integer not null default 0 check (current_streak >= 0),
  longest_streak integer not null default 0 check (longest_streak >= current_streak),
  last_attendance_date date,
  status public.streak_status not null default 'active' check (status in ('active', 'frozen')),
  frozen_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((status = 'frozen' and frozen_at is not null) or (status = 'active' and frozen_at is null)),
  unique (member_user_id)
);

create table public.weekly_attendance_progress (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  member_user_id uuid not null references public.gym_users(id) on delete cascade,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  week_starts_on date not null,
  week_ends_on date not null,
  target_attendances smallint not null check (target_attendances between 1 and 7),
  completed_attendances smallint not null default 0 check (completed_attendances between 0 and 7),
  goal_met boolean generated always as (completed_attendances >= target_attendances) stored,
  is_grace_week boolean not null default false,
  evaluated_at timestamptz,
  updated_at timestamptz not null default now(),
  check (week_ends_on = week_starts_on + 6),
  check (extract(isodow from week_starts_on) = 1),
  unique (membership_id, week_starts_on)
);

create table public.streak_events (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  member_user_id uuid not null references public.gym_users(id) on delete cascade,
  membership_id uuid references public.memberships(id) on delete set null,
  attendance_id uuid references public.attendances(id) on delete set null,
  event_type text not null check (event_type in ('attendance_recorded', 'attendance_voided', 'incremented', 'weekly_goal_completed', 'grace_week', 'reset', 'frozen', 'resumed')),
  previous_value integer,
  new_value integer,
  effective_date date not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- RLS se activa de inmediato; 0007_rls.sql incorporará las políticas.
alter table public.extra_classes enable row level security;
alter table public.class_schedules enable row level security;
alter table public.class_bookings enable row level security;
alter table public.attendances enable row level security;
alter table public.attendance_events enable row level security;
alter table public.user_streaks enable row level security;
alter table public.weekly_attendance_progress enable row level security;
alter table public.streak_events enable row level security;

create or replace function private.validate_class_schedule()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  location_gym_id uuid;
  class_gym_id uuid;
begin
  select gl.gym_id into location_gym_id
  from public.gym_locations gl where gl.id = new.location_id and gl.is_active = true;
  select ec.gym_id into class_gym_id
  from public.extra_classes ec where ec.id = new.extra_class_id and ec.is_active = true;

  if location_gym_id is distinct from new.gym_id or class_gym_id is distinct from new.gym_id then
    raise exception 'CLASS_SCHEDULE_REFERENCES_MUST_BELONG_TO_SAME_GYM' using errcode = '23514';
  end if;

  if new.instructor_user_id is not null and not exists (
    select 1 from public.gym_users gu
    where gu.id = new.instructor_user_id
      and gu.gym_id = new.gym_id
      and gu.role in ('owner', 'staff')
      and gu.status = 'active'
  ) then
    raise exception 'CLASS_INSTRUCTOR_MUST_BE_ACTIVE_OWNER_OR_STAFF' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and old.status in ('cancelled', 'completed') and new.status <> old.status then
    raise exception 'TERMINAL_CLASS_SCHEDULE_CANNOT_BE_REOPENED' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.validate_class_schedule() from public, anon, authenticated;
create trigger class_schedules_validate
before insert or update on public.class_schedules
for each row execute function private.validate_class_schedule();

create or replace function private.validate_class_booking()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  schedule_record record;
  effective_capacity integer;
begin
  select cs.gym_id, cs.status, cs.starts_at,
         coalesce(cs.capacity_override, ec.capacity) as capacity
    into schedule_record
  from public.class_schedules cs
  join public.extra_classes ec on ec.id = cs.extra_class_id
  where cs.id = new.class_schedule_id
  for update of cs;

  if schedule_record.gym_id is distinct from new.gym_id then
    raise exception 'CLASS_BOOKING_SCHEDULE_TENANT_MISMATCH' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.gym_users gu
    where gu.id = new.member_user_id
      and gu.gym_id = new.gym_id
      and gu.role = 'member'
      and gu.status = 'active'
  ) then
    raise exception 'CLASS_BOOKING_REQUIRES_ACTIVE_MEMBER' using errcode = '23514';
  end if;

  if new.status in ('reserved', 'attended') then
    if schedule_record.status <> 'scheduled' and not (new.status = 'attended' and schedule_record.status = 'completed') then
      raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode = '23514';
    end if;

    effective_capacity := schedule_record.capacity;
    if (
      select count(*) from public.class_bookings cb
      where cb.class_schedule_id = new.class_schedule_id
        and cb.status in ('reserved', 'attended')
        and cb.id <> new.id
    ) >= effective_capacity then
      raise exception 'CLASS_CAPACITY_REACHED' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'INSERT' and new.status = 'reserved' and schedule_record.starts_at <= now() then
    raise exception 'PAST_CLASS_CANNOT_BE_BOOKED' using errcode = '23514';
  end if;

  if new.payment_id is not null and not exists (
    select 1 from public.member_payments mp
    where mp.id = new.payment_id
      and mp.gym_id = new.gym_id
      and mp.member_user_id = new.member_user_id
      and mp.status = 'confirmed'
  ) then
    raise exception 'CLASS_BOOKING_PAYMENT_MISMATCH' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if old.status in ('attended', 'no_show') and new.status <> old.status then
      raise exception 'TERMINAL_CLASS_BOOKING_CANNOT_CHANGE' using errcode = '23514';
    end if;
    if old.status = 'cancelled' and new.status = 'reserved' and schedule_record.starts_at <= now() then
      raise exception 'PAST_CLASS_CANNOT_BE_REBOOKED' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.validate_class_booking() from public, anon, authenticated;
create trigger class_bookings_validate
before insert or update on public.class_bookings
for each row execute function private.validate_class_booking();

create or replace function private.validate_attendance_relations()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  member_profile_id uuid;
  membership_plan_id uuid;
  gym_timezone text;
  booking_record record;
  actor_profile_id uuid;
begin
  select gu.profile_id into member_profile_id
  from public.gym_users gu
  where gu.id = new.member_user_id
    and gu.gym_id = new.gym_id
    and gu.role = 'member'
    and gu.status = 'active';

  if member_profile_id is null then
    raise exception 'ATTENDANCE_REQUIRES_ACTIVE_MEMBER' using errcode = '23514';
  end if;

  select m.plan_id into membership_plan_id
  from public.memberships m
  where m.id = new.membership_id
    and m.gym_id = new.gym_id
    and m.member_user_id = new.member_user_id;

  if membership_plan_id is null then
    raise exception 'ATTENDANCE_MEMBERSHIP_MISMATCH' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.gym_locations gl
    where gl.id = new.location_id and gl.gym_id = new.gym_id and gl.is_active = true
  ) then
    raise exception 'ATTENDANCE_LOCATION_MISMATCH' using errcode = '23514';
  end if;

  if new.source = 'staff' then
    select gu.profile_id into actor_profile_id from public.gym_users gu
    where gu.id = new.registered_by and gu.gym_id = new.gym_id
      and gu.role in ('owner', 'staff') and gu.status = 'active';
    if actor_profile_id is null then
      raise exception 'STAFF_ATTENDANCE_REQUIRES_ACTIVE_ACTOR' using errcode = '23514';
    end if;
  elsif new.source = 'qr' then
    if new.registered_by is distinct from new.member_user_id then
      raise exception 'QR_ATTENDANCE_MUST_BE_REGISTERED_BY_MEMBER' using errcode = '23514';
    end if;
    actor_profile_id := member_profile_id;
  elsif new.source = 'extra_class' then
    select cb.member_user_id, cb.gym_id, cb.status,
           (cs.starts_at at time zone g.timezone)::date as class_date
      into booking_record
    from public.class_bookings cb
    join public.class_schedules cs on cs.id = cb.class_schedule_id
    join public.gyms g on g.id = cb.gym_id
    where cb.id = new.class_booking_id;

    if booking_record.member_user_id is distinct from new.member_user_id
       or booking_record.gym_id is distinct from new.gym_id
       or booking_record.status not in ('reserved', 'attended')
       or booking_record.class_date is distinct from new.attendance_date then
      raise exception 'EXTRA_CLASS_BOOKING_MISMATCH' using errcode = '23514';
    end if;

    new.counts_toward_streak := coalesce(
      (select p.allows_extra_classes from public.plans p where p.id = membership_plan_id),
      false
    );
  elsif new.source = 'system' then
    if (select auth.uid()) is not null or new.registered_by is not null then
      raise exception 'SYSTEM_ATTENDANCE_REQUIRES_PRIVILEGED_CONTEXT' using errcode = '42501';
    end if;
  end if;

  if new.source <> 'extra_class' and new.class_booking_id is not null then
    raise exception 'CLASS_BOOKING_ONLY_ALLOWED_FOR_EXTRA_CLASS_SOURCE' using errcode = '23514';
  end if;

  if (select auth.uid()) is not null and actor_profile_id <> (select auth.uid()) then
    raise exception 'ATTENDANCE_ACTOR_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function private.validate_attendance_relations() from public, anon, authenticated;
create trigger attendances_validate_relations
before insert on public.attendances
for each row execute function private.validate_attendance_relations();

create or replace function private.protect_attendance_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  voider_profile_id uuid;
begin
  if new.gym_id is distinct from old.gym_id
     or new.location_id is distinct from old.location_id
     or new.member_user_id is distinct from old.member_user_id
     or new.membership_id is distinct from old.membership_id
     or new.attendance_date is distinct from old.attendance_date
     or new.checked_in_at is distinct from old.checked_in_at
     or new.source is distinct from old.source
     or new.class_booking_id is distinct from old.class_booking_id
     or new.counts_toward_streak is distinct from old.counts_toward_streak
     or new.registered_by is distinct from old.registered_by then
    raise exception 'ATTENDANCE_CORE_FIELDS_ARE_IMMUTABLE' using errcode = '23514';
  end if;

  if old.status = 'voided' and new.status <> old.status then
    raise exception 'VOIDED_ATTENDANCE_CANNOT_BE_REACTIVATED' using errcode = '23514';
  end if;

  if old.status = 'valid' and new.status = 'voided' then
    select gu.profile_id into voider_profile_id
    from public.gym_users gu
    where gu.id = new.voided_by
      and gu.gym_id = new.gym_id
      and gu.role in ('owner', 'staff')
      and gu.status = 'active';

    if voider_profile_id is null then
      raise exception 'ATTENDANCE_VOIDER_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
    end if;

    if (select auth.uid()) is not null and voider_profile_id <> (select auth.uid()) then
      raise exception 'ATTENDANCE_VOIDER_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.protect_attendance_update() from public, anon, authenticated;
create trigger attendances_protect_update
before update on public.attendances
for each row execute function private.protect_attendance_update();

create or replace function private.validate_weekly_progress()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  membership_record record;
  expected_grace boolean;
begin
  select m.gym_id, m.member_user_id, m.attendance_mode_snapshot, m.weekly_target_snapshot
    into membership_record
  from public.memberships m where m.id = new.membership_id;

  if membership_record.gym_id is distinct from new.gym_id
     or membership_record.member_user_id is distinct from new.member_user_id
     or membership_record.attendance_mode_snapshot is distinct from 'weekly'
     or membership_record.weekly_target_snapshot is distinct from new.target_attendances then
    raise exception 'WEEKLY_PROGRESS_MEMBERSHIP_MISMATCH' using errcode = '23514';
  end if;

  expected_grace := exists (
    select 1 from public.membership_periods mp
    where mp.membership_id = new.membership_id
      and mp.status = 'active'
      and mp.starts_on between new.week_starts_on + 1 and new.week_ends_on
  );

  if new.is_grace_week is distinct from expected_grace then
    raise exception 'WEEKLY_GRACE_FLAG_MISMATCH' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.validate_weekly_progress() from public, anon, authenticated;
create trigger weekly_progress_validate
before insert or update on public.weekly_attendance_progress
for each row execute function private.validate_weekly_progress();

create or replace function private.prevent_event_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'EVENT_ROWS_ARE_IMMUTABLE' using errcode = '55000';
end;
$$;

revoke all on function private.prevent_event_update() from public, anon, authenticated;
create trigger attendance_events_immutable before update on public.attendance_events
for each row execute function private.prevent_event_update();
create trigger streak_events_immutable before update on public.streak_events
for each row execute function private.prevent_event_update();

create trigger extra_classes_set_updated_at before update on public.extra_classes
for each row execute function private.set_updated_at();
create trigger class_schedules_set_updated_at before update on public.class_schedules
for each row execute function private.set_updated_at();
create trigger class_bookings_set_updated_at before update on public.class_bookings
for each row execute function private.set_updated_at();
create trigger attendances_set_updated_at before update on public.attendances
for each row execute function private.set_updated_at();
create trigger user_streaks_set_updated_at before update on public.user_streaks
for each row execute function private.set_updated_at();
create trigger weekly_progress_set_updated_at before update on public.weekly_attendance_progress
for each row execute function private.set_updated_at();

commit;
