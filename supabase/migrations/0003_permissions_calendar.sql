begin;

create table public.permission_catalog (
  key text primary key check (key ~ '^[a-z_]+\.[a-z_]+$'),
  name text not null,
  description text,
  supports_pin_elevation boolean not null default true,
  is_sensitive boolean not null default false
);

insert into public.permission_catalog (key, name, supports_pin_elevation, is_sensitive) values
  ('members.view', 'Ver miembros', true, false),
  ('members.manage', 'Gestionar miembros', true, true),
  ('attendance.register', 'Registrar asistencias', false, false),
  ('attendance.void', 'Anular asistencias', true, true),
  ('payments.register', 'Registrar pagos', true, true),
  ('payments.void', 'Anular pagos', true, true),
  ('finances.view', 'Ver finanzas', true, true),
  ('products.manage', 'Gestionar productos', true, false),
  ('inventory.adjust', 'Ajustar inventario', true, true),
  ('sales.register', 'Registrar ventas', false, false),
  ('sales.void', 'Anular ventas', true, true),
  ('classes.manage', 'Gestionar clases', true, false),
  ('classes.bookings_manage', 'Gestionar reservas de clases', true, false),
  ('shifts.manage', 'Gestionar turnos', true, true),
  ('reports.view', 'Ver reportes', true, true),
  ('calendar.manage', 'Gestionar calendario', true, true),
  ('staff.manage', 'Gestionar trabajadores', false, true),
  ('settings.manage', 'Gestionar configuración', false, true);

create table public.staff_permissions (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  staff_user_id uuid not null references public.gym_users(id) on delete cascade,
  permission_key text not null references public.permission_catalog(key),
  access_mode public.permission_access_mode not null default 'denied',
  granted_by uuid not null references public.gym_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_user_id, permission_key)
);

create index staff_permissions_gym_staff_idx on public.staff_permissions(gym_id, staff_user_id);

create table private.admin_elevation_sessions (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  staff_user_id uuid not null references public.gym_users(id) on delete cascade,
  permission_key text not null references public.permission_catalog(key),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table public.location_opening_hours (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  location_id uuid not null references public.gym_locations(id) on delete cascade,
  -- ISO-8601: 1 = lunes, 7 = domingo.
  weekday smallint not null check (weekday between 1 and 7),
  opens_at time,
  closes_at time,
  day_mode public.calendar_day_mode not null default 'required',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((day_mode = 'closed' and opens_at is null and closes_at is null) or
         (day_mode <> 'closed' and opens_at is not null and closes_at is not null)),
  unique (location_id, weekday)
);

create table public.location_calendar_exceptions (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  location_id uuid not null references public.gym_locations(id) on delete cascade,
  calendar_date date not null,
  day_mode public.calendar_day_mode not null,
  opens_at time,
  closes_at time,
  reason text,
  created_by uuid not null references public.gym_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((day_mode = 'closed' and opens_at is null and closes_at is null) or
         (day_mode <> 'closed' and opens_at is not null and closes_at is not null)),
  unique (location_id, calendar_date)
);

comment on column public.location_opening_hours.closes_at is
  'Si closes_at es menor o igual que opens_at, el cierre ocurre al día siguiente.';

-- Denegar acceso por defecto hasta que 0007_rls.sql incorpore las políticas.
alter table public.permission_catalog enable row level security;
alter table public.staff_permissions enable row level security;
alter table public.location_opening_hours enable row level security;
alter table public.location_calendar_exceptions enable row level security;

create or replace function private.validate_staff_permission_assignment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_role public.gym_role;
  target_status public.gym_user_status;
  target_gym_id uuid;
  granter_profile_id uuid;
  granter_role public.gym_role;
  granter_status public.gym_user_status;
  granter_gym_id uuid;
  pin_supported boolean;
begin
  select gu.role, gu.status, gu.gym_id
    into target_role, target_status, target_gym_id
  from public.gym_users gu
  where gu.id = new.staff_user_id;

  if target_role is distinct from 'staff'
     or target_status not in ('invited', 'active')
     or target_gym_id is distinct from new.gym_id then
    raise exception 'PERMISSION_TARGET_MUST_BE_STAFF_IN_SAME_GYM' using errcode = '23514';
  end if;

  select gu.profile_id, gu.role, gu.status, gu.gym_id
    into granter_profile_id, granter_role, granter_status, granter_gym_id
  from public.gym_users gu
  where gu.id = new.granted_by;

  if granter_role is distinct from 'owner'
     or granter_status is distinct from 'active'
     or granter_gym_id is distinct from new.gym_id then
    raise exception 'PERMISSIONS_MUST_BE_GRANTED_BY_ACTIVE_OWNER' using errcode = '42501';
  end if;

  if (select auth.uid()) is not null and granter_profile_id <> (select auth.uid()) then
    raise exception 'GRANTER_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
  end if;

  select pc.supports_pin_elevation into pin_supported
  from public.permission_catalog pc
  where pc.key = new.permission_key;

  if new.access_mode = 'requires_pin' and pin_supported is distinct from true then
    raise exception 'PERMISSION_DOES_NOT_SUPPORT_PIN_ELEVATION' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.validate_staff_permission_assignment() from public, anon, authenticated;

create trigger staff_permissions_validate_assignment
before insert or update on public.staff_permissions
for each row execute function private.validate_staff_permission_assignment();

create or replace function private.validate_elevation_session()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.gym_users gu
    join public.staff_permissions sp
      on sp.staff_user_id = gu.id
     and sp.gym_id = gu.gym_id
    join public.permission_catalog pc
      on pc.key = sp.permission_key
    where gu.id = new.staff_user_id
      and gu.gym_id = new.gym_id
      and gu.role = 'staff'
      and gu.status = 'active'
      and sp.permission_key = new.permission_key
      and sp.access_mode = 'requires_pin'
      and pc.supports_pin_elevation = true
  ) then
    raise exception 'INVALID_PIN_ELEVATION_SESSION' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_elevation_session() from public, anon, authenticated;

create trigger admin_elevation_sessions_validate
before insert or update on private.admin_elevation_sessions
for each row execute function private.validate_elevation_session();

create or replace function private.validate_calendar_exception_actor()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
begin
  select gu.profile_id into actor_profile_id
  from public.gym_users gu
  where gu.id = new.created_by
    and gu.gym_id = new.gym_id
    and gu.status = 'active';

  if actor_profile_id is null then
    raise exception 'CALENDAR_ACTOR_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;

  if (select auth.uid()) is not null and actor_profile_id <> (select auth.uid()) then
    raise exception 'CALENDAR_ACTOR_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function private.validate_calendar_exception_actor() from public, anon, authenticated;

create trigger calendar_exceptions_validate_actor
before insert or update of gym_id, created_by
on public.location_calendar_exceptions
for each row execute function private.validate_calendar_exception_actor();

create trigger staff_permissions_set_updated_at before update on public.staff_permissions
for each row execute function private.set_updated_at();
create trigger location_opening_hours_set_updated_at before update on public.location_opening_hours
for each row execute function private.set_updated_at();
create trigger location_calendar_exceptions_set_updated_at before update on public.location_calendar_exceptions
for each row execute function private.set_updated_at();

commit;