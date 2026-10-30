-- Run after 0053. Isolated fixtures, no changes survive ROLLBACK.
begin;
set local lock_timeout='5s';
do $$
declare g uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); s uuid;
  other_g uuid:=gen_random_uuid(); owner_id uuid:=gen_random_uuid(); profile_id uuid:=gen_random_uuid(); failed boolean:=false; before_start timestamptz;
begin
  insert into public.gyms(id,name,slug) values(g,'Hours fixture','hours-'||g);
  insert into public.gym_locations(id,gym_id,name,timezone) values(l,g,'Branch','America/Guayaquil');
  insert into auth.users(id,email) values(profile_id,profile_id||'@hours.invalid');
  insert into public.profiles(id,full_name) values(profile_id,'Hours owner');
  insert into public.gym_users(id,gym_id,profile_id,role,status) values(owner_id,g,profile_id,'owner','active');
  insert into public.extra_classes(id,gym_id,name,billing_mode,price,capacity,duration_minutes)
    values(a,g,'Hours class','included',0,5,60);
  if private.class_interval_within_opening_hours(g,l,'2099-10-30 06:00-05','2099-10-30 07:00-05') then raise exception 'MISSING_HOURS_ALLOWED'; end if;
  insert into public.location_opening_hours(gym_id,location_id,weekday,day_mode,opens_at,closes_at)
    select g,l,d,'required','06:00','22:00' from generate_series(1,7) d;
  if not private.class_interval_within_opening_hours(g,l,'2099-10-30 06:00-05','2099-10-30 22:00-05')
    or private.class_interval_within_opening_hours(g,l,'2099-10-30 05:59-05','2099-10-30 07:00-05')
    or private.class_interval_within_opening_hours(g,l,'2099-10-30 21:30-05','2099-10-30 22:30-05')
    or private.class_interval_within_opening_hours(other_g,l,'2099-10-30 12:00-05','2099-10-30 13:00-05') then raise exception 'HOURS_BOUNDARY_OR_TENANT'; end if;
  begin
    insert into public.class_schedules(gym_id,location_id,extra_class_id,starts_at,ends_at)
      values(g,l,a,'2099-10-30 21:30-05','2099-10-30 22:30-05');
  exception when check_violation then
    if sqlerrm<>'CLASS_OUTSIDE_OPENING_HOURS' then raise; end if; failed:=true;
  end;
  if not failed then raise exception 'INSERT_BYPASSED_HOURS'; end if;
  -- The real API RPC uses current catalog duration, not a client-supplied end.
  failed:=false;
  begin
    perform public.create_class_schedule_backend(g,a,l,null,'2099-10-30 21:30-05',null,owner_id,false);
  exception when check_violation then
    if sqlerrm<>'CLASS_OUTSIDE_OPENING_HOURS' then raise; end if; failed:=true;
  end;
  if not failed then raise exception 'RPC_BYPASSED_HOURS'; end if;
  perform public.create_class_schedule_backend(g,a,l,null,'2099-10-30 06:00-05',null,owner_id,false);
  insert into public.class_schedules(gym_id,location_id,extra_class_id,starts_at,ends_at)
    values(g,l,a,'2099-10-30 21:00-05','2099-10-30 22:00-05') returning id,starts_at into s,before_start;
  update public.location_opening_hours set closes_at='20:00' where location_id=l;
  if (select starts_at from public.class_schedules where id=s)<>before_start then raise exception 'EXISTING_CLASS_CHANGED'; end if;
  if private.class_interval_within_opening_hours(g,l,'2099-10-30 21:00-05','2099-10-30 22:00-05') then raise exception 'STALE_HOURS'; end if;
  failed:=false;
  begin
    update public.class_schedules set starts_at='2099-10-30 20:30-05',ends_at='2099-10-30 21:30-05' where id=s;
  exception when check_violation then
    if sqlerrm<>'CLASS_OUTSIDE_OPENING_HOURS' then raise; end if; failed:=true;
  end;
  if not failed then raise exception 'UPDATE_BYPASSED_HOURS'; end if;
  update public.location_opening_hours set opens_at='20:00',closes_at='04:00' where location_id=l;
  if not private.class_interval_within_opening_hours(g,l,'2099-10-30 23:30-05','2099-10-31 01:00-05')
    or not private.class_interval_within_opening_hours(g,l,'2099-10-31 02:00-05','2099-10-31 03:00-05') then raise exception 'OVERNIGHT_REJECTED'; end if;
  insert into public.location_calendar_exceptions(gym_id,location_id,calendar_date,day_mode,created_by)
    values(g,l,'2099-10-31','closed',owner_id);
  if private.class_interval_within_opening_hours(g,l,'2099-10-30 23:30-05','2099-10-31 01:00-05') then raise exception 'EXCEPTION_NOT_APPLIED'; end if;
  update public.location_calendar_exceptions set day_mode='bonus',opens_at='10:00',closes_at='12:00'
    where location_id=l and calendar_date='2099-10-31';
  if not private.class_interval_within_opening_hours(g,l,'2099-10-31 10:00-05','2099-10-31 12:00-05')
    or private.class_interval_within_opening_hours(g,l,'2099-10-31 02:00-05','2099-10-31 03:00-05') then raise exception 'SPECIAL_HOURS'; end if;
  update public.gym_locations set timezone='Pacific/Galapagos' where id=l;
  if not private.class_interval_within_opening_hours(g,l,'2099-10-31 10:00-06','2099-10-31 12:00-06')
    or private.class_interval_within_opening_hours(g,l,'2099-10-31 10:00-05','2099-10-31 11:00-05') then raise exception 'BRANCH_TIMEZONE'; end if;
  if has_function_privilege('authenticated','private.class_interval_within_opening_hours(uuid,uuid,timestamptz,timestamptz)','EXECUTE')
    or has_function_privilege('service_role','private.class_interval_within_opening_hours(uuid,uuid,timestamptz,timestamptz)','EXECUTE') then raise exception 'PRIVILEGES'; end if;
end; $$;
select '0053 OK: horario vigente, zona horaria, duración completa, cierres, nocturnos, aislamiento e historial preservado' result;
rollback;
