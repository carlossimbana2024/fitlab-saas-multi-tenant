begin;
set local lock_timeout = '5s';

-- FIT-MEMBER-010. No data rewrite, no rollout activation, no changes to 0054.
-- One SQL definition shared by historical Community and monthly rankings.
create or replace function private.member_weight_goal_metric(goal text,target numeric,baseline numeric,current_weight numeric)
returns jsonb language sql immutable set search_path=pg_catalog as $$
  with valid as (
    select baseline between 20 and 500 as valid_baseline,
      target between 20 and 500 and current_weight between 20 and 500 as valid_current_target
  ), score as (
    select case when valid_baseline and valid_current_target then case
      when goal='lose_weight' and target<baseline then (baseline-current_weight)/(baseline-target)*100
      when goal in ('gain_weight','build_muscle') and target>baseline then (current_weight-baseline)/(target-baseline)*100
    end end n, valid_current_target from valid
  )
  select jsonb_build_object(
    'progressPercent',case when n is not null then round(greatest(0,least(100,n)),1) end,
    'maintenance',case when goal='maintain_weight' and valid_current_target then jsonb_build_object(
      'currentWeightKg',current_weight,'targetWeightKg',target,'differenceKg',current_weight-target
    ) end
  ) from score;
$$;

-- Signatures retained for 0054 callers. Maintenance is never a percentage.
create or replace function private.member_community_goal_percent(goal text,target numeric,baseline numeric,current_weight numeric)
returns numeric language sql immutable set search_path=pg_catalog as $$
  select (private.member_weight_goal_metric(goal,target,baseline,current_weight)->>'progressPercent')::numeric;
$$;

create or replace function private.member_monthly_goal_percent(goal text,target numeric,baseline numeric,current_weight numeric)
returns numeric language sql immutable set search_path=pg_catalog as $$
  select case when n>0 then n end from
    (select private.member_community_goal_percent(goal,target,baseline,current_weight) n) s;
$$;

-- Private and tenant-scoped. The editable survey weight is NEVER a baseline.
-- Existing weight constraints + unique member/date make these endpoints valid/deterministic.
-- No change to the personal API's 500-row read (FIT-MEMBER-011 remains pending).
create or replace function private.member_historical_weight_goal(g uuid,member_id uuid)
returns jsonb language sql stable set search_path=pg_catalog,public as $$
  select private.member_weight_goal_metric(f.goal_type::text,f.target_weight_kg,
    (select w.weight_kg from public.member_weight_entries w where w.gym_id=g and w.member_user_id=member_id order by w.measured_on asc limit 1),
    (select w.weight_kg from public.member_weight_entries w where w.gym_id=g and w.member_user_id=member_id order by w.measured_on desc limit 1))
  from public.member_fitness_profiles f where f.gym_id=g and f.member_user_id=member_id;
$$;

-- Ranking RPC is intentionally NOT replaced: preserves monthly endpoints, complete
-- population, positive scores, privacy, ties and independent attendance/streak categories.
-- Its existing monthly helper now delegates to the canonical metric above.

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
      f.show_attendance_count,f.show_weight_progress,f.goal_type::text raw_goal,f.show_goal
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
      case when requested_filter='progress' and e.show_weight_progress then (private.member_historical_weight_goal(target_gym_id,e.id)->>'progressPercent')::numeric end progress
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
      'progressPercent',case when p.show_weight_progress then coalesce(p.progress,(private.member_historical_weight_goal(target_gym_id,p.id)->>'progressPercent')::numeric) end,
      -- Absolute maintenance weights also disclose the goal: require both consents.
      'weightMaintenance',case when p.show_weight_progress and p.show_goal and p.raw_goal='maintain_weight'
        then private.member_historical_weight_goal(target_gym_id,p.id)->'maintenance' end,
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


revoke all on function private.member_weight_goal_metric(text,numeric,numeric,numeric),
  private.member_historical_weight_goal(uuid,uuid),
  private.member_monthly_goal_percent(text,numeric,numeric,numeric),
  private.member_community_goal_percent(text,numeric,numeric,numeric)
  from public,anon,authenticated,service_role;
revoke all on function public.list_member_community_page_backend(uuid,uuid,text,integer,jsonb)
  from public,anon,authenticated;
grant execute on function public.list_member_community_page_backend(uuid,uuid,text,integer,jsonb) to service_role;
commit;

