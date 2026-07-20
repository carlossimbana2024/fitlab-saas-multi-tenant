begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(trim(full_name)) between 2 and 150),
  phone text,
  avatar_url text,
  preferred_language text not null default 'es',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.gyms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 150),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  legal_name text,
  email text,
  phone text,
  timezone text not null default 'America/Guayaquil',
  currency char(3) not null default 'USD' check (currency::text ~ '^[A-Z]{3}$'),
  status public.gym_status not null default 'trial',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.gym_security (
  gym_id uuid primary key references public.gyms(id) on delete cascade,
  admin_passcode_hash text,
  pin_failed_attempts integer not null default 0 check (pin_failed_attempts >= 0),
  pin_locked_until timestamptz,
  pin_updated_at timestamptz
);

create table private.platform_admins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'suspended')),
  mfa_required boolean not null default true,
  created_at timestamptz not null default now(),
  last_access_at timestamptz
);

create table public.gym_locations (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  name text not null,
  address text,
  city text not null default 'Quito',
  timezone text not null default 'America/Guayaquil',
  phone text,
  is_main boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (gym_id, name)
);

create unique index gym_locations_one_main_per_gym
  on public.gym_locations(gym_id)
  where is_main;

create table public.gym_users (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  role public.gym_role not null,
  status public.gym_user_status not null default 'invited',
  default_location_id uuid references public.gym_locations(id) on delete set null,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (gym_id, id)
);

create index gym_users_gym_role_idx on public.gym_users(gym_id, role);

create table public.gym_invitations (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  email text not null,
  intended_role public.gym_role not null,
  invited_by uuid not null references public.gym_users(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  status public.invitation_status not null default 'pending',
  created_at timestamptz not null default now()
);

-- Denegar acceso por defecto desde el momento en que se crean las tablas.
-- Las políticas de acceso se incorporan posteriormente en 0007_rls.sql.
alter table public.profiles enable row level security;
alter table public.gyms enable row level security;
alter table public.gym_locations enable row level security;
alter table public.gym_users enable row level security;
alter table public.gym_invitations enable row level security;

create or replace function private.enforce_owner_invitation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  inviter_profile_id uuid;
  inviter_role public.gym_role;
  inviter_status public.gym_user_status;
begin
  select gu.profile_id, gu.role, gu.status
    into inviter_profile_id, inviter_role, inviter_status
  from public.gym_users gu
  where gu.id = new.invited_by
    and gu.gym_id = new.gym_id;

  if inviter_profile_id is null then
    raise exception 'INVITER_MUST_BELONG_TO_GYM' using errcode = '23514';
  end if;

  if (select auth.uid()) is not null and inviter_profile_id <> (select auth.uid()) then
    raise exception 'INVITER_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
  end if;

  if new.intended_role = 'owner'
     and (inviter_role <> 'owner' or inviter_status <> 'active') then
    raise exception 'ONLY_ACTIVE_OWNER_CAN_INVITE_OWNER' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_owner_invitation() from public, anon, authenticated;

create trigger gym_invitations_enforce_owner
before insert or update of gym_id, intended_role, invited_by
on public.gym_invitations
for each row execute function private.enforce_owner_invitation();

create unique index gym_invitations_pending_email_idx
  on public.gym_invitations(gym_id, lower(email))
  where status = 'pending';

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function private.set_updated_at();
create trigger gyms_set_updated_at before update on public.gyms
for each row execute function private.set_updated_at();
create trigger gym_locations_set_updated_at before update on public.gym_locations
for each row execute function private.set_updated_at();
create trigger gym_users_set_updated_at before update on public.gym_users
for each row execute function private.set_updated_at();

commit;
