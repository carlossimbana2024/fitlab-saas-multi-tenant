begin;
set local lock_timeout = '5s';

-- FIT-MEMBER-002: protect every booking/waitlist writer, including backend RPCs.
-- No existing rows are updated. Deactivation is not session cancellation.
create function private.guard_new_class_participation()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  schedule_record public.class_schedules%rowtype;
  activity_active boolean;
  location_active boolean;
begin
  if tg_table_name = 'class_bookings' then
    if new.status::text <> 'reserved' then return new; end if;
    if tg_op = 'UPDATE' then
      if old.status::text in ('reserved', 'attended')
         and old.gym_id = new.gym_id and old.class_schedule_id = new.class_schedule_id
         and old.member_user_id = new.member_user_id then return new; end if;
    end if;
  else
    if new.status::text not in ('waiting', 'offered') then return new; end if;
    if tg_op = 'UPDATE' then
      if old.status::text in ('waiting', 'offered')
         and old.gym_id = new.gym_id and old.class_schedule_id = new.class_schedule_id
         and old.member_user_id = new.member_user_id then return new; end if;
    end if;
  end if;

  -- Serialize against schedule changes, then against administrative deactivation.
  -- SHARE (not KEY SHARE) conflicts with updates to is_active.
  select * into schedule_record from public.class_schedules
  where id = new.class_schedule_id and gym_id = new.gym_id for update;
  if not found then
    raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode = '23514';
  end if;
  select is_active into activity_active from public.extra_classes
  where id = schedule_record.extra_class_id and gym_id = new.gym_id for share;
  if activity_active is distinct from true then
    raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode = '23514';
  end if;
  select is_active into location_active from public.gym_locations
  where id = schedule_record.location_id and gym_id = new.gym_id for share;
  if location_active is distinct from true then
    raise exception 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_new_class_participation() from public, anon, authenticated;

create trigger class_bookings_active_references
before insert or update on public.class_bookings
for each row execute function private.guard_new_class_participation();
create trigger class_waitlists_active_references
before insert or update on public.class_waitlists
for each row execute function private.guard_new_class_participation();

commit;
