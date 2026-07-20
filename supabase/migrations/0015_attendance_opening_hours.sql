begin;

-- Valida tanto el día como la franja horaria. La apertura es inclusiva y el
-- cierre exclusivo. Si closes_at <= opens_at, el cierre es al día siguiente.
create or replace function private.validate_attendance_time_and_coverage()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  gym_timezone text;
  local_checkin timestamp;
  local_checkin_date date;
  local_checkin_time time;
  local_today date;
  effective_day_mode public.calendar_day_mode;
  effective_opens_at time;
  effective_closes_at time;
  previous_day_mode public.calendar_day_mode;
  previous_opens_at time;
  previous_closes_at time;
  current_date_has_exception boolean;
  inside_current_window boolean := false;
  inside_previous_overnight_window boolean := false;
begin
  select g.timezone into gym_timezone from public.gyms g where g.id = new.gym_id;
  if gym_timezone is null then
    raise exception 'GYM_TIMEZONE_NOT_FOUND' using errcode = '23514';
  end if;

  local_checkin := new.checked_in_at at time zone gym_timezone;
  local_checkin_date := local_checkin::date;
  local_checkin_time := local_checkin::time;
  local_today := (now() at time zone gym_timezone)::date;

  if tg_op = 'INSERT' then
    if new.attendance_date <> local_checkin_date or new.attendance_date <> local_today then
      raise exception 'ATTENDANCE_DATE_MUST_BE_TODAY_IN_GYM_TIMEZONE' using errcode = '23514';
    end if;

    if not exists (
      select 1 from public.memberships m
      join public.membership_periods mp on mp.membership_id = m.id
      where m.id = new.membership_id and m.gym_id = new.gym_id
        and m.member_user_id = new.member_user_id and m.status = 'active'
        and mp.gym_id = new.gym_id and mp.status = 'active'
        and new.attendance_date between mp.starts_on and mp.ends_on
    ) then
      raise exception 'ACTIVE_MEMBERSHIP_PERIOD_REQUIRED' using errcode = '23514';
    end if;

    if not exists (
      select 1 from public.gym_locations gl
      where gl.id = new.location_id and gl.gym_id = new.gym_id and gl.is_active
    ) then
      raise exception 'ATTENDANCE_LOCATION_IS_CLOSED' using errcode = '23514';
    end if;

    select exists (
      select 1 from public.location_calendar_exceptions lce
      where lce.location_id = new.location_id and lce.calendar_date = local_checkin_date
    ) into current_date_has_exception;

    select coalesce(lce.day_mode, loh.day_mode, 'closed'::public.calendar_day_mode),
           case when lce.id is not null then lce.opens_at else loh.opens_at end,
           case when lce.id is not null then lce.closes_at else loh.closes_at end
      into effective_day_mode, effective_opens_at, effective_closes_at
    from public.gym_locations gl
    left join public.location_calendar_exceptions lce
      on lce.location_id = gl.id and lce.calendar_date = local_checkin_date
    left join public.location_opening_hours loh
      on loh.location_id = gl.id
     and loh.weekday = extract(isodow from local_checkin_date)::smallint
    where gl.id = new.location_id and gl.gym_id = new.gym_id and gl.is_active;

    if effective_day_mode <> 'closed'
       and effective_opens_at is not null and effective_closes_at is not null then
      if effective_closes_at > effective_opens_at then
        inside_current_window := local_checkin_time >= effective_opens_at
          and local_checkin_time < effective_closes_at;
      else
        inside_current_window := local_checkin_time >= effective_opens_at;
      end if;
    end if;

    -- Una excepción explícita para hoy gobierna toda la fecha. Sin excepción,
    -- se permite el tramo posterior a medianoche del horario del día anterior.
    if not current_date_has_exception then
      select coalesce(lce.day_mode, loh.day_mode, 'closed'::public.calendar_day_mode),
             case when lce.id is not null then lce.opens_at else loh.opens_at end,
             case when lce.id is not null then lce.closes_at else loh.closes_at end
        into previous_day_mode, previous_opens_at, previous_closes_at
      from public.gym_locations gl
      left join public.location_calendar_exceptions lce
        on lce.location_id = gl.id and lce.calendar_date = local_checkin_date - 1
      left join public.location_opening_hours loh
        on loh.location_id = gl.id
       and loh.weekday = extract(isodow from local_checkin_date - 1)::smallint
      where gl.id = new.location_id and gl.gym_id = new.gym_id and gl.is_active;

      inside_previous_overnight_window := previous_day_mode <> 'closed'
        and previous_opens_at is not null and previous_closes_at is not null
        and previous_closes_at <= previous_opens_at
        and local_checkin_time < previous_closes_at;
    end if;

    if effective_day_mode = 'closed' and not inside_previous_overnight_window then
      raise exception 'ATTENDANCE_LOCATION_IS_CLOSED' using errcode = '23514';
    end if;
    if not inside_current_window and not inside_previous_overnight_window then
      raise exception 'ATTENDANCE_OUTSIDE_OPENING_HOURS' using errcode = '23514';
    end if;
  elsif old.status = 'valid' and new.status = 'voided' then
    if old.attendance_date <> local_today then
      raise exception 'ATTENDANCE_CAN_ONLY_BE_VOIDED_SAME_DAY' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.validate_attendance_time_and_coverage()
from public, anon, authenticated;

commit;
