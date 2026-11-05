-- LOCAL ONLY. Contains mutating fixtures. NEVER run in production, even with ROLLBACK.
-- Run after 0056 in an isolated test database.
begin;
set local lock_timeout='5s';
do $$
declare g uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); m uuid:=gen_random_uuid();
  result jsonb; instant timestamptz; boundary timestamptz; z text; local_time timestamp; failed boolean;
begin
  insert into public.gyms(id,name,slug) values(g,'Status fixture','status-'||g);
  insert into public.gym_locations(id,gym_id,name,timezone) values(l,g,'Status branch','America/Guayaquil');
  insert into auth.users(id,email) values(p,p||'@status.invalid');
  insert into public.profiles(id,full_name) values(p,'Status member');
  insert into public.gym_users(id,gym_id,profile_id,role,status,account_mode) values(m,g,p,'member','active','portal');
  insert into public.location_opening_hours(gym_id,location_id,weekday,day_mode,opens_at,closes_at)
    select g,l,n,'required','08:00','22:00' from generate_series(1,7) n;
  result:=public.get_member_branch_open_status_backend(g,m,l,'2026-11-06 07:59-05');
  if (result->>'isOpenNow')::boolean or (result->>'nextTransitionAt')::timestamptz<>'2026-11-06 08:00-05'::timestamptz
    or result->>'nextState'<>'open' then raise exception 'NORMAL_OPEN'; end if;
  result:=public.get_member_branch_open_status_backend(g,m,l,'2026-11-06 08:00-05');
  if not (result->>'isOpenNow')::boolean or (result->>'nextTransitionAt')::timestamptz<>'2026-11-06 22:00-05'::timestamptz then raise exception 'NORMAL_CLOSE'; end if;
  result:=public.get_member_branch_open_status_backend(g,m,l,'2026-11-06 22:00-05');
  if (result->>'isOpenNow')::boolean then raise exception 'EXCLUSIVE_CLOSE'; end if;
  update public.location_opening_hours set day_mode='closed',opens_at=null,closes_at=null where location_id=l;
  update public.location_opening_hours set day_mode='required',opens_at='20:00',closes_at='02:00' where location_id=l and weekday=5;
  foreach instant in array array['2026-11-06 23:59-05'::timestamptz,'2026-11-07 00:00-05'::timestamptz,'2026-11-07 01:00-05'::timestamptz] loop
    result:=public.get_member_branch_open_status_backend(g,m,l,instant);
    if not (result->>'isOpenNow')::boolean or (result->>'nextTransitionAt')::timestamptz<>'2026-11-07 02:00-05'::timestamptz then raise exception 'OVERNIGHT_WEEKLY_CLOSED'; end if;
  end loop;
  insert into public.location_calendar_exceptions(gym_id,location_id,calendar_date,day_mode,created_by)
    values(g,l,'2026-11-07','closed',m);
  result:=public.get_member_branch_open_status_backend(g,m,l,'2026-11-06 23:59-05');
  if (result->>'nextTransitionAt')::timestamptz<>'2026-11-07 00:00-05'::timestamptz then raise exception 'EXCEPTION_CUT'; end if;
  result:=public.get_member_branch_open_status_backend(g,m,l,'2026-11-07 01:00-05');
  if (result->>'isOpenNow')::boolean then raise exception 'EXCEPTION_CLOSED'; end if;
  update public.location_calendar_exceptions set day_mode='bonus',opens_at='10:00',closes_at='12:00' where location_id=l;
  result:=public.get_member_branch_open_status_backend(g,m,l,'2026-11-07 01:00-05');
  if (result->>'nextTransitionAt')::timestamptz<>'2026-11-07 10:00-05'::timestamptz then raise exception 'SPECIAL_HOURS'; end if;
  delete from public.location_calendar_exceptions where location_id=l;
  update public.location_opening_hours set day_mode='required',opens_at='08:00',closes_at='08:00' where location_id=l;
  result:=public.get_member_branch_open_status_backend(g,m,l,'2026-11-07 01:00-05');
  if not (result->>'isOpenNow')::boolean or result->>'nextTransitionAt' is not null or result->>'revalidateAt' is null then raise exception 'CONTIGUOUS_EQUAL_HOURS'; end if;
  -- Expectations are derived from THIS PostgreSQL's timezone database, not Intl.
  for z,local_time in select * from (values
    ('America/New_York','2026-03-08 02:30'::timestamp),
    ('America/New_York','2026-11-01 01:30'::timestamp),
    ('Africa/Casablanca','2026-10-04 00:30'::timestamp)) v(zone,wall) loop
    update public.gym_locations set timezone=z where id=l;
    update public.location_opening_hours set day_mode='closed',opens_at=null,closes_at=null where location_id=l;
    insert into public.location_calendar_exceptions(gym_id,location_id,calendar_date,day_mode,opens_at,closes_at,created_by)
      values(g,l,local_time::date,'bonus',local_time::time,'12:00',m);
    boundary:=local_time at time zone z;
    result:=public.get_member_branch_open_status_backend(g,m,l,boundary-interval '1 minute');
    if (result->>'isOpenNow')::boolean or (result->>'nextTransitionAt')::timestamptz<>boundary then raise exception 'DST_OPEN %',z; end if;
    result:=public.get_member_branch_open_status_backend(g,m,l,boundary);
    if not (result->>'isOpenNow')::boolean then raise exception 'DST_BOUNDARY %',z; end if;
    delete from public.location_calendar_exceptions where location_id=l;
  end loop;
  result:=public.get_member_branch_open_status_backend(g,m,l,'2026-11-08 12:00Z');
  if (result->>'isOpenNow')::boolean or result->>'nextState' is not null or result->>'revalidateAt' is null then raise exception 'EMPTY_HORIZON'; end if;
  failed:=false;
  begin perform public.get_member_branch_open_status_backend(gen_random_uuid(),m,l); exception when insufficient_privilege then failed:=true; end;
  if not failed then raise exception 'TENANT_ESCAPE'; end if;
  failed:=false;
  begin perform public.get_member_branch_open_status_backend(g,m,gen_random_uuid()); exception when insufficient_privilege then failed:=true; end;
  if not failed then raise exception 'LOCATION_ESCAPE'; end if;
  update public.gym_users set status='inactive' where id=m;
  failed:=false;
  begin perform public.get_member_branch_open_status_backend(g,m,l); exception when insufficient_privilege then failed:=true; end;
  if not failed then raise exception 'INACTIVE_ACTOR'; end if;
  if has_function_privilege('anon','public.get_member_branch_open_status_backend(uuid,uuid,uuid,timestamptz)','EXECUTE')
    or has_function_privilege('authenticated','public.get_member_branch_open_status_backend(uuid,uuid,uuid,timestamptz)','EXECUTE')
    or not has_function_privilege('service_role','public.get_member_branch_open_status_backend(uuid,uuid,uuid,timestamptz)','EXECUTE') then raise exception 'ACL'; end if;
end;$$;
select '0056 OK: boundaries, overnight, exceptions, equal hours, DST, horizon, isolation, ACL' result;
rollback;
