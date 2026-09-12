begin;
set local lock_timeout = '5s';

-- Las reacciones son pequeñas y positivas; nunca se exponen escrituras directas
-- desde la API de Supabase. El backend las valida por gimnasio y visibilidad.
create table public.member_community_reactions (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  actor_member_user_id uuid not null references public.gym_users(id) on delete cascade,
  target_member_user_id uuid not null references public.gym_users(id) on delete cascade,
  reaction_type text not null check (reaction_type in ('like', 'love')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (actor_member_user_id <> target_member_user_id),
  unique (gym_id, actor_member_user_id, target_member_user_id)
);

create index member_community_reactions_target_idx
  on public.member_community_reactions(gym_id, target_member_user_id, reaction_type);

create or replace function private.validate_member_community_reaction()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_record public.gym_users%rowtype;
  target_record public.gym_users%rowtype;
  target_profile public.member_fitness_profiles%rowtype;
begin
  select * into actor_record from public.gym_users where id = new.actor_member_user_id;
  select * into target_record from public.gym_users where id = new.target_member_user_id;
  select * into target_profile from public.member_fitness_profiles where member_user_id = new.target_member_user_id;

  if actor_record.id is null
     or target_record.id is null
     or target_profile.id is null
     or actor_record.gym_id is distinct from new.gym_id
     or target_record.gym_id is distinct from new.gym_id
     or actor_record.role <> 'member'
     or target_record.role <> 'member'
     or actor_record.status <> 'active'
     or target_record.status <> 'active'
     or actor_record.account_mode <> 'portal'
     or target_record.account_mode <> 'portal'
     or target_profile.show_in_community is not true then
    raise exception 'COMMUNITY_MEMBER_NOT_VISIBLE' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_member_community_reaction() from public, anon, authenticated;

create trigger member_community_reactions_validate
before insert or update of gym_id, actor_member_user_id, target_member_user_id
on public.member_community_reactions
for each row execute function private.validate_member_community_reaction();

create trigger member_community_reactions_set_updated_at
before update on public.member_community_reactions
for each row execute function private.set_updated_at();

alter table public.member_community_reactions enable row level security;
revoke all on public.member_community_reactions from public, anon, authenticated;

create or replace function public.toggle_member_community_reaction_backend(
  p_target_gym_id uuid,
  p_actor_member_user_id uuid,
  p_target_member_user_id uuid,
  p_supplied_reaction_type text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_record public.gym_users%rowtype;
  target_record public.gym_users%rowtype;
  target_profile public.member_fitness_profiles%rowtype;
  existing_reaction public.member_community_reactions%rowtype;
  result_reacted boolean;
  result_type text;
begin
  if p_supplied_reaction_type not in ('like', 'love') then
    raise exception 'COMMUNITY_REACTION_INVALID';
  end if;
  if p_actor_member_user_id = p_target_member_user_id then
    raise exception 'COMMUNITY_SELF_REACTION_NOT_ALLOWED';
  end if;

  select * into actor_record
  from public.gym_users
  where id = p_actor_member_user_id and gym_id = p_target_gym_id
  for update;
  select * into target_record
  from public.gym_users
  where id = p_target_member_user_id and gym_id = p_target_gym_id;
  select * into target_profile
  from public.member_fitness_profiles
  where member_user_id = p_target_member_user_id and gym_id = p_target_gym_id;

  if actor_record.id is null
     or target_record.id is null
     or target_profile.id is null
     or actor_record.role <> 'member'
     or target_record.role <> 'member'
     or actor_record.status <> 'active'
     or target_record.status <> 'active'
     or actor_record.account_mode <> 'portal'
     or target_record.account_mode <> 'portal'
     or target_profile.show_in_community is not true then
    raise exception 'COMMUNITY_MEMBER_NOT_VISIBLE';
  end if;

  select * into existing_reaction
  from public.member_community_reactions
  where gym_id = p_target_gym_id
    and actor_member_user_id = p_actor_member_user_id
    and target_member_user_id = p_target_member_user_id
  for update;

  if found and existing_reaction.reaction_type = p_supplied_reaction_type then
    delete from public.member_community_reactions where id = existing_reaction.id;
    result_reacted := false;
    result_type := null;
  elsif found then
    update public.member_community_reactions
    set reaction_type = p_supplied_reaction_type
    where id = existing_reaction.id;
    result_reacted := true;
    result_type := p_supplied_reaction_type;
  else
    insert into public.member_community_reactions(gym_id, actor_member_user_id, target_member_user_id, reaction_type)
    values(p_target_gym_id, p_actor_member_user_id, p_target_member_user_id, p_supplied_reaction_type);
    result_reacted := true;
    result_type := p_supplied_reaction_type;
  end if;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id,
    used_pin_elevation, after_data
  ) values (
    p_target_gym_id, actor_record.profile_id, p_actor_member_user_id,
    'member.community_reaction_changed', 'member_community_reaction', p_target_member_user_id,
    false, jsonb_build_object('reaction_type', result_type, 'reacted', result_reacted)
  );

  return jsonb_build_object(
    'targetMemberUserId', p_target_member_user_id,
    'reactionType', result_type,
    'reacted', result_reacted
  );
end;
$$;

revoke all on function public.toggle_member_community_reaction_backend(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.toggle_member_community_reaction_backend(uuid, uuid, uuid, text) to service_role;

commit;
