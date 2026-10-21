-- Run after 0048 in a development database. All fixtures are rolled back.
begin;
set local lock_timeout = '5s';
do $$
declare
  g uuid := gen_random_uuid();
  p uuid := gen_random_uuid();
  m uuid := gen_random_uuid();
  client_a public.member_fitness_profiles;
  client_b public.member_fitness_profiles;
  result public.member_fitness_profiles;
  rejected boolean := false;
begin
  insert into auth.users(id,email) values(p,p||'@privacy-test.invalid');
  insert into public.profiles(id,full_name) values(p,'Privacy regression');
  insert into public.gyms(id,name,slug) values(g,'Privacy test','privacy-'||g);
  insert into public.gym_users(id,gym_id,profile_id,role,status,account_mode)
    values(m,g,p,'member','active','portal');
  insert into public.member_fitness_profiles(gym_id,member_user_id,weight_kg,height_cm,goal_type,show_in_community)
    values(g,m,80,175,'improve_fitness',true) returning * into client_a;
  client_b := client_a;

  -- Two clients read the same snapshot; A opts out, then stale B changes another field.
  perform public.update_member_privacy_backend(g,m,'show_in_community',false);
  result := public.update_member_privacy_backend(g,m,'show_streak',not client_b.show_streak);
  if result.show_in_community or not result.show_streak or result.weight_kg <> 80 then
    raise exception 'STALE_CLIENT_RESTORED_PRIVACY';
  end if;

  -- A stale legacy full payload must fail atomically instead of restoring consent.
  begin
    perform public.upsert_member_fitness_profile_backend(
      g,m,81::numeric,175::numeric,'improve_fitness','beginner',3::smallint,
      '{}'::smallint[],null::numeric,null::text,null::smallint,null::text,
      client_b.show_in_community,client_b.show_profile_photo,client_b.show_streak,
      client_b.show_attendance_count,client_b.show_weight_progress,client_b.show_goal);
  exception when others then
    if sqlerrm <> 'MEMBER_PRIVACY_REQUIRES_PARTIAL_UPDATE' then raise; end if;
    rejected := true;
  end;
  if not rejected then raise exception 'LEGACY_STALE_WRITE_ACCEPTED'; end if;

  -- Sports writes omit privacy (null); the stored preferences are preserved.
  result := public.upsert_member_fitness_profile_backend(
    g,m,81::numeric,175::numeric,'improve_fitness','beginner',3::smallint,
    '{}'::smallint[],null::numeric,null::text,null::smallint,null::text,
    null::boolean,null::boolean,null::boolean,null::boolean,null::boolean,null::boolean);
  if result.show_in_community or not result.show_streak or result.weight_kg <> 81 then
    raise exception 'SPORTS_WRITE_CHANGED_PRIVACY';
  end if;

  -- Normal explicit preference update still works.
  result := public.update_member_privacy_backend(g,m,'show_in_community',true);
  if not result.show_in_community or not result.show_streak then
    raise exception 'INDIVIDUAL_UPDATE_FAILED';
  end if;
  if has_function_privilege('authenticated','public.update_member_privacy_backend(uuid,uuid,text,boolean)','EXECUTE')
     or has_function_privilege('anon','public.update_member_privacy_backend(uuid,uuid,text,boolean)','EXECUTE') then
    raise exception 'DIRECT_PRIVACY_RPC_ACCESS';
  end if;
end;
$$;
select '0048 OK: stale snapshots, legacy rejection, sports preservation, explicit preference' as result;
rollback;
