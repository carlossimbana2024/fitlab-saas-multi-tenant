begin;
set local lock_timeout='5s';

-- Read-only backend API. Actor identity must come from authenticated tenantContext.
create function public.get_member_branch_open_status_backend(
  target_gym_id uuid, actor_member_user_id uuid, target_location_id uuid,
  requested_at timestamptz default now()
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare tz text; day date; horizon timestamptz; current_open boolean;
  transition_at timestamptz; transition_open boolean; candidate timestamptz;
begin
  perform private.require_member_aggregate_reader(target_gym_id,actor_member_user_id);
  select timezone into tz from public.gym_locations
    where id=target_location_id and gym_id=target_gym_id and is_active;
  if tz is null then raise exception 'LOCATION_NOT_FOUND' using errcode='42501'; end if;
  if requested_at is null or not isfinite(requested_at) then
    raise exception 'INVALID_STATUS_INSTANT' using errcode='22023';
  end if;
  day:=(requested_at at time zone tz)::date;
  horizon:=(day+8)::timestamp at time zone tz;
  -- A point is tested as one PostgreSQL microsecond, preserving [open,close).
  current_open:=private.class_interval_within_opening_hours(target_gym_id,target_location_id,
    requested_at,requested_at+interval '1 microsecond');
  -- Enumerate potential boundaries only. 0053 remains the authority deciding
  -- whether each boundary is a genuine change, including adjacent windows.
  for candidate in
    with days as (select day+n d from generate_series(-1,8) n), rules as (
      select d,case when x.id is not null then x.opens_at else h.opens_at end opens,
        case when x.id is not null then x.closes_at else h.closes_at end closes
      from days left join public.location_opening_hours h
        on h.gym_id=target_gym_id and h.location_id=target_location_id
        and h.weekday=extract(isodow from d)::smallint
      left join public.location_calendar_exceptions x
        on x.gym_id=target_gym_id and x.location_id=target_location_id and x.calendar_date=d
    ), boundaries as (
      select d::timestamp at time zone tz t from rules
      union select (d+opens) at time zone tz from rules where opens is not null
      union select (d+closes+case when closes<=opens then interval '1 day' else interval '0 days' end) at time zone tz
        from rules where opens is not null and closes is not null
    ) select t from boundaries where t>requested_at and t<horizon order by t
  loop
    transition_open:=private.class_interval_within_opening_hours(target_gym_id,target_location_id,
      candidate,candidate+interval '1 microsecond');
    if transition_open<>current_open then transition_at:=candidate; exit; end if;
  end loop;
  return jsonb_build_object('isOpenNow',current_open,'nextTransitionAt',transition_at,
    'nextState',case when transition_at is null then null when transition_open then 'open' else 'closed' end,
    'timezone',tz,'evaluatedAt',requested_at,'validUntil',horizon,
    'revalidateAt',coalesce(transition_at,horizon));
end;$$;
revoke all on function public.get_member_branch_open_status_backend(uuid,uuid,uuid,timestamptz)
  from public,anon,authenticated;
grant execute on function public.get_member_branch_open_status_backend(uuid,uuid,uuid,timestamptz) to service_role;
commit;
