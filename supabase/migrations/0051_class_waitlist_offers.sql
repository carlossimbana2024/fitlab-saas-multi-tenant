begin;
set local lock_timeout = '5s';

-- FIT-MEMBER-005. Keep the legacy enum for compatible RPC signatures. A
-- generated state distinguishes accepted/rejected episodes without enum DDL
-- that would require committing halfway through this migration.
alter table public.class_waitlists add column if not exists outcome text
  check (outcome in ('accepted','rejected','voluntary','ineligible','unavailable','legacy_expired','expired'));
alter table public.class_waitlists add column if not exists state text generated always as (
  case when status='cancelled' and outcome='accepted' then 'accepted'
       when status='cancelled' and outcome='rejected' then 'rejected'
       when status='waiting' then 'waiting' when status='offered' then 'offered'
       when status='expired' then 'expired' else 'cancelled' end
) stored;
alter table public.class_waitlists drop constraint if exists class_waitlists_class_schedule_id_member_user_id_key;
create unique index if not exists class_waitlists_one_active_episode_idx
  on public.class_waitlists(class_schedule_id,member_user_id) where status in ('waiting','offered');
create index if not exists class_waitlists_fifo_idx
  on public.class_waitlists(class_schedule_id,joined_at,id) where status in ('waiting','offered');
revoke all on public.class_waitlists from public,anon,authenticated,service_role;
grant select on public.class_waitlists to service_role;

create table if not exists private.class_waitlist_policy (
  singleton boolean primary key default true check(singleton),
  offers_enabled boolean not null default false,
  offer_window interval not null default interval '30 minutes'
    check(offer_window>interval '0' and offer_window<=interval '1 day')
);
insert into private.class_waitlist_policy(singleton) values(true) on conflict do nothing;
revoke all on private.class_waitlist_policy from public,anon,authenticated,service_role;

create table if not exists private.class_waitlist_runs (
  class_schedule_id uuid primary key references public.class_schedules(id) on delete cascade,
  last_processed_at timestamptz not null,
  last_error text
);
revoke all on private.class_waitlist_runs from public,anon,authenticated,service_role;

create table if not exists public.class_waitlist_offers (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id),
  waitlist_id uuid not null references public.class_waitlists(id),
  class_schedule_id uuid not null references public.class_schedules(id),
  member_user_id uuid not null references public.gym_users(id),
  status text not null default 'offered' check(status in ('offered','accepting','accepted','rejected','expired','cancelled')),
  offered_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  responded_at timestamptz,
  booking_id uuid references public.class_bookings(id),
  reason text,
  check(expires_at>offered_at),
  check((status in ('offered','accepting') and responded_at is null and booking_id is null)
    or (status='accepted' and responded_at is not null and booking_id is not null)
    or (status in ('rejected','expired','cancelled') and responded_at is not null and booking_id is null))
);
alter table public.class_waitlist_offers enable row level security;
revoke all on public.class_waitlist_offers from public,anon,authenticated,service_role;
grant select on public.class_waitlist_offers to service_role;
create unique index if not exists class_waitlist_offers_one_active_idx
  on public.class_waitlist_offers(waitlist_id) where status in ('offered','accepting');
create unique index if not exists class_waitlist_offers_one_member_idx
  on public.class_waitlist_offers(class_schedule_id,member_user_id) where status in ('offered','accepting');
create index if not exists class_waitlist_offers_due_idx
  on public.class_waitlist_offers(expires_at,class_schedule_id) where status='offered';
create index if not exists class_waitlist_offers_session_idx
  on public.class_waitlist_offers(class_schedule_id,status);

create or replace function private.guard_class_waitlist_episode() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op='UPDATE' then
    if (new.gym_id,new.class_schedule_id,new.member_user_id,new.joined_at)
      is distinct from (old.gym_id,old.class_schedule_id,old.member_user_id,old.joined_at) then
      raise exception 'CLASS_WAITLIST_EPISODE_IMMUTABLE';
    end if;
    if old.status in ('cancelled','expired') and new.status in ('waiting','offered') then
      raise exception 'CLASS_WAITLIST_NEW_EPISODE_REQUIRED';
    end if;
  end if;
  if new.status in ('waiting','offered') then
    perform 1 from public.class_schedules where id=new.class_schedule_id and gym_id=new.gym_id for update;
    if exists(select 1 from public.class_bookings where gym_id=new.gym_id and class_schedule_id=new.class_schedule_id
      and member_user_id=new.member_user_id and status in ('reserved','attended')) then
      raise exception 'CLASS_BOOKING_ALREADY_EXISTS' using errcode='23505';
    end if;
  end if;
  return new;
end; $$;
revoke all on function private.guard_class_waitlist_episode() from public,anon,authenticated,service_role;
drop trigger if exists class_waitlists_episode_guard on public.class_waitlists;
create trigger class_waitlists_episode_guard before insert or update on public.class_waitlists
for each row execute function private.guard_class_waitlist_episode();

create or replace function private.validate_class_waitlist_offer() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op='UPDATE' and (new.id,new.gym_id,new.waitlist_id,new.class_schedule_id,new.member_user_id,new.offered_at)
    is distinct from (old.id,old.gym_id,old.waitlist_id,old.class_schedule_id,old.member_user_id,old.offered_at) then
    raise exception 'CLASS_WAITLIST_OFFER_IDENTITY_IMMUTABLE';
  end if;
  if not exists(select 1 from public.class_waitlists w where w.id=new.waitlist_id and w.gym_id=new.gym_id
    and w.class_schedule_id=new.class_schedule_id and w.member_user_id=new.member_user_id) then
    raise exception 'CLASS_WAITLIST_TENANT_MISMATCH' using errcode='23514';
  end if;
  if new.booking_id is not null and not exists(select 1 from public.class_bookings b where b.id=new.booking_id
    and b.gym_id=new.gym_id and b.class_schedule_id=new.class_schedule_id and b.member_user_id=new.member_user_id) then
    raise exception 'CLASS_WAITLIST_BOOKING_MISMATCH' using errcode='23514';
  end if;
  return new;
end; $$;
revoke all on function private.validate_class_waitlist_offer() from public,anon,authenticated,service_role;
drop trigger if exists class_waitlist_offers_validate on public.class_waitlist_offers;
create trigger class_waitlist_offers_validate before insert or update on public.class_waitlist_offers
for each row execute function private.validate_class_waitlist_offer();

-- 'accepting' is an internal claim visible only inside the accepting transaction.
-- It is not a browser flag/GUC and may never survive a commit.
create or replace function private.check_waitlist_acceptance_complete() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if exists(select 1 from public.class_waitlist_offers where id=new.id and status='accepting') then
    raise exception 'CLASS_WAITLIST_ACCEPTANCE_INCOMPLETE';
  end if;
  return null;
end; $$;
revoke all on function private.check_waitlist_acceptance_complete() from public,anon,authenticated,service_role;
drop trigger if exists class_waitlist_acceptance_complete on public.class_waitlist_offers;
create constraint trigger class_waitlist_acceptance_complete after insert or update on public.class_waitlist_offers
deferrable initially deferred for each row execute function private.check_waitlist_acceptance_complete();

create or replace function private.audit_class_waitlist_transition() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op='INSERT' or to_jsonb(new) is distinct from to_jsonb(old) then
    insert into public.audit_logs(gym_id,action,entity_type,entity_id,before_data,after_data)
    values(new.gym_id,case when tg_table_name='class_waitlists' then 'class.waitlist_state_changed'
      else 'class.waitlist_offer_changed' end,
      case when tg_table_name='class_waitlists' then 'class_waitlist' else 'class_waitlist_offer' end,new.id,
      case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));
  end if;
  return new;
end; $$;
revoke all on function private.audit_class_waitlist_transition() from public,anon,authenticated,service_role;
drop trigger if exists class_waitlists_audit on public.class_waitlists;
create trigger class_waitlists_audit after insert or update on public.class_waitlists
for each row execute function private.audit_class_waitlist_transition();
drop trigger if exists class_waitlist_offers_audit on public.class_waitlist_offers;
create trigger class_waitlist_offers_audit after insert or update on public.class_waitlist_offers
for each row execute function private.audit_class_waitlist_transition();

-- Do not fabricate a validity period for old rows labelled "offered". Preserve
-- their original timestamp and the transition in the audit trail.
update public.class_waitlists w set status='expired',outcome='legacy_expired',
  cancellation_reason='Oferta anterior sin vencimiento verificable; vuelve a unirte si deseas participar.'
where w.status='offered' and not exists(select 1 from public.class_waitlist_offers o where o.waitlist_id=w.id);

create or replace function private.require_waitlist_member(g uuid,m uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare p uuid;
begin
  select profile_id into p from public.gym_users where id=m and gym_id=g
    and role='member' and status='active' and account_mode='portal';
  if p is null then raise exception 'MEMBER_SELF_BOOKING_REQUIRED' using errcode='42501'; end if;
  return p;
end; $$;
revoke all on function private.require_waitlist_member(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function private.waitlist_member_eligible(g uuid,s uuid,m uuid,starts timestamptz) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not exists(select 1 from public.gym_users where id=m and gym_id=g and role='member'
    and status='active' and account_mode='portal' and profile_id is not null) then return false; end if;
  if exists(select 1 from public.class_bookings where gym_id=g and class_schedule_id=s and member_user_id=m
    and (status<>'cancelled' or payment_id is not null)) then return false; end if;
  begin perform private.class_member_coverage(g,m,starts);
  exception when check_violation then
    if sqlerrm in ('CLASS_BOOKING_REQUIRES_ACTIVE_MEMBER','CLASS_ACTIVE_MEMBERSHIP_COVERAGE_REQUIRED') then return false; end if;
    raise;
  end;
  return true;
end; $$;
revoke all on function private.waitlist_member_eligible(uuid,uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

create or replace function private.close_class_waitlist_entry(w uuid,result text,why text,actor uuid default null) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  update public.class_waitlists set status=case when result='expired' then 'expired'::public.class_waitlist_status
    else 'cancelled'::public.class_waitlist_status end,outcome=result,
    cancelled_at=case when result='expired' then null else clock_timestamp() end,
    cancelled_by=actor,cancellation_reason=why
  where id=w and status in ('waiting','offered');
end; $$;
revoke all on function private.close_class_waitlist_entry(uuid,text,text,uuid) from public,anon,authenticated,service_role;

create or replace function private.class_waitlist_capacity(g uuid,s uuid)
returns table(capacity integer,occupied bigint,offered_count bigint)
language sql volatile security definer set search_path=pg_catalog,public as $$
  select coalesce(cs.capacity_override,a.capacity),
    (select count(*) from public.class_bookings b where b.gym_id=g and b.class_schedule_id=s and b.status in ('reserved','attended')),
    (select count(*) from public.class_waitlist_offers o where o.gym_id=g and o.class_schedule_id=s
      and ((o.status='offered' and o.expires_at>clock_timestamp()) or o.status='accepting'))
  from public.class_schedules cs join public.extra_classes a on a.id=cs.extra_class_id and a.gym_id=g
  where cs.id=s and cs.gym_id=g;
$$;
revoke all on function private.class_waitlist_capacity(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function private.process_class_waitlist_queue(g uuid,s uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  cs public.class_schedules; a public.extra_classes; branch_active boolean; entry record; offer record;
  counts record; free_slots bigint; excess bigint; window_size interval; issued_at timestamptz; deadline timestamptz;
begin
  -- Safe rollout: activate only after the acceptance UI/API have been deployed.
  if (select offers_enabled from private.class_waitlist_policy where singleton) is distinct from true then return; end if;
  -- One serialization point for reservation, cancellation, offers and acceptance.
  select * into cs from public.class_schedules where id=s and gym_id=g for update;
  if not found then return; end if;
  select * into a from public.extra_classes where id=cs.extra_class_id and gym_id=g for share;
  select is_active into branch_active from public.gym_locations where id=cs.location_id and gym_id=g for share;
  insert into private.class_waitlist_runs(class_schedule_id,last_processed_at) values(s,clock_timestamp())
    on conflict(class_schedule_id) do update set last_processed_at=excluded.last_processed_at,last_error=null;
  if cs.status<>'scheduled' or cs.starts_at<=clock_timestamp() or a.is_active is distinct from true or branch_active is distinct from true then
    update public.class_waitlist_offers set status='cancelled',responded_at=clock_timestamp(),reason='Sesión no disponible.'
      where class_schedule_id=s and gym_id=g and status='offered';
    for entry in select id from public.class_waitlists where class_schedule_id=s and gym_id=g and status in ('waiting','offered') loop
      perform private.close_class_waitlist_entry(entry.id,'unavailable','Sesión, actividad o sucursal no disponible.');
    end loop;
    return;
  end if;
  update public.class_waitlist_offers set expires_at=cs.starts_at-interval '1 microsecond'
    where class_schedule_id=s and gym_id=g and status='offered' and expires_at>=cs.starts_at;
  for offer in select * from public.class_waitlist_offers where class_schedule_id=s and gym_id=g
    and status='offered' order by offered_at,id for update loop
    if offer.expires_at<=clock_timestamp() then
      update public.class_waitlist_offers set status='expired',responded_at=clock_timestamp(),reason='Plazo de aceptación vencido.' where id=offer.id;
      perform private.close_class_waitlist_entry(offer.waitlist_id,'expired','Plazo de aceptación vencido.');
    elsif not private.waitlist_member_eligible(g,s,offer.member_user_id,cs.starts_at) then
      update public.class_waitlist_offers set status='cancelled',responded_at=clock_timestamp(),reason='El miembro ya no cumple los requisitos.' where id=offer.id;
      perform private.close_class_waitlist_entry(offer.waitlist_id,'ineligible','El miembro ya no cumple los requisitos.');
    end if;
  end loop;
  select * into counts from private.class_waitlist_capacity(g,s);
  excess:=counts.offered_count-greatest(0,counts.capacity-counts.occupied);
  -- If capacity was reduced, revoke newest offers first and retain their FIFO
  -- position as waiting. The revoked offer remains as a historical record.
  if excess>0 then
    for offer in select o.id,o.waitlist_id from public.class_waitlist_offers o
      join public.class_waitlists w on w.id=o.waitlist_id
      where o.gym_id=g and o.class_schedule_id=s and o.status='offered'
      order by w.joined_at desc,w.id desc for update of o loop
      exit when excess<=0;
      update public.class_waitlist_offers set status='cancelled',responded_at=clock_timestamp(),reason='Capacidad reducida; conserva su turno.' where id=offer.id;
      update public.class_waitlists set status='waiting',offered_at=null,outcome=null where id=offer.waitlist_id;
      excess:=excess-1;
    end loop;
  end if;
  select * into counts from private.class_waitlist_capacity(g,s);
  free_slots:=greatest(0,counts.capacity-counts.occupied-counts.offered_count);
  select offer_window into window_size from private.class_waitlist_policy where singleton;
  while free_slots>0 loop
    select * into entry from public.class_waitlists where gym_id=g and class_schedule_id=s and status='waiting'
      order by joined_at,id limit 1 for update;
    exit when not found;
    if not private.waitlist_member_eligible(g,s,entry.member_user_id,cs.starts_at) then
      perform private.close_class_waitlist_entry(entry.id,'ineligible','El miembro ya no cumple los requisitos.');
      continue;
    end if;
    issued_at:=clock_timestamp(); deadline:=least(issued_at+window_size,cs.starts_at-interval '1 microsecond');
    exit when deadline<=issued_at;
    insert into public.class_waitlist_offers(gym_id,waitlist_id,class_schedule_id,member_user_id,offered_at,expires_at)
      values(g,entry.id,s,entry.member_user_id,issued_at,deadline);
    update public.class_waitlists set status='offered',offered_at=issued_at where id=entry.id;
    free_slots:=free_slots-1;
  end loop;
end; $$;
revoke all on function private.process_class_waitlist_queue(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function private.class_waitlist_position(w uuid) returns bigint
language sql volatile security definer set search_path=pg_catalog,public as $$
  select count(prior.id)+1 from public.class_waitlists current_entry
  left join public.class_waitlists prior on prior.gym_id=current_entry.gym_id
    and prior.class_schedule_id=current_entry.class_schedule_id and prior.status in ('waiting','offered')
    and (prior.joined_at,prior.id)<(current_entry.joined_at,current_entry.id)
  where current_entry.id=w and current_entry.status in ('waiting','offered')
  group by current_entry.id;
$$;
revoke all on function private.class_waitlist_position(uuid) from public,anon,authenticated,service_role;

create or replace function private.enforce_class_waitlist_priority() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare counts record; accepting boolean; starts timestamptz;
begin
  if new.status not in ('reserved','attended') then return new; end if;
  if tg_op='UPDATE' and old.status in ('reserved','attended') then return new; end if;
  if (select offers_enabled from private.class_waitlist_policy where singleton) is distinct from true then return new; end if;
  perform private.process_class_waitlist_queue(new.gym_id,new.class_schedule_id);
  select starts_at into starts from public.class_schedules where id=new.class_schedule_id and gym_id=new.gym_id;
  if starts<=clock_timestamp() then raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode='23514'; end if;
  if exists(select 1 from public.class_waitlist_offers where gym_id=new.gym_id and class_schedule_id=new.class_schedule_id
    and member_user_id=new.member_user_id and status='accepting' and expires_at<=clock_timestamp()) then
    raise exception 'CLASS_WAITLIST_OFFER_EXPIRED' using errcode='23514';
  end if;
  select exists(select 1 from public.class_waitlist_offers where gym_id=new.gym_id and class_schedule_id=new.class_schedule_id
    and member_user_id=new.member_user_id and status='accepting' and expires_at>clock_timestamp()) into accepting;
  if not accepting and exists(select 1 from public.class_waitlists where gym_id=new.gym_id
    and class_schedule_id=new.class_schedule_id and member_user_id=new.member_user_id and status in ('waiting','offered')) then
    raise exception 'CLASS_WAITLIST_OFFER_ACCEPT_REQUIRED' using errcode='23514';
  end if;
  select * into counts from private.class_waitlist_capacity(new.gym_id,new.class_schedule_id);
  if counts.occupied+counts.offered_count-(case when accepting then 1 else 0 end)>=counts.capacity then
    raise exception 'CLASS_WAITLIST_PRIORITY_REQUIRED' using errcode='23514';
  end if;
  if accepting then new.booked_at:=clock_timestamp(); end if;
  return new;
end; $$;
revoke all on function private.enforce_class_waitlist_priority() from public,anon,authenticated,service_role;
drop trigger if exists class_bookings_waitlist_priority on public.class_bookings;
create trigger class_bookings_waitlist_priority before insert or update on public.class_bookings
for each row execute function private.enforce_class_waitlist_priority();

create or replace function private.close_waitlist_after_reservation() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare claim public.class_waitlist_offers;
begin
  if new.status<>'reserved' then return new; end if;
  if (select offers_enabled from private.class_waitlist_policy where singleton) is distinct from true then
    -- Preserve the existing explicit-reservation flow during the rollout gap.
    update public.class_waitlists set status='cancelled',outcome='accepted',cancelled_at=clock_timestamp(),
      cancelled_by=new.booked_by,cancellation_reason='Se convirtió en una reserva explícita.'
    where gym_id=new.gym_id and class_schedule_id=new.class_schedule_id and member_user_id=new.member_user_id and status in ('waiting','offered');
    return new;
  end if;
  select * into claim from public.class_waitlist_offers where gym_id=new.gym_id and class_schedule_id=new.class_schedule_id
    and member_user_id=new.member_user_id and status='accepting' for update;
  if found then
    update public.class_waitlist_offers set status='accepted',responded_at=clock_timestamp(),booking_id=new.id where id=claim.id;
    perform private.close_class_waitlist_entry(claim.waitlist_id,'accepted','Cupo aceptado por el miembro.',new.member_user_id);
  end if;
  return new;
end; $$;
revoke all on function private.close_waitlist_after_reservation() from public,anon,authenticated,service_role;

create or replace function private.advance_waitlist_on_release() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op='DELETE' then
    if old.status in ('reserved','attended') then perform private.process_class_waitlist_queue(old.gym_id,old.class_schedule_id); end if;
    return old;
  end if;
  if old.status in ('reserved','attended') and new.status not in ('reserved','attended') then
    perform private.process_class_waitlist_queue(new.gym_id,new.class_schedule_id);
  end if;
  return new;
end; $$;
revoke all on function private.advance_waitlist_on_release() from public,anon,authenticated,service_role;
drop trigger if exists class_bookings_waitlist_release on public.class_bookings;
create trigger class_bookings_waitlist_release after update of status or delete on public.class_bookings
for each row execute function private.advance_waitlist_on_release();

create or replace function private.refresh_waitlist_on_session_change() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform private.process_class_waitlist_queue(new.gym_id,new.id);
  return new;
end; $$;
revoke all on function private.refresh_waitlist_on_session_change() from public,anon,authenticated,service_role;
drop trigger if exists class_schedules_refresh_waitlist on public.class_schedules;
create trigger class_schedules_refresh_waitlist after update of status,capacity_override,starts_at,extra_class_id,location_id on public.class_schedules
for each row execute function private.refresh_waitlist_on_session_change();

create or replace function public.join_class_waitlist_backend(
  target_gym_id uuid,target_class_schedule_id uuid,target_member_user_id uuid,target_actor_gym_user_id uuid
) returns table(waitlist_id uuid,waitlist_position bigint)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare cs public.class_schedules; entry public.class_waitlists; counts record;
begin
  perform private.require_waitlist_member(target_gym_id,target_actor_gym_user_id);
  if target_actor_gym_user_id is distinct from target_member_user_id then
    raise exception 'MEMBER_CAN_ONLY_JOIN_OWN_WAITLIST' using errcode='42501';
  end if;
  select * into cs from public.class_schedules where id=target_class_schedule_id and gym_id=target_gym_id for update;
  if not found or cs.status<>'scheduled' or cs.starts_at<=clock_timestamp() then
    raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode='23514';
  end if;
  if not exists(select 1 from public.extra_classes where id=cs.extra_class_id and gym_id=target_gym_id and is_active)
    or not exists(select 1 from public.gym_locations where id=cs.location_id and gym_id=target_gym_id and is_active) then
    raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode='23514';
  end if;
  perform private.class_member_coverage(target_gym_id,target_member_user_id,cs.starts_at);
  if not private.waitlist_member_eligible(target_gym_id,cs.id,target_member_user_id,cs.starts_at) then
    raise exception 'CLASS_WAITLIST_MEMBER_INELIGIBLE' using errcode='23514';
  end if;
  perform private.process_class_waitlist_queue(target_gym_id,cs.id);
  select * into entry from public.class_waitlists where gym_id=target_gym_id and class_schedule_id=cs.id
    and member_user_id=target_member_user_id and status in ('waiting','offered');
  if found then
    return query select entry.id,private.class_waitlist_position(entry.id);
    return;
  end if;
  select * into counts from private.class_waitlist_capacity(target_gym_id,cs.id);
  if counts.occupied+counts.offered_count<counts.capacity then
    raise exception 'CLASS_WAITLIST_NOT_NEEDED' using errcode='23514';
  end if;
  -- New episode, new timestamp and ID: never overwrite a declined/expired turn.
  insert into public.class_waitlists(gym_id,class_schedule_id,member_user_id,joined_at)
    values(target_gym_id,cs.id,target_member_user_id,clock_timestamp()) returning * into entry;
  return query select entry.id,private.class_waitlist_position(entry.id);
end; $$;
revoke all on function public.join_class_waitlist_backend(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.join_class_waitlist_backend(uuid,uuid,uuid,uuid) to service_role;

create or replace function public.leave_class_waitlist_backend(
  target_gym_id uuid,target_waitlist_id uuid,target_actor_gym_user_id uuid,supplied_reason text
) returns public.class_waitlists
language plpgsql security definer set search_path=pg_catalog,public as $$
declare entry public.class_waitlists; offer public.class_waitlist_offers; why text;
begin
  perform private.require_waitlist_member(target_gym_id,target_actor_gym_user_id);
  select * into entry from public.class_waitlists where id=target_waitlist_id and gym_id=target_gym_id
    and member_user_id=target_actor_gym_user_id;
  if not found then raise exception 'CLASS_WAITLIST_NOT_FOUND' using errcode='P0002'; end if;
  -- Session before queue/offer locks, matching every other mutation.
  perform 1 from public.class_schedules where id=entry.class_schedule_id and gym_id=target_gym_id for update;
  perform private.process_class_waitlist_queue(target_gym_id,entry.class_schedule_id);
  select * into entry from public.class_waitlists where id=target_waitlist_id for update;
  if entry.status not in ('waiting','offered') then return entry; end if;
  why:=left(coalesce(nullif(trim(supplied_reason),''),'Salida voluntaria de la lista.'),500);
  select * into offer from public.class_waitlist_offers where waitlist_id=entry.id and status='offered' for update;
  if found then
    update public.class_waitlist_offers set status='rejected',responded_at=clock_timestamp(),reason=why where id=offer.id;
    perform private.close_class_waitlist_entry(entry.id,'rejected',why,target_actor_gym_user_id);
  else perform private.close_class_waitlist_entry(entry.id,'voluntary',why,target_actor_gym_user_id);
  end if;
  perform private.process_class_waitlist_queue(target_gym_id,entry.class_schedule_id);
  select * into entry from public.class_waitlists where id=target_waitlist_id;
  return entry;
end; $$;
revoke all on function public.leave_class_waitlist_backend(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.leave_class_waitlist_backend(uuid,uuid,uuid,text) to service_role;

create or replace function public.accept_class_waitlist_offer_backend(
  target_gym_id uuid,target_offer_id uuid,target_actor_gym_user_id uuid
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare offer public.class_waitlist_offers; booking public.class_bookings; problem text;
begin
  perform private.require_waitlist_member(target_gym_id,target_actor_gym_user_id);
  select * into offer from public.class_waitlist_offers where id=target_offer_id and gym_id=target_gym_id
    and member_user_id=target_actor_gym_user_id;
  if not found then raise exception 'CLASS_WAITLIST_OFFER_NOT_FOUND' using errcode='P0002'; end if;
  if (select offers_enabled from private.class_waitlist_policy where singleton) is distinct from true then
    return jsonb_build_object('accepted',false,'code','CLASS_WAITLIST_OFFERS_DISABLED','server_time',clock_timestamp());
  end if;
  perform 1 from public.class_schedules where id=offer.class_schedule_id and gym_id=target_gym_id for update;
  perform private.process_class_waitlist_queue(target_gym_id,offer.class_schedule_id);
  select * into offer from public.class_waitlist_offers where id=target_offer_id for update;
  if offer.status='accepted' then
    return jsonb_build_object('accepted',true,'booking_id',offer.booking_id,'already_accepted',true,'server_time',clock_timestamp());
  end if;
  if offer.status<>'offered' or offer.expires_at<=clock_timestamp() then
    -- Return a functional failure, not an exception that would roll back the
    -- expiration/next offer. The HTTP layer will map accepted=false to 409.
    return jsonb_build_object('accepted',false,'code',case when offer.status='expired' then 'CLASS_WAITLIST_OFFER_EXPIRED'
      else 'CLASS_WAITLIST_OFFER_UNAVAILABLE' end,'server_time',clock_timestamp());
  end if;
  begin
    update public.class_waitlist_offers set status='accepting' where id=target_offer_id;
    booking:=public.reserve_member_class_backend(target_gym_id,offer.class_schedule_id,target_actor_gym_user_id,target_actor_gym_user_id);
    if not exists(select 1 from public.class_waitlist_offers where id=target_offer_id and status='accepted' and booking_id=booking.id) then
      raise exception 'CLASS_WAITLIST_ACCEPTANCE_INCOMPLETE';
    end if;
  exception when check_violation or unique_violation then
    problem:=sqlerrm;
    if problem not in ('CLASS_IS_NOT_AVAILABLE_FOR_BOOKING','CLASS_WAITLIST_PRIORITY_REQUIRED','CLASS_WAITLIST_OFFER_ACCEPT_REQUIRED',
      'CLASS_CAPACITY_REACHED','CLASS_BOOKING_ALREADY_EXISTS','CLASS_WAITLIST_OFFER_EXPIRED','CLASS_ACTIVE_MEMBERSHIP_COVERAGE_REQUIRED',
      'CLASS_BOOKING_REQUIRES_ACTIVE_MEMBER','CLASS_BOOKING_REQUIRES_RECEPTION','PAST_CLASS_CANNOT_BE_BOOKED','PAST_CLASS_CANNOT_BE_REBOOKED') then raise; end if;
    perform private.process_class_waitlist_queue(target_gym_id,offer.class_schedule_id);
    return jsonb_build_object('accepted',false,'code',problem,'server_time',clock_timestamp());
  end;
  perform private.process_class_waitlist_queue(target_gym_id,offer.class_schedule_id);
  return jsonb_build_object('accepted',true,'booking_id',booking.id,'already_accepted',false,'server_time',clock_timestamp());
end; $$;
revoke all on function public.accept_class_waitlist_offer_backend(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.accept_class_waitlist_offer_backend(uuid,uuid,uuid) to service_role;

create or replace function public.get_class_waitlist_state_backend(
  target_gym_id uuid,target_actor_gym_user_id uuid,target_schedule_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor public.gym_users; can_manage boolean; can_book boolean; can_attend boolean;
  cs public.class_schedules; counts record; rows jsonb:='[]'; queue jsonb; own_entry jsonb;
begin
  select * into actor from public.gym_users where id=target_actor_gym_user_id and gym_id=target_gym_id;
  if not found or actor.status<>'active' or actor.account_mode<>'portal' or actor.profile_id is null then
    raise exception 'CLASS_ACTOR_MUST_BE_ACTIVE_IN_GYM' using errcode='42501'; end if;
  if coalesce(cardinality(target_schedule_ids),0)>500 then raise exception 'CLASS_WAITLIST_TOO_MANY_SESSIONS' using errcode='22023'; end if;
  can_manage:=actor.role='owner' or exists(select 1 from public.staff_permissions where gym_id=target_gym_id
    and staff_user_id=actor.id and permission_key='classes.manage' and access_mode<>'denied');
  can_book:=actor.role='owner' or exists(select 1 from public.staff_permissions where gym_id=target_gym_id
    and staff_user_id=actor.id and permission_key='classes.bookings_manage' and access_mode<>'denied');
  can_attend:=exists(select 1 from public.staff_permissions where gym_id=target_gym_id
    and staff_user_id=actor.id and permission_key='classes.attendance_manage' and access_mode<>'denied');
  if actor.role not in ('owner','staff','member') or (actor.role='staff' and not(can_manage or can_book or can_attend)) then
    raise exception 'CLASS_PERMISSION_DENIED' using errcode='42501'; end if;
  for cs in select * from public.class_schedules where gym_id=target_gym_id and id=any(target_schedule_ids)
    and (actor.role<>'staff' or can_manage or can_book or instructor_user_id=actor.id) order by id loop
    perform private.process_class_waitlist_queue(target_gym_id,cs.id);
    select * into counts from private.class_waitlist_capacity(target_gym_id,cs.id);
    select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'member_user_id',w.member_user_id,'status',w.status,
      'state',w.state,'position',private.class_waitlist_position(w.id),'joined_at',w.joined_at,
      'offer_id',o.id,'offered_at',o.offered_at,'expires_at',o.expires_at) order by w.joined_at,w.id),'[]')
      into queue from public.class_waitlists w
      left join public.class_waitlist_offers o on o.waitlist_id=w.id and o.status='offered'
      where w.gym_id=target_gym_id and w.class_schedule_id=cs.id and w.status in ('waiting','offered')
        and (can_book or w.member_user_id=actor.id);
    select item into own_entry from jsonb_array_elements(queue) item where item->>'member_user_id'=actor.id::text limit 1;
    rows:=rows||jsonb_build_array(jsonb_build_object('class_schedule_id',cs.id,'capacity',counts.capacity,'occupied',counts.occupied,
      'offered_count',counts.offered_count,'available',greatest(0,counts.capacity-counts.occupied-counts.offered_count),
      'waitlist',queue,'myWaitlist',own_entry));
  end loop;
  return jsonb_build_object('server_time',clock_timestamp(),'offers_enabled',
    (select offers_enabled from private.class_waitlist_policy where singleton),'sessions',rows);
end; $$;
revoke all on function public.get_class_waitlist_state_backend(uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.get_class_waitlist_state_backend(uuid,uuid,uuid[]) to service_role;

create or replace function public.process_class_waitlists_backend(supplied_limit integer default 100) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare cs record; processed integer:=0; failures integer:=0;
begin
  if supplied_limit not between 1 and 500 or supplied_limit is null then raise exception 'CLASS_WAITLIST_BATCH_INVALID'; end if;
  if (select offers_enabled from private.class_waitlist_policy where singleton) is distinct from true then
    return jsonb_build_object('processed',0,'failures',0,'offers_enabled',false,'server_time',clock_timestamp());
  end if;
  -- Rotate full queues too, so an early full session cannot starve later queues.
  -- SKIP LOCKED never waits behind a reservation or another worker.
  for cs in select s.id,s.gym_id from public.class_schedules s
    left join private.class_waitlist_runs r on r.class_schedule_id=s.id
    where exists(select 1 from public.class_waitlists w where w.class_schedule_id=s.id and w.status in ('waiting','offered'))
    order by case when exists(select 1 from public.class_waitlist_offers due where due.class_schedule_id=s.id
      and due.status='offered' and due.expires_at<=clock_timestamp()) then 0 else 1 end,
      r.last_processed_at nulls first,s.id limit supplied_limit for update of s skip locked loop
    begin
      perform private.process_class_waitlist_queue(cs.gym_id,cs.id);
      processed:=processed+1;
    exception when others then
      failures:=failures+1;
      insert into private.class_waitlist_runs(class_schedule_id,last_processed_at,last_error)
        values(cs.id,clock_timestamp(),sqlstate) on conflict(class_schedule_id)
        do update set last_processed_at=excluded.last_processed_at,last_error=excluded.last_error;
      raise warning 'CLASS_WAITLIST_BATCH_SESSION_FAILED: %, SQLSTATE %',cs.id,sqlstate;
    end;
  end loop;
  return jsonb_build_object('processed',processed,'failures',failures,'server_time',clock_timestamp());
end; $$;
revoke all on function public.process_class_waitlists_backend(integer) from public,anon,authenticated;
grant execute on function public.process_class_waitlists_backend(integer) to service_role;

commit;
