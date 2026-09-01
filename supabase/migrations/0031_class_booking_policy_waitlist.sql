begin;

-- La ventana de dos horas aplica al propio miembro. Recepcion y owner
-- conservan capacidad de resolver una reserva manualmente.
create or replace function private.enforce_member_class_cancellation_window()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  class_starts_at timestamptz;
  canceller_role public.gym_role;
begin
  if old.status = 'reserved' and new.status = 'cancelled'
     and new.cancelled_by = old.member_user_id then
    select cs.starts_at into class_starts_at
    from public.class_schedules cs where cs.id = old.class_schedule_id;
    select gu.role into canceller_role
    from public.gym_users gu where gu.id = new.cancelled_by;
    if canceller_role = 'member' and class_starts_at <= now() + interval '2 hours' then
      raise exception 'CLASS_BOOKING_CANCELLATION_WINDOW_CLOSED' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_member_class_cancellation_window() from public, anon, authenticated;
drop trigger if exists class_bookings_member_cancellation_window on public.class_bookings;
create trigger class_bookings_member_cancellation_window
before update on public.class_bookings
for each row execute function private.enforce_member_class_cancellation_window();

create type public.class_waitlist_status as enum ('waiting', 'offered', 'cancelled', 'expired');

create table public.class_waitlists (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  class_schedule_id uuid not null references public.class_schedules(id) on delete cascade,
  member_user_id uuid not null references public.gym_users(id),
  status public.class_waitlist_status not null default 'waiting',
  joined_at timestamptz not null default now(),
  offered_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references public.gym_users(id),
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_schedule_id, member_user_id),
  check ((status = 'cancelled' and cancelled_at is not null) or (status <> 'cancelled' and cancelled_at is null))
);

alter table public.class_waitlists enable row level security;
create index class_waitlists_schedule_status_idx on public.class_waitlists(class_schedule_id, status, joined_at);
create index class_waitlists_member_idx on public.class_waitlists(gym_id, member_user_id, created_at desc);

create or replace function private.validate_class_waitlist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  schedule_gym_id uuid;
  member_gym_id uuid;
  member_role public.gym_role;
begin
  select cs.gym_id into schedule_gym_id from public.class_schedules cs where cs.id = new.class_schedule_id;
  select gu.gym_id, gu.role into member_gym_id, member_role from public.gym_users gu where gu.id = new.member_user_id;
  if schedule_gym_id is distinct from new.gym_id
     or member_gym_id is distinct from new.gym_id
     or member_role is distinct from 'member' then
    raise exception 'CLASS_WAITLIST_TENANT_MISMATCH' using errcode = '23514';
  end if;
  if new.status in ('waiting', 'offered') and not exists (
    select 1 from public.class_schedules cs
    where cs.id = new.class_schedule_id and cs.status = 'scheduled' and cs.starts_at > now()
  ) then
    raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_class_waitlist() from public, anon, authenticated;
create trigger class_waitlists_validate before insert or update on public.class_waitlists
for each row execute function private.validate_class_waitlist();
create trigger class_waitlists_set_updated_at before update on public.class_waitlists
for each row execute function private.set_updated_at();

create or replace function private.close_waitlist_after_reservation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'reserved' then
    update public.class_waitlists cw
    set status = 'cancelled', cancelled_at = now(), cancelled_by = new.booked_by,
        cancellation_reason = 'Se convirtió en una reserva.'
    where cw.class_schedule_id = new.class_schedule_id
      and cw.member_user_id = new.member_user_id
      and cw.status in ('waiting', 'offered');
  end if;
  return new;
end;
$$;

revoke all on function private.close_waitlist_after_reservation() from public, anon, authenticated;
drop trigger if exists class_bookings_close_waitlist on public.class_bookings;
create trigger class_bookings_close_waitlist
after insert or update of status on public.class_bookings
for each row execute function private.close_waitlist_after_reservation();

create or replace function public.join_class_waitlist_backend(
  target_gym_id uuid,
  target_class_schedule_id uuid,
  target_member_user_id uuid,
  target_actor_gym_user_id uuid
)
returns table(waitlist_id uuid, waitlist_position bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  actor_role public.gym_role;
  actor_status public.gym_user_status;
  actor_account_mode text;
  schedule_record record;
  existing_waitlist public.class_waitlists;
  created_waitlist public.class_waitlists;
  effective_capacity integer;
  occupied_count bigint;
begin
  select gu.profile_id, gu.role, gu.status, gu.account_mode
    into actor_profile_id, actor_role, actor_status, actor_account_mode
  from public.gym_users gu
  where gu.id = target_actor_gym_user_id and gu.gym_id = target_gym_id;
  if not found or actor_role <> 'member'
     or actor_status <> 'active' or actor_account_mode <> 'portal'
     or target_actor_gym_user_id is distinct from target_member_user_id then
    raise exception 'MEMBER_CAN_ONLY_JOIN_OWN_WAITLIST' using errcode = '42501';
  end if;
  select cs.starts_at, cs.status, cs.capacity_override, ec.capacity, ec.billing_mode
    into schedule_record
  from public.class_schedules cs
  join public.extra_classes ec on ec.id = cs.extra_class_id
  where cs.id = target_class_schedule_id and cs.gym_id = target_gym_id
  for update of cs;
  if not found or schedule_record.status <> 'scheduled' or schedule_record.starts_at <= now() then
    raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode = '23514';
  end if;
  if schedule_record.billing_mode <> 'included' then
    raise exception 'CLASS_WAITLIST_PAYMENT_REQUIRED' using errcode = '23514';
  end if;
  perform private.class_member_coverage(target_gym_id, target_member_user_id, schedule_record.starts_at);
  if exists (
    select 1 from public.class_bookings cb
    where cb.class_schedule_id = target_class_schedule_id
      and cb.member_user_id = target_member_user_id
      and cb.status in ('reserved', 'attended')
  ) then
    raise exception 'CLASS_BOOKING_ALREADY_EXISTS' using errcode = '23505';
  end if;
  effective_capacity := coalesce(schedule_record.capacity_override, schedule_record.capacity);
  select count(*) into occupied_count
  from public.class_bookings cb
  where cb.class_schedule_id = target_class_schedule_id and cb.status in ('reserved', 'attended');
  if occupied_count < effective_capacity then
    raise exception 'CLASS_WAITLIST_NOT_NEEDED' using errcode = '23514';
  end if;
  select * into existing_waitlist from public.class_waitlists cw
  where cw.class_schedule_id = target_class_schedule_id and cw.member_user_id = target_member_user_id
  for update;
  if found and existing_waitlist.status in ('waiting', 'offered') then
    return query select existing_waitlist.id,
      (select count(*) + 1 from public.class_waitlists prior
       where prior.class_schedule_id = target_class_schedule_id
         and prior.status = 'waiting' and prior.joined_at < existing_waitlist.joined_at);
    return;
  end if;
  if found then
    update public.class_waitlists cw
    set status = 'waiting', joined_at = now(), offered_at = null,
        cancelled_at = null, cancelled_by = null, cancellation_reason = null
    where cw.id = existing_waitlist.id returning * into created_waitlist;
  else
    insert into public.class_waitlists(gym_id, class_schedule_id, member_user_id, status)
    values (target_gym_id, target_class_schedule_id, target_member_user_id, 'waiting')
    returning * into created_waitlist;
  end if;
  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id,
    used_pin_elevation, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'class.waitlist_joined', 'class_waitlist', created_waitlist.id, false,
    jsonb_build_object('schedule_id', target_class_schedule_id, 'member_user_id', target_member_user_id)
  );
  return query select created_waitlist.id,
    (select count(*) + 1 from public.class_waitlists prior
     where prior.class_schedule_id = target_class_schedule_id
       and prior.status = 'waiting' and prior.joined_at < created_waitlist.joined_at);
end;
$$;

revoke all on function public.join_class_waitlist_backend(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.join_class_waitlist_backend(uuid, uuid, uuid, uuid) to service_role;

create or replace function public.leave_class_waitlist_backend(
  target_gym_id uuid,
  target_waitlist_id uuid,
  target_actor_gym_user_id uuid,
  supplied_reason text
)
returns public.class_waitlists
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  waitlist_record public.class_waitlists;
  cancelled_waitlist public.class_waitlists;
begin
  select gu.profile_id into actor_profile_id
  from public.gym_users gu
  where gu.id = target_actor_gym_user_id and gu.gym_id = target_gym_id
    and gu.role = 'member' and gu.status = 'active' and gu.account_mode = 'portal';
  if actor_profile_id is null then raise exception 'MEMBER_SELF_CANCELLATION_REQUIRED' using errcode = '42501'; end if;
  select * into waitlist_record from public.class_waitlists cw
  where cw.id = target_waitlist_id and cw.gym_id = target_gym_id
    and cw.member_user_id = target_actor_gym_user_id and cw.status in ('waiting', 'offered') for update;
  if not found then raise exception 'CLASS_WAITLIST_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.class_waitlists cw
  set status = 'cancelled', cancelled_at = now(), cancelled_by = target_actor_gym_user_id,
      cancellation_reason = coalesce(nullif(trim(supplied_reason), ''), 'Salida voluntaria de la lista')
  where cw.id = target_waitlist_id returning * into cancelled_waitlist;
  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id,
    used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'class.waitlist_left', 'class_waitlist', target_waitlist_id, false,
    to_jsonb(waitlist_record), to_jsonb(cancelled_waitlist)
  );
  return cancelled_waitlist;
end;
$$;

revoke all on function public.leave_class_waitlist_backend(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.leave_class_waitlist_backend(uuid, uuid, uuid, text) to service_role;

commit;
