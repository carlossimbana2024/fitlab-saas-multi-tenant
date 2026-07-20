begin;

-- Corrige la inferencia de tipo del CASE usado al crear la racha. PostgreSQL
-- resuelve ambas ramas como text y requiere una conversión explícita al enum.
create or replace function private.sync_membership_streak_state(target_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  membership_record record;
  gym_today date;
  has_coverage boolean;
  has_finished_coverage boolean;
  previous_streak_status public.streak_status;
begin
  select m.gym_id, m.member_user_id, m.status as membership_status, g.timezone
    into membership_record
  from public.memberships m
  join public.gyms g on g.id = m.gym_id
  where m.id = target_membership_id;

  if membership_record.gym_id is null then
    return;
  end if;

  gym_today := (now() at time zone membership_record.timezone)::date;
  has_coverage := membership_record.membership_status <> 'cancelled' and exists (
    select 1 from public.membership_periods mp
    where mp.membership_id = target_membership_id
      and mp.status = 'active'
      and gym_today between mp.starts_on and mp.ends_on
  );
  has_finished_coverage := exists (
    select 1 from public.membership_periods mp
    where mp.membership_id = target_membership_id
      and mp.status <> 'cancelled'
      and mp.ends_on < gym_today
  );

  insert into public.user_streaks(gym_id, member_user_id, status, frozen_at)
  values (
    membership_record.gym_id,
    membership_record.member_user_id,
    (case when has_coverage then 'active' else 'frozen' end)::public.streak_status,
    case when has_coverage then null else now() end
  )
  on conflict (member_user_id) do nothing;

  select us.status into previous_streak_status
  from public.user_streaks us
  where us.member_user_id = membership_record.member_user_id
  for update;

  if has_coverage then
    update public.memberships
    set status = 'active'
    where id = target_membership_id and status in ('pending', 'paused', 'expired');
  else
    update public.memberships
    set status = (case when has_finished_coverage then 'expired' else 'paused' end)::public.membership_status
    where id = target_membership_id and status = 'active';
  end if;

  if has_coverage and previous_streak_status = 'frozen' then
    update public.user_streaks
    set status = 'active', frozen_at = null
    where member_user_id = membership_record.member_user_id;

    insert into public.streak_events(
      gym_id, member_user_id, membership_id, event_type,
      previous_value, new_value, effective_date, metadata
    ) values (
      membership_record.gym_id, membership_record.member_user_id,
      target_membership_id, 'resumed', null, null, gym_today,
      jsonb_build_object('kind', 'coverage_state')
    );
  elsif not has_coverage and previous_streak_status = 'active' then
    update public.user_streaks
    set status = 'frozen', frozen_at = now()
    where member_user_id = membership_record.member_user_id;

    insert into public.streak_events(
      gym_id, member_user_id, membership_id, event_type,
      previous_value, new_value, effective_date, metadata
    ) values (
      membership_record.gym_id, membership_record.member_user_id,
      target_membership_id, 'frozen', null, null, gym_today,
      jsonb_build_object('kind', 'coverage_state')
    );
  end if;
end;
$$;

revoke all on function private.sync_membership_streak_state(uuid) from public, anon, authenticated;

commit;
