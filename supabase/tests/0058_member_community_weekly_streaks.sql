-- LOCAL ONLY. Requires the isolated in-memory runner; never run in Supabase.
begin;
do $$
declare
  g uuid:=gen_random_uuid(); other_g uuid:=gen_random_uuid(); location_id uuid:=gen_random_uuid();
  plan_id uuid:=gen_random_uuid(); viewer uuid; winner uuid; hidden_streak uuid; other_viewer uuid;
  monday date; today date; page jsonb; cursor_value jsonb; ids uuid[]:='{}'; row_data jsonb;
  steps integer:=0; denied boolean:=false;
begin
  if current_setting('fitlab.isolated_aggregate_test',true) is distinct from 'true' then
    raise exception 'LOCAL_RUNNER_REQUIRED';
  end if;
  today:=(now() at time zone 'America/Guayaquil')::date;
  monday:=today-(extract(isodow from today)::integer-1);
  create temporary table streak_community_fixture(n int,id uuid,profile uuid,contract uuid) on commit drop;
  insert into streak_community_fixture select n,gen_random_uuid(),gen_random_uuid(),gen_random_uuid() from generate_series(0,363) n;
  select id into viewer from streak_community_fixture where n=0;
  select id into winner from streak_community_fixture where n=360;
  select id into hidden_streak from streak_community_fixture where n=1;
  select id into other_viewer from streak_community_fixture where n=363;

  perform set_config('session_replication_role','replica',true);
  insert into public.gyms(id,name,slug) values(g,'Weekly gym','weekly-'||g),(other_g,'Other gym','other-'||other_g);
  insert into public.gym_locations(id,gym_id,name) values(location_id,g,'Weekly branch');
  insert into auth.users(id,email) select profile,profile||'@weekly.invalid' from streak_community_fixture;
  insert into public.profiles(id,full_name)
    select profile,case when n between 2 and 3 then 'Equal name' else 'Member '||lpad(n::text,4,'0') end from streak_community_fixture;
  insert into public.gym_users(id,gym_id,profile_id,role,status,account_mode)
    select id,case when n=363 then other_g else g end,profile,'member',case when n=362 then 'inactive'::public.gym_user_status else 'active'::public.gym_user_status end,'portal'
    from streak_community_fixture;
  insert into public.member_fitness_profiles(gym_id,member_user_id,weight_kg,height_cm,goal_type,show_in_community,show_streak)
    select case when n=363 then other_g else g end,id,80,175,'lose_weight',n<>361,n<>1 from streak_community_fixture;
  insert into public.plans(id,gym_id,name,price,duration_unit,duration_value,attendance_mode,weekly_target)
    values(plan_id,g,'Weekly plan',30,'months',1,'weekly',3);
  insert into public.memberships(id,gym_id,member_user_id,plan_id,status,price_at_purchase,attendance_mode_snapshot,weekly_target_snapshot,created_by)
    select contract,g,id,plan_id,'active',30,'weekly',3,viewer from streak_community_fixture where n in (1,2,3,360);
  insert into public.membership_periods(gym_id,membership_id,starts_on,ends_on,status,charged_amount,currency,original_amount)
    select g,contract,monday-21,today+30,'active',30,'USD',30 from streak_community_fixture where n in (1,2,3,360);
  insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,source,status,counts_toward_streak)
    select g,location_id,id,contract,monday-21+d,'system','valid',true from streak_community_fixture cross join generate_series(0,20) d
    where d%7<3 and (n in (1,360) or (n in (2,3) and d>=14));
  insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,source,status,counts_toward_streak)
    select g,location_id,id,contract,'2020-07-01'::date+d,'system','valid',false
    from streak_community_fixture cross join generate_series(0,3) d where n=360;
  perform set_config('session_replication_role','origin',true);

  loop
    page:=public.list_member_community_weekly_page_backend(g,viewer,'longest_streak',20,cursor_value);
    steps:=steps+1;
    if steps=1 and (page#>>'{items,0,id}' is distinct from winner::text or page#>>'{items,0,weeklyStreak,best}' is distinct from '3') then
      raise exception 'WEEKLY_WINNER_OUTSIDE_FIRST_PAGE';
    end if;
    for row_data in select value from jsonb_array_elements(page->'items') loop
      if row_data?'currentStreak' or row_data?'longestStreak' or row_data?'dailyCurrentStreak' then raise exception 'WRONG_UNIT_EXPOSED';end if;
      if (row_data->>'id')::uuid=hidden_streak and row_data->'weeklyStreak' is distinct from 'null'::jsonb then raise exception 'STREAK_PRIVACY';end if;
      ids:=array_append(ids,(row_data->>'id')::uuid);
    end loop;
    exit when not (page->>'hasMore')::boolean;
    cursor_value:=page->'nextCursor';
    if steps>18 then raise exception 'CURSOR_LOOP';end if;
  end loop;
  if steps<>18 or cardinality(ids)<>360 or (select count(distinct x) from unnest(ids) x)<>360 then raise exception 'INVALID_WEEKLY_PAGINATION';end if;
  if not hidden_streak=any(ids) or viewer=any(ids) or other_viewer=any(ids)
    or exists(select 1 from streak_community_fixture where n in (361,362) and id=any(ids)) then raise exception 'COMMUNITY_VISIBILITY';end if;
  page:=public.list_member_community_weekly_page_backend(g,viewer,'all',50,null);
  if not exists(select 1 from jsonb_array_elements(page->'items') e where e#>>'{weeklyStreak,best}'='1') then raise exception 'MISSING_PAGE_ENRICHMENT';end if;
  page:=public.get_member_community_rankings_backend(g,viewer,'2020-07-01');
  if page#>>'{categories,streak,0,memberUserId}' is distinct from winner::text
    or page#>>'{categories,streak,0,value}' is distinct from '4' then raise exception 'MONTHLY_RANKING_CHANGED %',page;end if;

  begin perform public.list_member_community_weekly_page_backend(g,other_viewer,'all',20,null);
  exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'CROSS_GYM_VIEWER';end if;
  denied:=false;
  begin perform public.list_member_community_weekly_page_backend(g,viewer,'longest_streak',20,cursor_value-'version');
  exception when invalid_parameter_value then denied:=true;end;
  if not denied then raise exception 'LEGACY_CURSOR_ACCEPTED';end if;
  if has_function_privilege('anon','public.list_member_community_weekly_page_backend(uuid,uuid,text,integer,jsonb)','execute')
    or has_function_privilege('authenticated','public.list_member_community_weekly_page_backend(uuid,uuid,text,integer,jsonb)','execute')
    or not has_function_privilege('service_role','public.list_member_community_weekly_page_backend(uuid,uuid,text,integer,jsonb)','execute') then raise exception 'COMMUNITY_ACL';end if;
  if (select offers_enabled from private.class_waitlist_policy where singleton) then raise exception 'WAITLIST_ENABLED';end if;
end;$$;
select '0058 OK: weekly winner, 360 members across 18 pages, privacy, tenant, cursor version, ACL, monthly ranking' result;
rollback;
