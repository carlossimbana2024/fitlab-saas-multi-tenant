begin;
set local lock_timeout = '5s';

-- Perfil de entrenamiento del miembro. Los campos de privacidad quedan
-- preparados para Comunidad, pero no se exponen hasta esa fase.
create table public.member_fitness_profiles (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  member_user_id uuid not null references public.gym_users(id) on delete cascade,
  weight_kg numeric(6,2) not null check (weight_kg between 20 and 500),
  height_cm numeric(5,2) not null check (height_cm between 80 and 260),
  goal_type text not null check (goal_type in ('lose_weight', 'gain_weight', 'build_muscle', 'improve_fitness', 'maintain_weight', 'general_wellness')),
  experience_level text not null default 'beginner' check (experience_level in ('beginner', 'intermediate', 'advanced')),
  training_frequency_per_week smallint not null default 3 check (training_frequency_per_week between 1 and 14),
  available_days smallint[] not null default '{}'::smallint[] check (
    cardinality(available_days) = 0
    or (
      array_length(available_days, 1) between 1 and 7
      and available_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
    )
  ),
  target_weight_kg numeric(6,2) check (target_weight_kg is null or target_weight_kg between 20 and 500),
  preferred_training_type text check (preferred_training_type is null or char_length(trim(preferred_training_type)) between 2 and 80),
  goal_horizon_months smallint check (goal_horizon_months is null or goal_horizon_months between 1 and 36),
  public_message text check (public_message is null or char_length(trim(public_message)) between 1 and 160),
  show_in_community boolean not null default false,
  show_profile_photo boolean not null default false,
  show_streak boolean not null default false,
  show_attendance_count boolean not null default false,
  show_weight_progress boolean not null default false,
  show_goal boolean not null default false,
  onboarding_completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (gym_id, member_user_id),
  unique (member_user_id)
);

create index member_fitness_profiles_gym_idx
  on public.member_fitness_profiles(gym_id, updated_at desc);

create or replace function private.validate_member_fitness_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  member_record public.gym_users%rowtype;
begin
  select * into member_record
  from public.gym_users gu
  where gu.id = new.member_user_id;

  if not found
     or member_record.gym_id is distinct from new.gym_id
     or member_record.role <> 'member'
     or member_record.status <> 'active'
     or member_record.account_mode <> 'portal'
     or member_record.profile_id is null then
    raise exception 'MEMBER_FITNESS_PROFILE_MEMBER_MISMATCH' using errcode = '23514';
  end if;

  return new;
end;
$$;
revoke all on function private.validate_member_fitness_profile() from public, anon, authenticated;

create trigger member_fitness_profiles_validate
before insert or update of gym_id, member_user_id
on public.member_fitness_profiles
for each row execute function private.validate_member_fitness_profile();

create trigger member_fitness_profiles_set_updated_at
before update on public.member_fitness_profiles
for each row execute function private.set_updated_at();

alter table public.member_fitness_profiles enable row level security;
revoke all on public.member_fitness_profiles from public, anon, authenticated;
grant select on public.member_fitness_profiles to authenticated;

create policy member_fitness_profiles_select_self
on public.member_fitness_profiles for select to authenticated
using (
  gym_id = (select private.current_gym_id())
  and member_user_id = (select private.current_gym_user_id())
);

-- Los cambios pasan por el backend para conservar validación y auditoría.
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
    nullif(trim(supplied_public_message), ''), supplied_show_in_community, supplied_show_profile_photo, supplied_show_streak,
    supplied_show_attendance_count, supplied_show_weight_progress, supplied_show_goal
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
    show_in_community = excluded.show_in_community,
    show_profile_photo = excluded.show_profile_photo,
    show_streak = excluded.show_streak,
    show_attendance_count = excluded.show_attendance_count,
    show_weight_progress = excluded.show_weight_progress,
    show_goal = excluded.show_goal,
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

revoke all on function public.upsert_member_fitness_profile_backend(
  uuid, uuid, numeric, numeric, text, text, smallint, smallint[], numeric, text,
  smallint, text, boolean, boolean, boolean, boolean, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.upsert_member_fitness_profile_backend(
  uuid, uuid, numeric, numeric, text, text, smallint, smallint[], numeric, text,
  smallint, text, boolean, boolean, boolean, boolean, boolean, boolean
) to service_role;

-- Foto privada: solo se permite acceso mediante URLs firmadas.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'member-avatars', 'member-avatars', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
