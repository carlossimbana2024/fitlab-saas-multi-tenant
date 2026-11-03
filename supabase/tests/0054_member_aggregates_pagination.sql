-- LOCAL ONLY: execute through member-aggregates-sql-check.mjs, NEVER in Supabase.
-- Historical synthetic data bypasses write-time triggers ONLY while seeding the
-- isolated database. Read RPCs run with normal triggers/permissions restored.
begin;
do $$begin
  if current_setting('fitlab.isolated_aggregate_test',true) is distinct from 'true' then
    raise exception 'LOCAL_RUNNER_REQUIRED';
  end if;
end;$$;
create temporary table aggregate_fixture(n integer primary key, id uuid, profile uuid, membership uuid);
insert into aggregate_fixture select n,gen_random_uuid(),gen_random_uuid(),gen_random_uuid() from generate_series(0,363) n;
create temporary table aggregate_context as select gen_random_uuid() g,gen_random_uuid() other_g,gen_random_uuid() location,gen_random_uuid() plan;
set local session_replication_role=replica;
insert into auth.users(id,email) select profile,profile||'@aggregate.invalid' from aggregate_fixture;
insert into public.profiles(id,full_name) select profile,case when n=360 then 'ZZ Winner' else 'Member '||lpad(n::text,4,'0') end from aggregate_fixture;
update public.profiles set full_name='Equal name' where id in(select profile from aggregate_fixture where n in(1,2));
insert into public.gyms(id,name,slug) select g,'Aggregate gym','aggregate-'||g from aggregate_context
union all select other_g,'Other gym','aggregate-'||other_g from aggregate_context;
insert into public.gym_locations(id,gym_id,name) select location,g,'Branch' from aggregate_context;
insert into public.gym_users(id,gym_id,profile_id,role,status,account_mode,joined_at)
select f.id,case when n=363 then c.other_g else c.g end,profile,'member','active','portal','2020-01-01'::timestamptz
from aggregate_fixture f cross join aggregate_context c;
insert into public.member_fitness_profiles(gym_id,member_user_id,weight_kg,height_cm,goal_type,target_weight_kg,
 show_in_community,show_attendance_count,show_streak,show_weight_progress,show_goal)
select case when n=363 then other_g else g end,id,90,175,'lose_weight',70,n<>361,true,true,true,true
from aggregate_fixture cross join aggregate_context;
update public.gym_users set status='inactive' where id=(select id from aggregate_fixture where n=362);
insert into public.plans(id,gym_id,name,price,duration_unit,duration_value,attendance_mode)
select plan,g,'Plan',30,'months',1,'daily' from aggregate_context;
insert into public.memberships(id,gym_id,member_user_id,plan_id,status,price_at_purchase,attendance_mode_snapshot,created_by)
select membership,g,id,plan,'active',30,'daily',id from aggregate_fixture cross join aggregate_context where n<>363;
-- 360 candidates * 28 days = 10080 rows, then a 31-day winner outside first 250.
insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,checked_in_at,source)
select g,location,id,membership,'2020-01-01'::date+d,('2020-01-01'::date+d)::timestamptz,'system'
from aggregate_fixture cross join aggregate_context cross join generate_series(0,30) d
where n between 1 and 360 and (d<28 or n=360);
-- Canonical totals specifically exceed both former limits.
insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,checked_in_at,source)
select g,location,id,membership,'2010-01-01'::date+d,('2010-01-01'::date+d)::timestamptz,'system'
from aggregate_fixture cross join aggregate_context cross join generate_series(0,200) d where n=0;
insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,checked_in_at,source)
select g,location,id,membership,'2000-01-01'::date+d,('2000-01-01'::date+d)::timestamptz,'system'
from aggregate_fixture cross join aggregate_context cross join generate_series(0,2000) d where n=361;
insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,source,
 status,voided_at,voided_by,void_reason)
select g,location,id,membership,'2011-01-01','system','voided',now(),id,'Excluded fixture'
from aggregate_fixture cross join aggregate_context where n=0;
insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,source)
select g,location,id,membership,(now() at time zone 'America/Guayaquil')::date,'system'
from aggregate_fixture cross join aggregate_context where n=359;
insert into public.member_weight_entries(gym_id,member_user_id,weight_kg,measured_on)
select g,id,case when d=0 then 90 when n=360 then 70 else 89 end,'2019-12-31'::date+d
from aggregate_fixture cross join aggregate_context cross join (values(0),(31)) days(d) where n between 1 and 362;
set local session_replication_role=origin;
analyze public.attendances;
analyze public.gym_users;
analyze public.member_fitness_profiles;
analyze public.member_weight_entries;

do $$declare g uuid;other_g uuid;viewer uuid;winner uuid;private_member uuid;r jsonb;p jsonb;cursor_value jsonb;
 ids uuid[];entry jsonb;filter_value text;f record;denied boolean;start_time timestamptz:=clock_timestamp();
begin
 select c.g,c.other_g into g,other_g from aggregate_context c;
 select id into viewer from aggregate_fixture where n=0;
 select id into winner from aggregate_fixture where n=360;
 select id into private_member from aggregate_fixture where n=361;
 r:=public.get_member_attendance_summary_backend(g,viewer);
 if (r->>'totalAttendances')::int<>201 or (r->>'currentMonthAttendances')::int<>0
   or jsonb_array_length(r->'attendanceByMonth')<>6 or jsonb_array_length(r->'attendanceByWeek')<>8 then raise exception 'SUMMARY_201_OR_PERIODS';end if;
 if (public.get_member_attendance_summary_backend(g,private_member)->>'totalAttendances')::int<>2001 then raise exception 'SUMMARY_2001';end if;
 r:=public.get_member_attendance_summary_backend(g,(select id from aggregate_fixture where n=359));
 if (r->>'currentMonthAttendances')::int<>1 or (r->>'currentWeekAttendances')::int<>1
   or not (r->>'hasAttendanceToday')::boolean or (r#>>'{attendanceByMonth,5,count}')::int<>1
   or (r#>>'{attendanceByWeek,7,count}')::int<>1 then raise exception 'CURRENT_PERIODS';end if;
 r:=public.get_member_community_rankings_backend(g,viewer,'2020-01-01');
 foreach filter_value in array array['attendance','streak','progress'] loop
   if r#>>array['categories',filter_value,'0','memberUserId']<>winner::text then raise exception 'WINNER_OUTSIDE_250: %',r;end if;
 end loop;
 if (r#>>'{categories,attendance,0,value}')::int<>31 or (r#>>'{categories,progress,0,value}')::numeric<>100 then raise exception 'RANK_VALUES';end if;
 if r<>public.get_member_community_rankings_backend(g,viewer,'2020-01-01') then raise exception 'UNSTABLE_RANKING';end if;
 foreach filter_value in array array['all','similar_goal','consistent','new','longest_streak','featured','progress'] loop
   cursor_value:=null;ids:='{}';
   loop
     p:=public.list_member_community_page_backend(g,viewer,filter_value,20,cursor_value);
     if jsonb_array_length(p->'items')>20 then raise exception 'PAGE_SIZE';end if;
     for entry in select value from jsonb_array_elements(p->'items') loop
       if (entry->>'id')::uuid=any(ids) then raise exception 'DUPLICATE_PAGE_MEMBER';end if;
       ids:=array_append(ids,(entry->>'id')::uuid);
     end loop;
     exit when not (p->>'hasMore')::boolean;
     cursor_value:=p->'nextCursor';
     if cardinality(ids)>400 then raise exception 'PAGING_LOOP';end if;
   end loop;
   if cardinality(ids)<>360 or private_member=any(ids) then raise exception 'ELIGIBLE_PAGINATION: % %',filter_value,cardinality(ids);end if;
 end loop;
 -- Individual metric opt-out must remove only that metric, not their profile.
 update public.member_fitness_profiles set show_attendance_count=false,show_weight_progress=false where member_user_id=winner;
 r:=public.get_member_community_rankings_backend(g,viewer,'2020-01-01');
 if r#>>'{categories,attendance,0,memberUserId}'=winner::text or r#>>'{categories,progress,0,memberUserId}'=winner::text
   or r#>>'{categories,streak,0,memberUserId}'<>winner::text then raise exception 'METRIC_CONSENT';end if;
 p:=public.list_member_community_page_backend(g,viewer,'all',20,null);
 denied:=false;
 begin perform public.list_member_community_page_backend(g,viewer,'new',20,p->'nextCursor');
 exception when invalid_parameter_value then denied:=true;end;
 if not denied then raise exception 'CURSOR_FILTER_NOT_BOUND';end if;
 denied:=false;
 begin perform public.get_member_attendance_summary_backend(other_g,viewer);
 exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'CROSS_TENANT';end if;
 denied:=false;
 begin perform public.get_member_attendance_summary_backend(g,(select id from aggregate_fixture where n=362));
 exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'INACTIVE_READER';end if;
 denied:=false;
 begin perform public.list_member_community_page_backend(g,viewer,'all',51,null);
 exception when invalid_parameter_value then denied:=true;end;
 if not denied then raise exception 'UNBOUNDED_PAGE';end if;
 if private.member_monthly_goal_percent('maintain_weight',80,80,80) is not null
   or private.member_community_goal_percent('maintain_weight',80,80,80)<>100
   or private.member_monthly_goal_percent('gain_weight',100,80,90)<>50
   or private.member_monthly_goal_percent('lose_weight',70,90,95) is not null then raise exception 'EXISTING_WEIGHT_FORMULAS';end if;
 for f in select oid,proname,prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace
   and proname in ('get_member_attendance_summary_backend','get_member_community_rankings_backend','list_member_community_page_backend') loop
   if has_function_privilege('anon',f.oid,'EXECUTE') or has_function_privilege('authenticated',f.oid,'EXECUTE')
     or not has_function_privilege('service_role',f.oid,'EXECUTE') or not f.prosecdef
     or not ('search_path=pg_catalog, public'=any(f.proconfig)) then raise exception 'RPC_PRIVILEGES: %',f.proname;end if;
 end loop;
 raise notice 'Assertions complete in %',clock_timestamp()-start_time;
end;$$;
select '0054 OK: 201/2001, >10000 attendance rows, 360 candidates, all 7 filters, all 3 winners, privacy, tenants, cursor and ACL' result;
rollback;
