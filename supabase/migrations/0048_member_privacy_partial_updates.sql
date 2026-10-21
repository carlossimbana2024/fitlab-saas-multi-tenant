begin;
set local lock_timeout = '5s';

-- FIT-MEMBER-001. Deploy the partial-write API/UI after applying this migration.
-- Existing profiles keep privacy on sports edits; null means not supplied.
create or replace function public.upsert_member_fitness_profile_backend(
  target_gym_id uuid,
  target_member_user_id uuid,
  supplied_weight_kg numeric,
  supplied_height_cm numeric,
  supplied_goal_type text,
  supplied_experience_level text,
  supplied_training_frequency_per_week smallint,
  supplied_available_days smallint[],
  supplied_target_weight_kg numeric,
  supplied_preferred_training_type text,
  supplied_goal_horizon_months smallint,
  supplied_public_message text,
  supplied_show_in_community boolean,
  supplied_show_profile_photo boolean,
  supplied_show_streak boolean,
  supplied_show_attendance_count boolean,
  supplied_show_weight_progress boolean,
  supplied_show_goal boolean
) returns public.member_fitness_profiles
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  member_record public.gym_users%rowtype;
  member_profile_id uuid;
  profile_record public.member_fitness_profiles%rowtype;
begin
  select * into member_record
  from public.gym_users gu
  where gu.id = target_member_user_id
    and gu.gym_id = target_gym_id
  for update;

  if not found
     or member_record.role <> 'member'
     or member_record.status <> 'active'
     or member_record.account_mode <> 'portal'
     or member_record.profile_id is null then
    raise exception 'MEMBER_FITNESS_PROFILE_MEMBER_MISMATCH';
  end if;
  member_profile_id := member_record.profile_id;

  -- Old clients must not submit a full stale privacy snapshot.
  select * into profile_record from public.member_fitness_profiles
  where gym_id = target_gym_id and member_user_id = target_member_user_id;
  if found and (
    (supplied_show_in_community is not null and supplied_show_in_community is distinct from profile_record.show_in_community) or
    (supplied_show_profile_photo is not null and supplied_show_profile_photo is distinct from profile_record.show_profile_photo) or
    (supplied_show_streak is not null and supplied_show_streak is distinct from profile_record.show_streak) or
    (supplied_show_attendance_count is not null and supplied_show_attendance_count is distinct from profile_record.show_attendance_count) or
    (supplied_show_weight_progress is not null and supplied_show_weight_progress is distinct from profile_record.show_weight_progress) or
    (supplied_show_goal is not null and supplied_show_goal is distinct from profile_record.show_goal)
  ) then
    raise exception 'MEMBER_PRIVACY_REQUIRES_PARTIAL_UPDATE';
  end if;

  insert into public.member_fitness_profiles(
    gym_id, member_user_id, weight_kg, height_cm, goal_type,
    experience_level, training_frequency_per_week, available_days,
    target_weight_kg, preferred_training_type, goal_horizon_months,
    public_message, show_in_community, show_profile_photo, show_streak,
    show_attendance_count, show_weight_progress, show_goal
  ) values (
    target_gym_id, target_member_user_id, supplied_weight_kg, supplied_height_cm, supplied_goal_type,
    supplied_experience_level, supplied_training_frequency_per_week, coalesce(supplied_available_days, '{}'::smallint[]),
    supplied_target_weight_kg, nullif(trim(supplied_preferred_training_type), ''), supplied_goal_horizon_months,
    nullif(trim(supplied_public_message), ''), coalesce(supplied_show_in_community, false), coalesce(supplied_show_profile_photo, false), coalesce(supplied_show_streak, false),
    coalesce(supplied_show_attendance_count, false), coalesce(supplied_show_weight_progress, false), coalesce(supplied_show_goal, false)
  )
  on conflict (member_user_id) do update set
    gym_id = excluded.gym_id,
    weight_kg = excluded.weight_kg,
    height_cm = excluded.height_cm,
    goal_type = excluded.goal_type,
    experience_level = excluded.experience_level,
    training_frequency_per_week = excluded.training_frequency_per_week,
    available_days = excluded.available_days,
    target_weight_kg = excluded.target_weight_kg,
    preferred_training_type = excluded.preferred_training_type,
    goal_horizon_months = excluded.goal_horizon_months,
    public_message = excluded.public_message,
    onboarding_completed_at = coalesce(public.member_fitness_profiles.onboarding_completed_at, now())
  returning * into profile_record;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id,
    used_pin_elevation, after_data
  ) values (
    target_gym_id, member_profile_id, target_member_user_id,
    'member.fitness_profile.updated', 'member_fitness_profile', profile_record.id,
    false, jsonb_build_object(
      'goal_type', profile_record.goal_type,
      'experience_level', profile_record.experience_level,
      'show_in_community', profile_record.show_in_community,
      'show_weight_progress', profile_record.show_weight_progress
    )
  );

  return profile_record;
end;
$$;


-- A single explicit preference is the entire write contract.
create or replace function public.update_member_privacy_backend(
  target_gym_id uuid, target_member_user_id uuid,
  preference_key text, preference_value boolean
) returns public.member_fitness_profiles
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  member_record public.gym_users%rowtype;
  profile_record public.member_fitness_profiles%rowtype;
begin
  if preference_key is null or preference_key not in ('show_in_community', 'show_profile_photo', 'show_streak', 'show_attendance_count', 'show_weight_progress', 'show_goal')
     or preference_value is null then
    raise exception 'INVALID_MEMBER_PRIVACY_PATCH';
  end if;

  -- Same lock order as the sports upsert; serializes creation and updates.
  select * into member_record from public.gym_users
  where id = target_member_user_id and gym_id = target_gym_id for update;
  if not found or member_record.role <> 'member'
     or member_record.status <> 'active'
     or member_record.account_mode <> 'portal'
     or member_record.profile_id is null then
    raise exception 'MEMBER_FITNESS_PROFILE_MEMBER_MISMATCH';
  end if;

  -- Identifier is strictly allowlisted above; values are parameterized.
  execute format(
    'update public.member_fitness_profiles set %I = $1
     where gym_id = $2 and member_user_id = $3 returning *', preference_key
  ) into profile_record using preference_value, target_gym_id, target_member_user_id;
  if profile_record.id is null then
    raise exception 'MEMBER_FITNESS_PROFILE_REQUIRED';
  end if;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, used_pin_elevation, after_data
  ) values (
    target_gym_id, member_record.profile_id, target_member_user_id,
    'member.privacy.updated', 'member_fitness_profile', profile_record.id,
    false, jsonb_build_object(preference_key, preference_value)
  );
  return profile_record;
end;
$$;

revoke all on function public.update_member_privacy_backend(uuid,uuid,text,boolean)
from public, anon, authenticated;
grant execute on function public.update_member_privacy_backend(uuid,uuid,text,boolean)
to service_role;

commit;

