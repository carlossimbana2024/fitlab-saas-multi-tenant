begin;
set local lock_timeout = '5s';

create table public.gym_announcements (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  location_id uuid references public.gym_locations(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 3000),
  status text not null default 'published' check (status in ('published', 'archived')),
  created_by uuid not null references public.gym_users(id),
  created_at timestamptz not null default now(),
  archived_by uuid references public.gym_users(id),
  archived_at timestamptz,
  check ((status = 'published' and archived_at is null and archived_by is null)
      or (status = 'archived' and archived_at is not null and archived_by is not null))
);

create index gym_announcements_visible_idx
  on public.gym_announcements(gym_id, status, created_at desc)
  where status = 'published';

create trigger gym_announcements_location_tenant before insert or update on public.gym_announcements
for each row execute function private.enforce_tenant_reference('location_id', 'gym_locations');
create trigger gym_announcements_creator_tenant before insert or update on public.gym_announcements
for each row execute function private.enforce_tenant_reference('created_by', 'gym_users');
create trigger gym_announcements_archiver_tenant before insert or update on public.gym_announcements
for each row execute function private.enforce_tenant_reference('archived_by', 'gym_users');

alter table public.gym_announcements enable row level security;
revoke all on public.gym_announcements from public, anon, authenticated;
grant select, insert, update on public.gym_announcements to service_role;

commit;
