begin;
set local lock_timeout='5s';
create table public.member_friend_preferences (
 gym_id uuid not null references public.gyms(id) on delete cascade,
 member_user_id uuid primary key references public.gym_users(id) on delete cascade,
 allow_requests boolean not null default false
);
create table public.member_friendships (
 id uuid primary key default gen_random_uuid(),
 gym_id uuid not null references public.gyms(id) on delete cascade,
 member_a uuid not null references public.gym_users(id) on delete cascade,
 member_b uuid not null references public.gym_users(id) on delete cascade,
 requested_by uuid not null references public.gym_users(id),
 status text not null check(status in ('pending','accepted','rejected','cancelled','removed')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(member_a<member_b),check(requested_by in (member_a,member_b)),unique(gym_id,member_a,member_b)
);
create index member_friendships_b_idx on public.member_friendships(gym_id,member_b,status);
alter table public.member_friend_preferences enable row level security;
alter table public.member_friendships enable row level security;
revoke all on public.member_friend_preferences,public.member_friendships from public,anon,authenticated;
grant select,insert,update,delete on public.member_friend_preferences,public.member_friendships to service_role;

create function public.set_member_friend_preferences_backend(g uuid,actor uuid,allow_requests boolean)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform 1 from public.gym_users where id=actor and gym_id=g for update;
 if not exists(select 1 from public.gym_users where id=actor and gym_id=g and role='member' and status='active' and account_mode='portal') then raise exception 'FRIEND_MEMBER_REQUIRED';end if;
 insert into public.member_friend_preferences(gym_id,member_user_id,allow_requests) values(g,actor,allow_requests)
 on conflict(member_user_id) do update set allow_requests=excluded.allow_requests;
end;$$;

create function public.change_member_friendship_backend(g uuid,actor uuid,target uuid,action text)
returns public.member_friendships language plpgsql security definer set search_path=pg_catalog,public as $$
declare result public.member_friendships; actor_record public.gym_users; receiver uuid; actor_name text; event text;
begin
 if actor=target then raise exception 'FRIEND_SELF_NOT_ALLOWED';end if;
 if action not in ('request','accept','reject','cancel','remove') then raise exception 'FRIEND_ACTION_INVALID';end if;
 -- Stable lock order serializes both directions and concurrent last-state changes.
 perform 1 from public.gym_users where gym_id=g and id in(actor,target) order by id for update;
 select * into actor_record from public.gym_users where id=actor and gym_id=g and role='member' and status='active' and account_mode='portal';
 if actor_record.id is null then raise exception 'FRIEND_MEMBER_REQUIRED';end if;
 select * into result from public.member_friendships where gym_id=g and member_a=least(actor,target) and member_b=greatest(actor,target) for update;
 if action in ('request','accept') then
  if not exists(select 1 from public.gym_users where id=target and gym_id=g and role='member' and status='active' and account_mode='portal')
   or (select count(*) from public.member_fitness_profiles where gym_id=g and member_user_id in(actor,target) and show_in_community)<>2
   or (select count(*) from public.member_friend_preferences where gym_id=g and member_user_id in(actor,target) and allow_requests)<>2
  then raise exception 'FRIEND_PRIVACY_REQUIRED';end if;
 end if;
 if action='request' then
  if result.status='accepted' then return result;end if;
  if result.status='pending' then
   if result.requested_by=actor then return result;else raise exception 'FRIEND_INCOMING_PENDING';end if;
  end if;
  if result.id is not null and result.updated_at>now()-interval '24 hours' then raise exception 'FRIEND_REQUEST_COOLDOWN';end if;
  insert into public.member_friendships(gym_id,member_a,member_b,requested_by,status) values(g,least(actor,target),greatest(actor,target),actor,'pending')
  on conflict(gym_id,member_a,member_b) do update set requested_by=actor,status='pending',created_at=now(),updated_at=now() returning * into result;
  receiver:=target;event:='friendship_request';
 elsif action in ('accept','reject') then
  if result.id is null or result.status<>'pending' or result.requested_by=actor then raise exception 'FRIEND_STATE_INVALID';end if;
  update public.member_friendships set status=case when action='accept' then 'accepted' else 'rejected' end,updated_at=now() where id=result.id returning * into result;
  if action='accept' then receiver:=target;event:='friendship_accepted';end if;
 elsif action='cancel' then
  if result.id is null or result.status<>'pending' or result.requested_by<>actor then raise exception 'FRIEND_STATE_INVALID';end if;
  update public.member_friendships set status='cancelled',updated_at=now() where id=result.id returning * into result;
 elsif action='remove' then
  if result.id is null or result.status<>'accepted' then raise exception 'FRIEND_STATE_INVALID';end if;
  update public.member_friendships set status='removed',updated_at=now() where id=result.id returning * into result;
 end if;
 insert into public.audit_logs(gym_id,actor_profile_id,actor_gym_user_id,action,entity_type,entity_id,after_data)
 values(g,actor_record.profile_id,actor,'member.friendship.'||action,'member_friendship',result.id,jsonb_build_object('status',result.status));
 if receiver is not null then
  select full_name into actor_name from public.profiles where id=actor_record.profile_id;
  insert into public.loyalty_notifications(gym_id,member_user_id,event_key,kind,title,body)
  values(g,receiver,event||':'||result.id||':'||gen_random_uuid(),event,
   case when action='request' then 'Nueva solicitud de amistad' else 'Solicitud de amistad aceptada' end,
   coalesce(actor_name,'Un miembro')||case when action='request' then ' quiere ser tu amigo. Revisa la sección Amigos de tu perfil.' else ' aceptó tu solicitud. Ya aparecen como amigos en FitLab.' end);
 end if;
 return result;
end;$$;
revoke all on function public.set_member_friend_preferences_backend(uuid,uuid,boolean),public.change_member_friendship_backend(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.set_member_friend_preferences_backend(uuid,uuid,boolean),public.change_member_friendship_backend(uuid,uuid,uuid,text) to service_role;
commit;
