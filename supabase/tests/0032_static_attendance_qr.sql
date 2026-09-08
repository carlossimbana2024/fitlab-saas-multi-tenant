-- Ejecutar después de 0032_static_attendance_qr.sql en SQL Editor.
-- Crea un gimnasio y cuentas ficticias dentro de una transacción. Todo se revierte.
-- Si falla, ejecutar ROLLBACK antes de repetir. No deshabilita triggers ni RLS.
begin;
set local lock_timeout = '5s';
create temporary table qr_test_results(result text) on commit drop;
create function pg_temp.expect_qr_failure(statement text, expected_message text)
returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    if position(expected_message in sqlerrm) > 0 then return; end if;
    raise;
  end;
  raise exception 'EXPECTED_FAILURE_NOT_RAISED: %', expected_message;
end;
$$;

do $$
declare
  test_gym uuid := gen_random_uuid();
  branch uuid := gen_random_uuid();
  second_branch uuid := gen_random_uuid();
  owner_profile uuid := gen_random_uuid();
  member_profile uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  managed_id uuid := gen_random_uuid();
  plan_id uuid := gen_random_uuid();
  contract_id uuid := gen_random_uuid();
  period_id uuid := gen_random_uuid();
  today date := (now() at time zone 'America/Guayaquil')::date;
  local_time time := (now() at time zone 'America/Guayaquil')::time;
  first_code jsonb;
  result jsonb;
  first_attendance uuid;
  function_name text;
  user_status public.gym_user_status;
begin
  foreach function_name in array array[
    'public.manage_attendance_qr_backend(uuid,uuid,uuid,text,text)',
    'public.preview_attendance_qr_backend(uuid,uuid,text)',
    'public.register_attendance_qr_backend(uuid,uuid,text)'
  ] loop
    if has_function_privilege('authenticated', function_name, 'EXECUTE')
      or has_function_privilege('anon', function_name, 'EXECUTE')
      or not has_function_privilege('service_role', function_name, 'EXECUTE') then
      raise exception 'QR_FUNCTION_PRIVILEGES_INCORRECT: %', function_name;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.attendance_qr_codes', 'SELECT')
    or has_table_privilege('authenticated', 'public.attendances', 'INSERT') then
    raise exception 'DIRECT_QR_ACCESS_NOT_BLOCKED';
  end if;

  insert into auth.users(id, email) values(owner_profile, owner_profile || '@qr-test.invalid'), (member_profile, member_profile || '@qr-test.invalid');
  insert into public.profiles(id, full_name) values(owner_profile, 'Owner prueba QR'), (member_profile, 'Miembro prueba QR');
  insert into public.gyms(id,name,slug) values(test_gym, 'Gimnasio prueba QR', 'qr-test-' || test_gym);
  insert into public.gym_locations(id,gym_id,name) values(branch,test_gym,'Entrada principal'), (second_branch,test_gym,'Otra sucursal');
  insert into public.gym_users(id,gym_id,profile_id,role,status,default_location_id)
    values(owner_id,test_gym,owner_profile,'owner','active',branch), (member_id,test_gym,member_profile,'member','active',branch);
  insert into public.gym_users(id,gym_id,role,status,account_mode,managed_full_name,joined_at)
    values(managed_id,test_gym,'member','active','managed','Miembro sin portal',now());
  insert into public.plans(id,gym_id,name,price,duration_unit,duration_value,attendance_mode,weekly_target)
    values(plan_id,test_gym,'Plan prueba QR',0,'months',1,'weekly',3);
  insert into public.memberships(id,gym_id,member_user_id,plan_id,status,price_at_purchase,attendance_mode_snapshot,weekly_target_snapshot,created_by)
    values(contract_id,test_gym,member_id,plan_id,'pending',0,'weekly',3,owner_id);
  insert into public.membership_periods(id,gym_id,membership_id,starts_on,ends_on,status,charged_amount,currency)
    values(period_id,test_gym,contract_id,today,today + 30,'active',0,'USD');
  update public.memberships m set status = 'active' where m.id = contract_id;
  insert into public.location_opening_hours(gym_id,location_id,weekday,opens_at,closes_at,day_mode)
    select test_gym, gl.id, weekday::smallint,'00:00'::time,'00:00'::time,'required'::public.calendar_day_mode
    from public.gym_locations gl cross join generate_series(1,7) weekday where gl.gym_id = test_gym;

  perform pg_temp.expect_qr_failure(format('select public.manage_attendance_qr_backend(%L,%L,%L,%L,%L)',test_gym,member_id,branch,'generate',repeat('a',64)), 'ATTENDANCE_QR_OWNER_REQUIRED');
  first_code := public.manage_attendance_qr_backend(test_gym,owner_id,branch,'generate',repeat('a',64));
  if first_code ? 'token_hash' then raise exception 'QR_HASH_EXPOSED'; end if;
  perform pg_temp.expect_qr_failure(format(
    'insert into public.attendance_qr_codes(gym_id,location_id,token_hash,created_by) values(%L,%L,%L,%L)',
    test_gym,gen_random_uuid(),repeat('e',64),owner_id), 'TENANT_REFERENCE_MISMATCH');
  result := public.preview_attendance_qr_backend(test_gym,member_id,repeat('a',64));
  if (result->>'location_id')::uuid <> branch or result->'membership'->>'plan_name' <> 'Plan prueba QR'
    or exists(select 1 from public.attendances a where a.gym_id = test_gym) then
    raise exception 'PREVIEW_INVALID_OR_CREATED_ATTENDANCE';
  end if;
  perform pg_temp.expect_qr_failure(format('select public.preview_attendance_qr_backend(%L,%L,%L)',test_gym,member_id,repeat('b',64)), 'ATTENDANCE_QR_INVALID');
  perform pg_temp.expect_qr_failure(format('select public.preview_attendance_qr_backend(%L,%L,%L)',gen_random_uuid(),member_id,repeat('a',64)), 'ATTENDANCE_REQUIRES_ACTIVE_MEMBER');
  perform pg_temp.expect_qr_failure(format('select public.preview_attendance_qr_backend(%L,%L,%L)',test_gym,managed_id,repeat('a',64)), 'ATTENDANCE_QR_PORTAL_REQUIRED');
  foreach user_status in array array['suspended','inactive','invited']::public.gym_user_status[] loop
    update public.gym_users gu set status = user_status where gu.id = member_id;
    perform pg_temp.expect_qr_failure(format('select public.register_attendance_qr_backend(%L,%L,%L)',test_gym,member_id,repeat('a',64)), 'ATTENDANCE_REQUIRES_ACTIVE_MEMBER');
  end loop;
  update public.gym_users gu set status = 'active' where gu.id = member_id;
  update public.membership_periods mp set starts_on = today + 1 where mp.id = period_id;
  perform pg_temp.expect_qr_failure(format('select public.register_attendance_qr_backend(%L,%L,%L)',test_gym,member_id,repeat('a',64)), 'ACTIVE_MEMBERSHIP_PERIOD_REQUIRED');
  update public.membership_periods mp set starts_on = today - 2, ends_on = today - 1 where mp.id = period_id;
  perform pg_temp.expect_qr_failure(format('select public.register_attendance_qr_backend(%L,%L,%L)',test_gym,member_id,repeat('a',64)), 'ACTIVE_MEMBERSHIP_PERIOD_REQUIRED');
  update public.membership_periods mp set starts_on = today, ends_on = today + 30 where mp.id = period_id;
  update public.gym_locations gl set is_active = false where gl.id = branch;
  perform pg_temp.expect_qr_failure(format('select public.register_attendance_qr_backend(%L,%L,%L)',test_gym,member_id,repeat('a',64)), 'ATTENDANCE_LOCATION_MISMATCH');
  update public.gym_locations gl set is_active = true where gl.id = branch;
  insert into public.location_calendar_exceptions(gym_id,location_id,calendar_date,day_mode,created_by)
    values(test_gym,branch,today,'closed',owner_id);
  perform pg_temp.expect_qr_failure(format('select public.register_attendance_qr_backend(%L,%L,%L)',test_gym,member_id,repeat('a',64)), 'ATTENDANCE_LOCATION_IS_CLOSED');
  update public.location_calendar_exceptions lce set day_mode = 'required',
    opens_at = local_time + interval '1 hour', closes_at = local_time + interval '2 hours'
    where lce.location_id = branch and lce.calendar_date = today;
  perform pg_temp.expect_qr_failure(format('select public.register_attendance_qr_backend(%L,%L,%L)',test_gym,member_id,repeat('a',64)), 'ATTENDANCE_OUTSIDE_OPENING_HOURS');
  delete from public.location_calendar_exceptions lce where lce.location_id = branch;

  result := public.register_attendance_qr_backend(test_gym,member_id,repeat('a',64));
  first_attendance := (result->'attendance'->>'id')::uuid;
  if first_attendance is null or (result->>'already_registered')::boolean then raise exception 'QR_CHECKIN_FAILED'; end if;
  result := public.register_attendance_qr_backend(test_gym,member_id,repeat('a',64));
  if (result->'attendance'->>'id')::uuid <> first_attendance or not (result->>'already_registered')::boolean then raise exception 'QR_CHECKIN_NOT_IDEMPOTENT'; end if;
  perform public.manage_attendance_qr_backend(test_gym,owner_id,second_branch,'generate',repeat('c',64));
  result := public.register_attendance_qr_backend(test_gym,member_id,repeat('c',64));
  if (result->'attendance'->>'id')::uuid <> first_attendance then raise exception 'SECOND_BRANCH_DUPLICATED_ATTENDANCE'; end if;
  if (select count(*) from public.attendances a where a.gym_id = test_gym) <> 1
    or (select count(*) from public.audit_logs al where al.gym_id = test_gym and al.action = 'attendance.registered_by_qr') <> 1 then
    raise exception 'DUPLICATE_ATTENDANCE_OR_AUDIT';
  end if;
  -- La racha se evalúa al cerrar el día/período; la entrada actualiza su fecha y eventos.
  if not exists(select 1 from public.user_streaks us where us.member_user_id = member_id and us.last_attendance_date = today)
    or (select count(*) from public.streak_events se where se.attendance_id = first_attendance and se.event_type = 'attendance_recorded') <> 1
    or not exists(select 1 from public.weekly_attendance_progress wp where wp.membership_id = contract_id and wp.completed_attendances = 1) then
    raise exception 'QR_STREAK_OR_WEEKLY_PROGRESS_NOT_UPDATED';
  end if;
  perform pg_temp.expect_qr_failure(format('update public.attendances set attendance_qr_code_id = null where id = %L',first_attendance), 'ATTENDANCE_QR_PROVENANCE_IMMUTABLE');
  perform public.manage_attendance_qr_backend(test_gym,owner_id,branch,'generate',repeat('d',64));
  perform pg_temp.expect_qr_failure(format('select public.register_attendance_qr_backend(%L,%L,%L)',test_gym,member_id,repeat('a',64)), 'ATTENDANCE_QR_INVALID');
  update public.attendance_qr_codes q set expires_at = now() - interval '1 minute' where q.token_hash = repeat('d',64);
  perform pg_temp.expect_qr_failure(format('select public.preview_attendance_qr_backend(%L,%L,%L)',test_gym,member_id,repeat('d',64)), 'ATTENDANCE_QR_INVALID');
  perform public.manage_attendance_qr_backend(test_gym,owner_id,second_branch,'revoke');
  perform pg_temp.expect_qr_failure(format('select public.register_attendance_qr_backend(%L,%L,%L)',test_gym,member_id,repeat('c',64)), 'ATTENDANCE_QR_INVALID');
  if exists(select 1 from public.audit_logs al where al.gym_id = test_gym and
    (coalesce(al.after_data::text,'') like '%token_hash%' or coalesce(al.before_data::text,'') like '%token_hash%')) then
    raise exception 'SECRET_IN_AUDIT';
  end if;
  insert into qr_test_results values('0032 OK: QR, permisos, cobertura, horarios, revocación, asistencia diaria, racha y auditoría comprobados. Todo se revierte.');
end;
$$;
select * from qr_test_results;
rollback;
