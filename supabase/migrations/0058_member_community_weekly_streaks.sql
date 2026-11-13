begin;
set local lock_timeout = '5s';

-- Additive FIT-MEMBER-020 API. 0055 cannot order by weekly best before pagination.
-- Keep the old RPC available during deployment and leave monthly rankings untouched.
create function public.list_member_community_weekly_page_backend(target_gym_id uuid,actor_member_user_id uuid,
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
    or after_cursor->>'version' is distinct from 'weekly-v1'
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
      f.show_streak,
      f.show_attendance_count,f.show_weight_progress,f.goal_type::text raw_goal,f.show_goal
    from public.gym_users gu join public.profiles p on p.id=gu.profile_id
    join public.member_fitness_profiles f on f.gym_id=gu.gym_id and f.member_user_id=gu.id
    left join public.member_social_profiles sp on sp.gym_id=gu.gym_id and sp.member_user_id=gu.id
    where gu.gym_id=target_gym_id and gu.id<>actor_member_user_id and gu.role='member' and gu.status='active'
      and gu.account_mode='portal' and f.show_in_community
      and (requested_filter<>'similar_goal' or (f.show_goal and f.goal_type::text=viewer_goal))
  ), ordering_metrics as materialized (
    select e.*,
      case when requested_filter='longest_streak' and e.show_streak
        then private.member_personal_streaks(target_gym_id,e.id,now()) end weekly_metrics,
      case when requested_filter='consistent' and e.show_attendance_count then (select count(*) from public.attendances a
        where a.gym_id=target_gym_id and a.member_user_id=e.id and a.status='valid'
          and a.attendance_date between date_trunc('month',today)::date and today) end monthly,
      case when requested_filter='progress' and e.show_weight_progress then (private.member_historical_weight_goal(target_gym_id,e.id)->>'progressPercent')::numeric end progress
    from eligible e
  ), scored as (
    select m.*,case requested_filter
      when 'consistent' then coalesce(monthly,-1)
      when 'longest_streak' then coalesce((weekly_metrics->>'weeklyBestStreak')::integer,-1)
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
      'weeklyStreak',case when p.show_streak then jsonb_build_object(
        'current', metrics.value->'weeklyCurrentStreak','best',metrics.value->'weeklyBestStreak',
        'status',metrics.value->'weeklyStatus') end,
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
    from page p cross join lateral (
      select case when not p.show_streak then null
        when requested_filter='longest_streak' then p.weekly_metrics
        else private.member_personal_streaks(target_gym_id,p.id,now()) end value
      offset 0
    ) metrics
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(item order by score desc,name collate "C",id) from enriched),'[]'::jsonb),
    'hasMore',(select count(*)>page_size from windowed),'nextCursor',case when (select count(*)>page_size from windowed) then
      (select jsonb_build_object('version','weekly-v1','filter',requested_filter,'gym',target_gym_id,'viewer',actor_member_user_id,'date',today,
        'score',score,'name',name,'id',id) from page order by score asc,name collate "C" desc,id desc limit 1) end) into result;
  return result;
end;$$;

revoke all on function public.list_member_community_weekly_page_backend(uuid,uuid,text,integer,jsonb)
  from public,anon,authenticated;
grant execute on function public.list_member_community_weekly_page_backend(uuid,uuid,text,integer,jsonb) to service_role;
commit;
