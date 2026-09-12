begin;
set local lock_timeout = '5s';

-- Historial privado de mediciones. El dato actual de la encuesta se conserva
-- como punto inicial y cada fecha solo puede contar una medición.
create table public.member_weight_entries (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  member_user_id uuid not null references public.gym_users(id) on delete cascade,
  weight_kg numeric(6,2) not null check (weight_kg between 20 and 500),
  measured_on date not null,
  source text not null default 'member' check (source in ('onboarding', 'member', 'staff')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (gym_id, member_user_id, measured_on)
);

create index member_weight_entries_member_date_idx
  on public.member_weight_entries(gym_id, member_user_id, measured_on desc);

create or replace function private.validate_member_weight_entry()
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
    raise exception 'MEMBER_WEIGHT_ENTRY_MEMBER_MISMATCH' using errcode = '23514';
  end if;

  return new;
end;
$$;
revoke all on function private.validate_member_weight_entry() from public, anon, authenticated;

create trigger member_weight_entries_validate
before insert or update of gym_id, member_user_id
on public.member_weight_entries
for each row execute function private.validate_member_weight_entry();

create trigger member_weight_entries_set_updated_at
before update on public.member_weight_entries
for each row execute function private.set_updated_at();

alter table public.member_weight_entries enable row level security;
revoke all on public.member_weight_entries from public, anon, authenticated;
grant select on public.member_weight_entries to authenticated;

create policy member_weight_entries_select_self
on public.member_weight_entries for select to authenticated
using (
  gym_id = (select private.current_gym_id())
  and member_user_id = (select private.current_gym_user_id())
);

-- Permite registrar una medición del propio miembro sin exponer escrituras
-- directas a la API de Supabase.
create or replace function public.upsert_member_weight_backend(
  target_gym_id uuid,
  target_member_user_id uuid,
  supplied_weight_kg numeric,
  supplied_measured_on date,
  supplied_source text default 'member'
) returns public.member_weight_entries
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  member_record public.gym_users%rowtype;
  gym_timezone text;
  today date;
  entry_record public.member_weight_entries%rowtype;
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
    raise exception 'MEMBER_WEIGHT_ENTRY_MEMBER_MISMATCH';
  end if;

  select g.timezone into gym_timezone from public.gyms g where g.id = target_gym_id;
  if gym_timezone is null then raise exception 'GYM_NOT_FOUND'; end if;
  today := (now() at time zone gym_timezone)::date;
  if supplied_measured_on is null or supplied_measured_on > today or supplied_measured_on < (today - interval '5 years')::date then
    raise exception 'MEMBER_WEIGHT_ENTRY_DATE_INVALID';
  end if;
  if supplied_source is null or supplied_source not in ('onboarding', 'member', 'staff') then
    raise exception 'MEMBER_WEIGHT_ENTRY_SOURCE_INVALID';
  end if;

  insert into public.member_weight_entries(gym_id, member_user_id, weight_kg, measured_on, source)
  values(target_gym_id, target_member_user_id, supplied_weight_kg, supplied_measured_on, supplied_source)
  on conflict (gym_id, member_user_id, measured_on) do update set
    weight_kg = excluded.weight_kg,
    source = excluded.source
  returning * into entry_record;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id,
    used_pin_elevation, after_data
  ) values (
    target_gym_id, member_record.profile_id, target_member_user_id,
    'member.weight_recorded', 'member_weight_entry', entry_record.id,
    false, jsonb_build_object('measured_on', entry_record.measured_on, 'source', entry_record.source)
  );

  return entry_record;
end;
$$;

revoke all on function public.upsert_member_weight_backend(uuid, uuid, numeric, date, text) from public, anon, authenticated;
grant execute on function public.upsert_member_weight_backend(uuid, uuid, numeric, date, text) to service_role;

-- Semilla para miembros que ya completaron la encuesta antes de esta migración.
insert into public.member_weight_entries(gym_id, member_user_id, weight_kg, measured_on, source)
select fp.gym_id, fp.member_user_id, fp.weight_kg,
  (fp.onboarding_completed_at at time zone coalesce(g.timezone, 'America/Guayaquil'))::date,
  'onboarding'
from public.member_fitness_profiles fp
join public.gyms g on g.id = fp.gym_id
join public.gym_users gu on gu.id = fp.member_user_id
  and gu.gym_id = fp.gym_id
  and gu.role = 'member'
  and gu.status = 'active'
  and gu.account_mode = 'portal'
  and gu.profile_id is not null
on conflict (gym_id, member_user_id, measured_on) do nothing;

create or replace function private.seed_member_weight_entry()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  gym_timezone text;
begin
  if tg_op = 'INSERT' then
    select g.timezone into gym_timezone from public.gyms g where g.id = new.gym_id;
    insert into public.member_weight_entries(gym_id, member_user_id, weight_kg, measured_on, source)
    values(new.gym_id, new.member_user_id, new.weight_kg,
      (new.onboarding_completed_at at time zone coalesce(gym_timezone, 'America/Guayaquil'))::date,
      'onboarding')
    on conflict (gym_id, member_user_id, measured_on) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.seed_member_weight_entry() from public, anon, authenticated;

create trigger member_fitness_profiles_seed_weight
after insert on public.member_fitness_profiles
for each row execute function private.seed_member_weight_entry();

commit;
