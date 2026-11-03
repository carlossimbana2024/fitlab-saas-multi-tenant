begin;
set local lock_timeout = '5s';

-- Additive, backend-only read API. No existing consumers or data are changed.
create or replace function private.require_member_aggregate_reader(g uuid, actor uuid)
returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if not exists(select 1 from public.gym_users where id=actor and gym_id=g
    and role='member' and status='active' and account_mode='portal') then
    raise exception 'MEMBER_AGGREGATE_ACCESS_DENIED' using errcode='42501';
  end if;
end;$$;

create or replace function public.get_member_attendance_summary_backend(target_gym_id uuid, actor_member_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare today date; week_start date; month_start date; result jsonb;
begin
  perform private.require_member_aggregate_reader(target_gym_id,actor_member_user_id);
  select (now() at time zone timezone)::date into today from public.gyms where id=target_gym_id;
  week_start:=date_trunc('week',today)::date; month_start:=date_trunc('month',today)::date;
  -- Definition preserved: valid status, across all member branches/memberships.
  -- Historical total has no date cutoff; current week ends today, current month
  -- and chart buckets retain their existing full-period bounds.
  with a as materialized (
    select attendance_date from public.attendances where gym_id=target_gym_id
      and member_user_id=actor_member_user_id and status='valid'
  ), months as (
    select (month_start - make_interval(months=>n))::date d from generate_series(5,0,-1) n
  ), weeks as (
    select week_start - n*7 d from generate_series(7,0,-1) n
  ), mb as (
    select m.d,count(a.attendance_date) n from months m left join a on a.attendance_date>=m.d
      and a.attendance_date<(m.d+interval '1 month')::date group by m.d
  ), wb as (
    select w.d,count(a.attendance_date) n from weeks w left join a on a.attendance_date between w.d and w.d+6 group by w.d
  ) select jsonb_build_object(
    'today',today,'currentWeekStart',week_start,'currentMonthStart',month_start,
    'totalAttendances',(select count(*) from a),
    'currentMonthAttendances',(select count(*) from a where attendance_date>=month_start and attendance_date<(month_start+interval '1 month')::date),
    'currentWeekAttendances',(select count(*) from a where attendance_date between week_start and today),
    'latestAttendanceDate',(select max(attendance_date) from a),
    'hasAttendanceToday',exists(select 1 from a where attendance_date=today),
    'attendanceByMonth',(select jsonb_agg(jsonb_build_object('period',to_char(d,'YYYY-MM'),'count',n) order by d) from mb),
    'attendanceByWeek',(select jsonb_agg(jsonb_build_object('period',d,'count',n) order by d) from wb),
    'averageWeeklyAttendances',(select round(avg(n),1) from wb)
  ) into result;
  return result;
end;$$;

-- Preserve the monthly ranking formula, including null for non-positive gains.
create or replace function private.member_monthly_goal_percent(goal text,target numeric,baseline numeric,current_weight numeric)
returns numeric language sql immutable set search_path=pg_catalog as $$
  with score as (select case
    when goal='lose_weight' and target<baseline then (baseline-current_weight)/(baseline-target)*100
    when goal in ('gain_weight','build_muscle') and target>baseline then (current_weight-baseline)/(target-baseline)*100
    when goal='maintain_weight' and target<>baseline then (abs(baseline-target)-abs(current_weight-target))/abs(baseline-target)*100
  end n) select case when n>0 then round(least(100,n),1) end from score;
$$;

create or replace function public.get_member_community_rankings_backend(target_gym_id uuid,actor_member_user_id uuid,requested_month date default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare today date; first_day date; last_day date; result jsonb;
begin
  perform private.require_member_aggregate_reader(target_gym_id,actor_member_user_id);
  select (now() at time zone timezone)::date into today from public.gyms where id=target_gym_id;
  first_day:=coalesce(requested_month,date_trunc('month',today)::date);
  if first_day<>date_trunc('month',first_day)::date or first_day>today then
    raise exception 'INVALID_COMMUNITY_RANKING_MONTH' using errcode='22023';
  end if;
  last_day:=least(today,(first_day+interval '1 month - 1 day')::date);
  with eligible as materialized (
    select p.full_name name,p.avatar_url,f.* from public.gym_users gu
    join public.member_fitness_profiles f on f.gym_id=gu.gym_id and f.member_user_id=gu.id
    join public.profiles p on p.id=gu.profile_id
    where gu.gym_id=target_gym_id and gu.role='member' and gu.status='active'
      and gu.account_mode='portal' and f.show_in_community
  ), days as materialized (
    select a.member_user_id,a.attendance_date from public.attendances a join eligible e on e.member_user_id=a.member_user_id
    where a.gym_id=target_gym_id and a.status='valid' and a.attendance_date between first_day and last_day
      and (e.show_attendance_count or e.show_streak)
  ), attendance_scores as (
    select member_user_id,count(*)::numeric value from days group by member_user_id
  ), islands as (
    select member_user_id,attendance_date-row_number() over(partition by member_user_id order by attendance_date)::int grp
    from (select distinct member_user_id,attendance_date from days) d
  ), streak_scores as (
    select member_user_id,max(n)::numeric value from (select member_user_id,grp,count(*) n from islands group by member_user_id,grp) x group by member_user_id
  ), weight_scores as (
    select e.member_user_id,private.member_monthly_goal_percent(e.goal_type::text,e.target_weight_kg,b.weight_kg,c.weight_kg) value
    from eligible e
    -- Two indexed endpoints, never a truncated historical array.
    join lateral (
      select weight_kg,measured_on from (
        (select w.weight_kg,w.measured_on,0 priority from public.member_weight_entries w
         where w.gym_id=target_gym_id and w.member_user_id=e.member_user_id and w.measured_on<first_day
         order by w.measured_on desc limit 1)
        union all
        (select w.weight_kg,w.measured_on,1 priority from public.member_weight_entries w
         where w.gym_id=target_gym_id and w.member_user_id=e.member_user_id and w.measured_on between first_day and last_day
         order by w.measured_on asc limit 1)
      ) endpoints order by priority limit 1
    ) b on e.show_weight_progress
    join lateral (
      select w.weight_kg,w.measured_on from public.member_weight_entries w
      where w.gym_id=target_gym_id and w.member_user_id=e.member_user_id and w.measured_on between first_day and last_day
      order by w.measured_on desc limit 1
    ) c on b.measured_on<c.measured_on
  ), scores as (
    select 'attendance' category,e.member_user_id,s.value from eligible e join attendance_scores s using(member_user_id) where e.show_attendance_count
    union all select 'streak',e.member_user_id,s.value from eligible e join streak_scores s using(member_user_id) where e.show_streak
    union all select 'progress',member_user_id,value from weight_scores
  ), ranked as (
    select s.*,e.name,e.avatar_url,e.show_profile_photo,e.show_goal,e.goal_type,
      row_number() over(partition by category order by value desc,e.name collate "C",s.member_user_id) position
    from scores s join eligible e using(member_user_id) where value>0
  ) select jsonb_build_object('from',first_day,'to',last_day,'categories',
    (select jsonb_object_agg(category,entries) from (
      select cat.category,coalesce(jsonb_agg(jsonb_build_object('memberUserId',r.member_user_id,'name',r.name,
        'value',r.value,'position',r.position,'avatarPath',case when r.show_profile_photo then r.avatar_url end,
        'goalType',case when r.show_goal then r.goal_type end) order by r.position) filter(where r.position is not null),'[]'::jsonb) entries
      from (values('attendance'),('streak'),('progress')) cat(category)
      left join ranked r on r.category=cat.category and r.position<=3 group by cat.category
    ) x)) into result;
  return result;
end;$$;

-- Community uses its existing all-time goal definition, NOT the monthly formula.
create or replace function private.member_community_goal_percent(goal text,target numeric,baseline numeric,current_weight numeric)
returns numeric language sql immutable set search_path=pg_catalog as $$
  select case when target is null or current_weight is null
    or not (goal='maintain_weight' or (goal='lose_weight' and target<baseline)
      or (goal in ('gain_weight','build_muscle') and target>baseline)) then null else
    case when goal='maintain_weight' and target=baseline then 100
    else greatest(0,least(100,round(case
      when goal='lose_weight' and target<baseline then (current_weight-baseline)/(target-baseline)*100
      when goal in ('gain_weight','build_muscle') and target>baseline then (current_weight-baseline)/(target-baseline)*100
      when goal='maintain_weight' and target<>baseline then (1-abs(current_weight-target)/abs(baseline-target))*100
      end,1))) end end;
$$;

create or replace function public.list_member_community_page_backend(target_gym_id uuid,actor_member_user_id uuid,
  requested_filter text default 'all',page_size integer default 20,after_cursor jsonb default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare today date; viewer_goal text; result jsonb; viewer_id uuid:=actor_member_user_id;
begin
  perform private.require_member_aggregate_reader(target_gym_id,actor_member_user_id);
  if requested_filter is null or requested_filter not in ('all','similar_goal','consistent','new','longest_streak','featured','progress')
    or page_size is null or page_size<1 or page_size>50 then raise exception 'INVALID_COMMUNITY_PAGE' using errcode='22023';end if;
  select (now() at time zone timezone)::date into today from public.gyms where id=target_gym_id;
  select goal_type::text into viewer_goal from public.member_fitness_profiles where gym_id=target_gym_id and member_user_id=actor_member_user_id;
  if after_cursor is not null and (jsonb_typeof(after_cursor)<>'object'
    or after_cursor->>'filter' is distinct from requested_filter
    or after_cursor->>'gym' is distinct from target_gym_id::text
    or after_cursor->>'viewer' is distinct from actor_member_user_id::text
    or after_cursor->>'date' is distinct from today::text
    or jsonb_typeof(after_cursor->'score') is distinct from 'number'
    or jsonb_typeof(after_cursor->'name') is distinct from 'string'
    or jsonb_typeof(after_cursor->'id') is distinct from 'string') then
    raise exception 'INVALID_COMMUNITY_CURSOR' using errcode='22023';end if;
  with eligible as materialized (
    select gu.id,p.full_name name,gu.joined_at,
      case when f.show_profile_photo then p.avatar_url end avatar_path,
      case when f.show_goal then f.goal_type::text end goal_type,
      coalesce(sp.bio,f.public_message) public_message,
      case when f.show_streak then coalesce(s.current_streak,0) end current_streak,
      case when f.show_streak then coalesce(s.longest_streak,0) end longest_streak,
      f.show_attendance_count,f.show_weight_progress,f.goal_type::text raw_goal,f.weight_kg,f.target_weight_kg
    from public.gym_users gu join public.profiles p on p.id=gu.profile_id
    join public.member_fitness_profiles f on f.gym_id=gu.gym_id and f.member_user_id=gu.id
    left join public.user_streaks s on s.gym_id=gu.gym_id and s.member_user_id=gu.id
    left join public.member_social_profiles sp on sp.gym_id=gu.gym_id and sp.member_user_id=gu.id
    where gu.gym_id=target_gym_id and gu.id<>actor_member_user_id and gu.role='member' and gu.status='active'
      and gu.account_mode='portal' and f.show_in_community
      and (requested_filter<>'similar_goal' or (f.show_goal and f.goal_type::text=viewer_goal))
  ), ordering_metrics as (
    select e.*,
      case when requested_filter='consistent' and e.show_attendance_count then (select count(*) from public.attendances a
        where a.gym_id=target_gym_id and a.member_user_id=e.id and a.status='valid'
          and a.attendance_date between date_trunc('month',today)::date and today) end monthly,
      case when requested_filter='progress' and e.show_weight_progress then private.member_community_goal_percent(e.raw_goal,e.target_weight_kg,e.weight_kg,
        coalesce((select w.weight_kg from public.member_weight_entries w where w.gym_id=target_gym_id and w.member_user_id=e.id order by w.measured_on desc limit 1),e.weight_kg)) end progress
    from eligible e
  ), scored as (
    select m.*,case requested_filter
      when 'consistent' then coalesce(monthly,-1)
      when 'longest_streak' then coalesce(longest_streak,-1)
      when 'new' then coalesce(extract(epoch from joined_at),-1)
      when 'progress' then coalesce(progress,-1)
      when 'featured' then (case when coalesce(public_message,'')<>'' then 1 else 0 end
        +case when goal_type is not null then 1 else 0 end+case when coalesce(avatar_path,'')<>'' then 1 else 0 end)
      else 0 end score from ordering_metrics m
  ), windowed as materialized (
    select * from scored where after_cursor is null or
      (-score,name collate "C",id) > (-(after_cursor->>'score')::numeric,(after_cursor->>'name') collate "C",(after_cursor->>'id')::uuid)
    order by score desc,name collate "C",id limit page_size+1
  ), page as materialized (
    select * from windowed order by score desc,name collate "C",id limit page_size
  ), enriched as (
    select p.score,p.name,p.id,jsonb_build_object('id',p.id,'name',p.name,'avatarPath',p.avatar_path,
      'goalType',p.goal_type,'publicMessage',p.public_message,'joinedAt',p.joined_at,
      'currentStreak',p.current_streak,'longestStreak',p.longest_streak,
      'monthlyAttendances',case when p.show_attendance_count then coalesce(p.monthly,(select count(*) from public.attendances a
        where a.gym_id=target_gym_id and a.member_user_id=p.id and a.status='valid' and a.attendance_date between date_trunc('month',today)::date and today)) end,
      'progressPercent',case when p.show_weight_progress then coalesce(p.progress,private.member_community_goal_percent(p.raw_goal,p.target_weight_kg,p.weight_kg,
        coalesce((select w.weight_kg from public.member_weight_entries w where w.gym_id=target_gym_id and w.member_user_id=p.id order by w.measured_on desc limit 1),p.weight_kg))) end,
      'reactions',(select jsonb_build_object('like',count(*) filter(where reaction_type='like'),'love',count(*) filter(where reaction_type='love'),
        'mine',max(reaction_type) filter(where r.actor_member_user_id=viewer_id))
        from public.member_community_reactions r
        where r.gym_id=target_gym_id and r.target_member_user_id=p.id)) item
    from page p
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(item order by score desc,name collate "C",id) from enriched),'[]'::jsonb),
    'hasMore',(select count(*)>page_size from windowed),'nextCursor',case when (select count(*)>page_size from windowed) then
      (select jsonb_build_object('filter',requested_filter,'gym',target_gym_id,'viewer',actor_member_user_id,'date',today,
        'score',score,'name',name,'id',id) from page order by score asc,name collate "C" desc,id desc limit 1) end) into result;
  return result;
end;$$;

-- Existing unique valid attendance/member/date and weight/member/date indexes,
-- 0036 ranking indexes and reaction target index cover the access paths.
-- No redundant indexes added.
revoke all on function private.require_member_aggregate_reader(uuid,uuid),
  private.member_monthly_goal_percent(text,numeric,numeric,numeric),
  private.member_community_goal_percent(text,numeric,numeric,numeric)
  from public,anon,authenticated,service_role;
revoke all on function public.get_member_attendance_summary_backend(uuid,uuid),
  public.get_member_community_rankings_backend(uuid,uuid,date),
  public.list_member_community_page_backend(uuid,uuid,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.get_member_attendance_summary_backend(uuid,uuid),
  public.get_member_community_rankings_backend(uuid,uuid,date),
  public.list_member_community_page_backend(uuid,uuid,text,integer,jsonb) to service_role;
commit;
