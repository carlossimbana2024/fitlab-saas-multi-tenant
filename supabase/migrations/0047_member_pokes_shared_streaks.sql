begin;
set local lock_timeout='5s';
create table public.member_poke_preferences(gym_id uuid not null references public.gyms(id),member_user_id uuid primary key references public.gym_users(id),allow_pokes boolean not null default false);
create table public.member_pokes(gym_id uuid not null references public.gyms(id),actor uuid not null references public.gym_users(id),target uuid not null references public.gym_users(id),sent_at timestamptz not null default now(),check(actor<>target),primary key(gym_id,actor,target));
create table public.member_shared_streaks(
 id uuid primary key default gen_random_uuid(),gym_id uuid not null references public.gyms(id),
 member_a uuid not null references public.gym_users(id),member_b uuid not null references public.gym_users(id),
 invited_by uuid not null references public.gym_users(id),status text not null check(status in('pending','active','rejected','cancelled','ended')),
 target_a integer not null check(target_a between 1 and 7),target_b integer not null check(target_b between 1 and 7),
 starts_on date,updated_at timestamptz not null default now(),check(member_a<member_b),check(invited_by in(member_a,member_b)),unique(gym_id,member_a,member_b));
alter table public.member_poke_preferences enable row level security;
alter table public.member_pokes enable row level security;
alter table public.member_shared_streaks enable row level security;
revoke all on public.member_poke_preferences,public.member_pokes,public.member_shared_streaks from public,anon,authenticated;
grant select,insert,update,delete on public.member_poke_preferences,public.member_pokes,public.member_shared_streaks to service_role;
create function public.member_training_social_backend(g uuid,actor uuid,target uuid,action text) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.member_shared_streaks;actor_record public.gym_users;today date;recipient uuid;title text;actor_name text; ta integer;tb integer;
begin
 perform 1 from public.gym_users where gym_id=g and id in(actor,target) order by id for update;
 select * into actor_record from public.gym_users where id=actor and gym_id=g and role='member' and status='active' and account_mode='portal';
 if actor_record.id is null then raise exception 'TRAINING_MEMBER_REQUIRED';end if;
 if action in('allow','disable') then
  insert into public.member_poke_preferences values(g,actor,action='allow') on conflict(member_user_id) do update set allow_pokes=excluded.allow_pokes;return;
 end if;
 if actor=target or action not in('poke','invite','accept','reject','cancel','end') then raise exception 'TRAINING_ACTION_INVALID';end if;
 select * into r from public.member_shared_streaks where gym_id=g and member_a=least(actor,target) and member_b=greatest(actor,target) for update;
 if action in('poke','invite','accept') then
  if not exists(select 1 from public.member_friendships where gym_id=g and member_a=least(actor,target) and member_b=greatest(actor,target) and status='accepted')
   or (select count(*) from public.gym_users where gym_id=g and id in(actor,target) and role='member' and status='active' and account_mode='portal')<>2
   or (select count(*) from public.member_fitness_profiles where gym_id=g and member_user_id in(actor,target) and show_in_community)<>2
   or (select count(*) from public.member_poke_preferences where gym_id=g and member_user_id in(actor,target) and allow_pokes)<>2
  then raise exception 'TRAINING_PRIVACY_REQUIRED';end if;
 end if;
 select (now() at time zone timezone)::date into today from public.gyms where id=g;
 if action='poke' then
  if exists(select 1 from public.member_pokes where gym_id=g and member_pokes.actor=member_training_social_backend.actor and member_pokes.target=member_training_social_backend.target and sent_at>now()-interval '12 hours') then raise exception 'POKE_COOLDOWN';end if;
  insert into public.member_pokes values(g,actor,target,now()) on conflict on constraint member_pokes_pkey do update set sent_at=now();title:='Te dieron un toque 👊';recipient:=target;
 elsif action='invite' then
  if r.status in('pending','active') then raise exception 'SHARED_STREAK_EXISTS';end if;
  if r.id is not null and r.updated_at>now()-interval '24 hours' then raise exception 'SHARED_STREAK_COOLDOWN';end if;
  if not exists(select 1 from public.member_pokes where gym_id=g and member_pokes.actor=member_training_social_backend.actor and member_pokes.target=member_training_social_backend.target and sent_at>now()-interval '24 hours') then raise exception 'SHARED_STREAK_POKE_REQUIRED';end if;
  select least(training_frequency_per_week,7) into ta from public.member_fitness_profiles where gym_id=g and member_user_id=least(actor,target);
  select least(training_frequency_per_week,7) into tb from public.member_fitness_profiles where gym_id=g and member_user_id=greatest(actor,target);
  insert into public.member_shared_streaks(gym_id,member_a,member_b,invited_by,status,target_a,target_b)
  values(g,least(actor,target),greatest(actor,target),actor,'pending',ta,tb)
  on conflict(gym_id,member_a,member_b) do update set invited_by=actor,status='pending',target_a=ta,target_b=tb,starts_on=null,updated_at=now();title:='Invitación a racha compartida';recipient:=target;
 elsif action in('accept','reject') then
  if r.id is null or r.status<>'pending' or r.invited_by=actor then raise exception 'SHARED_STREAK_STATE_INVALID';end if;
  update public.member_shared_streaks set status=case when action='accept' then 'active' else 'rejected' end,
   starts_on=case when action='accept' then date_trunc('week',today::timestamp)::date+7 else null end,updated_at=now() where id=r.id;
  if action='accept' then title:='Racha compartida aceptada';recipient:=target;end if;
 elsif action='cancel' then
  if r.id is null or r.status<>'pending' or r.invited_by<>actor then raise exception 'SHARED_STREAK_STATE_INVALID';end if;
  update public.member_shared_streaks set status='cancelled',updated_at=now() where id=r.id;
 elsif action='end' then
  if r.id is null or r.status<>'active' then raise exception 'SHARED_STREAK_STATE_INVALID';end if;
  update public.member_shared_streaks set status='ended',updated_at=now() where id=r.id;
 end if;
 if recipient is not null then
  select full_name into actor_name from public.profiles where id=actor_record.profile_id;
  insert into public.loyalty_notifications(gym_id,member_user_id,event_key,kind,title,body)
  values(g,recipient,'training:'||gen_random_uuid(),'member_training',title,coalesce(actor_name,'Tu amigo')||case when action='poke' then ' te dio un toque. ¿Entrenan juntos? Revisa su perfil.' when action='accept' then ' aceptó la racha. Comenzará el lunes siguiente. Revisa Rachas compartidas en tu perfil.' else ' te invita a entrenar con constancia. Revisa Rachas compartidas en tu perfil.' end);
 end if;
 insert into public.audit_logs(gym_id,actor_profile_id,actor_gym_user_id,action,entity_type,entity_id,after_data)
 values(g,actor_record.profile_id,actor,'member.training.'||action,'member_training',target,jsonb_build_object('action',action));
end;$$;
create function public.member_shared_streak_progress_backend(g uuid,actor uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;today date;
begin
 if not exists(select 1 from public.gym_users where gym_id=g and id=actor and role='member' and status='active' and account_mode='portal') then raise exception 'TRAINING_MEMBER_REQUIRED';end if;
 select (now() at time zone timezone)::date into today from public.gyms where id=g;
 with r as(select s.*,
  exists(select 1 from public.member_friendships f where f.gym_id=g and f.member_a=s.member_a and f.member_b=s.member_b and f.status='accepted')
  and (select count(*) from public.gym_users u where u.gym_id=g and u.id in(s.member_a,s.member_b) and u.status='active' and u.role='member' and u.account_mode='portal')=2
  and (select count(*) from public.member_fitness_profiles p where p.gym_id=g and p.member_user_id in(s.member_a,s.member_b) and p.show_in_community)=2
  and (select count(*) from public.member_poke_preferences p where p.gym_id=g and p.member_user_id in(s.member_a,s.member_b) and p.allow_pokes)=2 as permitted
  from public.member_shared_streaks s where gym_id=g and actor in(member_a,member_b) and status in('active','pending')),
 weeks as(select r.id,d::date week_start,
  (select count(distinct attendance_date) from public.attendances where gym_id=g and member_user_id=r.member_a and status='valid' and source<>'extra_class' and class_booking_id is null and attendance_date>=d::date and attendance_date<d::date+7 and attendance_date<=today) a,
  (select count(distinct attendance_date) from public.attendances where gym_id=g and member_user_id=r.member_b and status='valid' and source<>'extra_class' and class_booking_id is null and attendance_date>=d::date and attendance_date<d::date+7 and attendance_date<=today) b,
  r.target_a,r.target_b
  from r cross join lateral generate_series(r.starts_on::timestamp,date_trunc('week',today::timestamp),interval '7 days') d where r.status='active' and r.permitted),
 complete as(select *,a>=target_a and b>=target_b met from weeks),
 groups as(select *,count(*) filter(where not met) over(partition by id order by week_start) grp from complete where week_start+6<today or met),
 runs as(select id,grp,count(*) filter(where met) len from groups group by id,grp)
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'targetId',case when actor=r.member_a then r.member_b else r.member_a end,'status',r.status,'direction',case when r.invited_by=actor then 'outgoing' else 'incoming' end,'startsOn',r.starts_on,
 'myTarget',case when actor=r.member_a then r.target_a else r.target_b end,'friendTarget',case when actor=r.member_a then r.target_b else r.target_a end,
 'myVisits',coalesce((select case when actor=r.member_a then a else b end from complete where id=r.id order by week_start desc limit 1),0),
 'friendVisits',coalesce((select case when actor=r.member_a then b else a end from complete where id=r.id order by week_start desc limit 1),0),
 'canContinue',r.permitted,'currentWeeks',coalesce((select len from runs where id=r.id order by grp desc limit 1),0),'bestWeeks',coalesce((select max(len) from runs where id=r.id),0))),'[]'::jsonb) into result from r;
 return result;
end;$$;
revoke all on function public.member_training_social_backend(uuid,uuid,uuid,text),public.member_shared_streak_progress_backend(uuid,uuid) from public,anon,authenticated;
grant execute on function public.member_training_social_backend(uuid,uuid,uuid,text),public.member_shared_streak_progress_backend(uuid,uuid) to service_role;
commit;
