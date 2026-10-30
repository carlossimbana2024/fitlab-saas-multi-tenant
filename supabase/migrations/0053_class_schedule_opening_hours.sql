begin;
set local lock_timeout = '5s';

-- Serialize calendar changes and scheduling against the same branch row.
-- Existing sessions/bookings are never moved, cancelled or rewritten.
create or replace function private.lock_class_calendar_location()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    perform 1 from public.gym_locations where id=old.location_id and gym_id=old.gym_id for update;
    return old;
  end if;
  perform 1 from public.gym_locations where id=new.location_id and gym_id=new.gym_id for update;
  return new;
end; $$;
create trigger class_hours_serialize before insert or update or delete on public.location_opening_hours
for each row execute function private.lock_class_calendar_location();
create trigger class_exceptions_serialize before insert or update or delete on public.location_calendar_exceptions
for each row execute function private.lock_class_calendar_location();

create or replace function private.class_interval_within_opening_hours(g uuid,l uuid,s timestamptz,e timestamptz)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare tz text; covered tstzmultirange;
begin
  select timezone into tz from public.gym_locations where id=l and gym_id=g and is_active;
  if tz is null or s is null or e is null or e<=s or e-s>interval '7 days' then return false; end if;
  -- Exception replaces the weekly schedule, including the previous night's tail.
  with days as (
    select d::date as day from generate_series((s at time zone tz)::date-1,
      (e at time zone tz)::date,interval '1 day') d
  ), rules as (
    select day,coalesce(x.day_mode,h.day_mode,'closed'::public.calendar_day_mode) mode,
      case when x.id is not null then x.opens_at else h.opens_at end opens,
      case when x.id is not null then x.closes_at else h.closes_at end closes,
      exists(select 1 from public.location_calendar_exceptions nx
        where nx.gym_id=g and nx.location_id=l and nx.calendar_date=day+1) next_exception
    from days left join public.location_opening_hours h
      on h.gym_id=g and h.location_id=l and h.weekday=extract(isodow from day)::smallint
    left join public.location_calendar_exceptions x on x.gym_id=g and x.location_id=l and x.calendar_date=day
  ), windows as (
    select (day+opens) at time zone tz a,
      (case when closes<=opens and next_exception then (day+1)::timestamp
        else day+closes+case when closes<=opens then interval '1 day' else interval '0 days' end end) at time zone tz b
    from rules where mode<>'closed' and opens is not null and closes is not null
  ) select range_agg(tstzrange(a,b,'[)')) into covered from windows where b>a;
  return coalesce(covered @> tstzrange(s,e,'[)'),false);
end; $$;

create or replace function private.validate_class_schedule_opening_hours()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.status <> 'scheduled' then return new; end if;
  if tg_op='UPDATE' and (new.location_id,new.gym_id,new.starts_at,new.ends_at,new.status)
    is not distinct from (old.location_id,old.gym_id,old.starts_at,old.ends_at,old.status) then return new; end if;
  perform 1 from public.gym_locations where id=new.location_id and gym_id=new.gym_id for update;
  if not private.class_interval_within_opening_hours(new.gym_id,new.location_id,new.starts_at,new.ends_at) then
    raise exception 'CLASS_OUTSIDE_OPENING_HOURS' using errcode='23514';
  end if;
  return new;
end; $$;
create trigger class_schedule_opening_hours before insert or update of location_id,gym_id,starts_at,ends_at,status
on public.class_schedules for each row execute function private.validate_class_schedule_opening_hours();

revoke all on function private.lock_class_calendar_location(),
  private.class_interval_within_opening_hours(uuid,uuid,timestamptz,timestamptz),
  private.validate_class_schedule_opening_hours() from public,anon,authenticated,service_role;
commit;
