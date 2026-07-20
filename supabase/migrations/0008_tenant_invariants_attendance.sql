begin;

-- Defensa adicional para relaciones que todavía no tienen un validador específico.
-- RLS limita filas visibles, pero no garantiza por sí solo que dos claves foráneas
-- pertenezcan al mismo gimnasio.
create or replace function private.enforce_tenant_reference()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reference_id uuid;
  reference_gym_id uuid;
begin
  reference_id := nullif(to_jsonb(new) ->> tg_argv[0], '')::uuid;
  if reference_id is null then
    return new;
  end if;

  execute format('select gym_id from public.%I where id = $1', tg_argv[1])
    into reference_gym_id
    using reference_id;

  if reference_gym_id is null or reference_gym_id <> new.gym_id then
    raise exception 'TENANT_REFERENCE_MISMATCH: %.% does not belong to gym %',
      tg_table_name, tg_argv[0], new.gym_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_tenant_reference() from public, anon, authenticated;

create trigger gym_users_location_tenant
before insert or update of gym_id, default_location_id on public.gym_users
for each row execute function private.enforce_tenant_reference('default_location_id', 'gym_locations');

create trigger opening_hours_location_tenant
before insert or update of gym_id, location_id on public.location_opening_hours
for each row execute function private.enforce_tenant_reference('location_id', 'gym_locations');

create trigger calendar_location_tenant
before insert or update of gym_id, location_id on public.location_calendar_exceptions
for each row execute function private.enforce_tenant_reference('location_id', 'gym_locations');

-- Impide que dos operaciones concurrentes degraden o eliminen simultáneamente
-- a los últimos owners activos del gimnasio.
create or replace function private.prevent_last_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removes_active_owner boolean;
begin
  if tg_op = 'DELETE' then
    removes_active_owner := old.role = 'owner' and old.status = 'active';
  else
    removes_active_owner := old.role = 'owner'
      and old.status = 'active'
      and (new.role <> 'owner' or new.status <> 'active');
  end if;

  if removes_active_owner then
    perform 1 from public.gyms g where g.id = old.gym_id for update;
    if (
      select count(*) from public.gym_users gu
      where gu.gym_id = old.gym_id and gu.role = 'owner' and gu.status = 'active'
    ) <= 1 then
      raise exception 'GYM_MUST_KEEP_ONE_ACTIVE_OWNER' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_last_owner_removal() from public, anon, authenticated;
create trigger gym_users_keep_owner
before update or delete on public.gym_users
for each row execute function private.prevent_last_owner_removal();

-- Reglas temporales de asistencia. Las relaciones de miembro, gimnasio, sucursal,
-- fuente y clase ya se validan específicamente en 0005.
create or replace function private.validate_attendance_time_and_coverage()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  gym_timezone text;
  local_checkin_date date;
  local_today date;
  effective_day_mode public.calendar_day_mode;
begin
  select g.timezone into gym_timezone
  from public.gyms g where g.id = new.gym_id;

  if gym_timezone is null then
    raise exception 'GYM_TIMEZONE_NOT_FOUND' using errcode = '23514';
  end if;

  local_checkin_date := (new.checked_in_at at time zone gym_timezone)::date;
  local_today := (now() at time zone gym_timezone)::date;

  if tg_op = 'INSERT' then
    if new.attendance_date <> local_checkin_date or new.attendance_date <> local_today then
      raise exception 'ATTENDANCE_DATE_MUST_BE_TODAY_IN_GYM_TIMEZONE' using errcode = '23514';
    end if;

    if not exists (
      select 1
      from public.memberships m
      join public.membership_periods mp on mp.membership_id = m.id
      where m.id = new.membership_id
        and m.gym_id = new.gym_id
        and m.member_user_id = new.member_user_id
        and m.status = 'active'
        and mp.gym_id = new.gym_id
        and mp.status = 'active'
        and new.attendance_date between mp.starts_on and mp.ends_on
    ) then
      raise exception 'ACTIVE_MEMBERSHIP_PERIOD_REQUIRED' using errcode = '23514';
    end if;

    select coalesce(lce.day_mode, loh.day_mode, 'closed'::public.calendar_day_mode)
      into effective_day_mode
    from public.gym_locations gl
    left join public.location_calendar_exceptions lce
      on lce.location_id = gl.id and lce.calendar_date = new.attendance_date
    left join public.location_opening_hours loh
      on loh.location_id = gl.id
     and loh.weekday = extract(isodow from new.attendance_date)::smallint
    where gl.id = new.location_id and gl.gym_id = new.gym_id and gl.is_active;

    if effective_day_mode is null or effective_day_mode = 'closed' then
      raise exception 'ATTENDANCE_LOCATION_IS_CLOSED' using errcode = '23514';
    end if;
  elsif old.status = 'valid' and new.status = 'voided' then
    if old.attendance_date <> local_today then
      raise exception 'ATTENDANCE_CAN_ONLY_BE_VOIDED_SAME_DAY' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.validate_attendance_time_and_coverage() from public, anon, authenticated;
create trigger attendance_time_and_coverage
before insert or update of status on public.attendances
for each row execute function private.validate_attendance_time_and_coverage();

-- Los privilegios mínimos y las políticas se definen en 0007_rls.sql.
-- Esta migración no amplía permisos de tablas.

commit;
