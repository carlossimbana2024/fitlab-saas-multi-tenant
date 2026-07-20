begin;

-- Mantiene membresía y racha activas mientras exista cobertura hoy; en los
-- intervalos sin cobertura la racha se congela, nunca se reinicia.
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

create or replace function private.sync_streak_after_period_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    perform private.sync_membership_streak_state(old.membership_id);
    return old;
  end if;
  perform private.sync_membership_streak_state(new.membership_id);
  return new;
end;
$$;

revoke all on function private.sync_streak_after_period_change() from public, anon, authenticated;
create trigger membership_periods_sync_streak
after insert or update or delete on public.membership_periods
for each row execute function private.sync_streak_after_period_change();

create or replace function private.freeze_streak_after_membership_cancellation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.status <> 'cancelled' and new.status = 'cancelled' then
    perform private.sync_membership_streak_state(new.id);
  end if;
  return new;
end;
$$;

revoke all on function private.freeze_streak_after_membership_cancellation() from public, anon, authenticated;
create trigger memberships_freeze_cancelled_streak
after update of status on public.memberships
for each row execute function private.freeze_streak_after_membership_cancellation();

-- Registra el evento y mantiene el contador de asistencias inmediatamente. La
-- racha de cumplimiento se evalúa aparte, después de cerrar el día o la semana.
create or replace function private.process_attendance_streak_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  valid_attendance_count integer;
  newest_attendance_date date;
  weekly_target smallint;
  week_start date;
  week_end date;
  grace_week boolean;
  completed_count smallint;
begin
  if tg_op = 'INSERT' then
    insert into public.attendance_events(
      gym_id, attendance_id, event_type, performed_by, metadata
    ) values (
      new.gym_id, new.id, 'created', new.registered_by,
      jsonb_build_object('source', new.source, 'counts_toward_streak', new.counts_toward_streak)
    );
  elsif old.status = 'valid' and new.status = 'voided' then
    insert into public.attendance_events(
      gym_id, attendance_id, event_type, performed_by, metadata
    ) values (
      new.gym_id, new.id, 'voided', new.voided_by,
      jsonb_build_object('reason', new.void_reason)
    );
  else
    return new;
  end if;

  if new.counts_toward_streak then
    insert into public.user_streaks(gym_id, member_user_id)
    values (new.gym_id, new.member_user_id)
    on conflict (member_user_id) do nothing;

    perform 1 from public.user_streaks us
    where us.member_user_id = new.member_user_id
    for update;

    select count(*)::integer, max(a.attendance_date)
      into valid_attendance_count, newest_attendance_date
    from public.attendances a
    where a.member_user_id = new.member_user_id
      and a.status = 'valid'
      and a.counts_toward_streak;

    update public.user_streaks
    set last_attendance_date = newest_attendance_date
    where member_user_id = new.member_user_id;

    insert into public.streak_events(
      gym_id, member_user_id, membership_id, attendance_id, event_type,
      previous_value, new_value, effective_date, metadata
    ) values (
      new.gym_id, new.member_user_id, new.membership_id, new.id,
      case when new.status = 'voided' then 'attendance_voided' else 'attendance_recorded' end,
      null, null, new.attendance_date,
      jsonb_build_object('kind', 'attendance_record', 'total_valid_attendances', valid_attendance_count)
    );
  end if;

  select m.weekly_target_snapshot into weekly_target
  from public.memberships m
  where m.id = new.membership_id and m.attendance_mode_snapshot = 'weekly';

  if weekly_target is not null then
    week_start := new.attendance_date - (extract(isodow from new.attendance_date)::integer - 1);
    week_end := week_start + 6;
    grace_week := exists (
      select 1 from public.membership_periods mp
      where mp.membership_id = new.membership_id
        and mp.status = 'active'
        and mp.starts_on between week_start + 1 and week_end
    );

    select least(count(*), 7)::smallint into completed_count
    from public.attendances a
    where a.membership_id = new.membership_id
      and a.status = 'valid'
      and a.counts_toward_streak
      and a.attendance_date between week_start and week_end;

    insert into public.weekly_attendance_progress(
      gym_id, member_user_id, membership_id, week_starts_on, week_ends_on,
      target_attendances, completed_attendances, is_grace_week
    ) values (
      new.gym_id, new.member_user_id, new.membership_id, week_start, week_end,
      weekly_target, completed_count, grace_week
    )
    on conflict (membership_id, week_starts_on) do update
      set completed_attendances = excluded.completed_attendances,
          is_grace_week = excluded.is_grace_week;
  end if;

  return new;
end;
$$;

revoke all on function private.process_attendance_streak_change() from public, anon, authenticated;
create trigger attendances_process_streak
after insert or update of status on public.attendances
for each row execute function private.process_attendance_streak_change();

-- Resuelve el calendario efectivo de la sucursal habitual del miembro.
create or replace function private.member_day_mode(target_member_id uuid, target_date date)
returns public.calendar_day_mode
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with selected_location as (
    select coalesce(
      gu.default_location_id,
      (select gl.id from public.gym_locations gl
       where gl.gym_id = gu.gym_id and gl.is_main and gl.is_active limit 1)
    ) as location_id
    from public.gym_users gu where gu.id = target_member_id
  )
  select coalesce(lce.day_mode, loh.day_mode, 'closed'::public.calendar_day_mode)
  from selected_location sl
  left join public.location_calendar_exceptions lce
    on lce.location_id = sl.location_id and lce.calendar_date = target_date
  left join public.location_opening_hours loh
    on loh.location_id = sl.location_id
   and loh.weekday = extract(isodow from target_date)::smallint
$$;

revoke all on function private.member_day_mode(uuid, date) from public, anon, authenticated;

-- Se llama una vez al día para la fecha ya terminada en cada gimnasio. Es
-- idempotente: cada miembro y fecha se evalúan una sola vez.
create or replace function public.run_streak_evaluation(evaluation_date date)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  item record;
  streak_record record;
  attended boolean;
  previous_value integer;
begin
  if evaluation_date is null then
    raise exception 'EVALUATION_DATE_REQUIRED' using errcode = '22004';
  end if;

  for item in
    select distinct m.id as membership_id, m.gym_id, m.member_user_id,
           m.attendance_mode_snapshot, m.weekly_target_snapshot, g.timezone
    from public.memberships m
    join public.gyms g on g.id = m.gym_id
    join public.membership_periods mp on mp.membership_id = m.id
    where mp.status = 'active'
      and evaluation_date between mp.starts_on and mp.ends_on
  loop
    if evaluation_date >= (now() at time zone item.timezone)::date then
      continue;
    end if;

    perform private.sync_membership_streak_state(item.membership_id);

    insert into public.user_streaks(gym_id, member_user_id)
    values (item.gym_id, item.member_user_id)
    on conflict (member_user_id) do nothing;

    select * into streak_record from public.user_streaks us
    where us.member_user_id = item.member_user_id for update;

    if item.attendance_mode_snapshot = 'daily'
       and private.member_day_mode(item.member_user_id, evaluation_date) = 'required'
       and exists (
         select 1 from public.streak_events se
         where se.member_user_id = item.member_user_id
           and se.effective_date > evaluation_date
           and se.metadata ->> 'kind' = 'daily_compliance'
       ) then
      raise exception 'STREAK_EVALUATION_MUST_BE_CHRONOLOGICAL' using errcode = '23514';
    end if;

    if item.attendance_mode_snapshot = 'daily'
       and private.member_day_mode(item.member_user_id, evaluation_date) = 'required'
       and not exists (
         select 1 from public.streak_events se
         where se.member_user_id = item.member_user_id
           and se.effective_date = evaluation_date
           and se.metadata ->> 'kind' = 'daily_compliance'
       ) then
      attended := exists (
        select 1 from public.attendances a
        where a.member_user_id = item.member_user_id
          and a.attendance_date = evaluation_date
          and a.status = 'valid' and a.counts_toward_streak
      );
      previous_value := streak_record.current_streak;

      update public.user_streaks
      set current_streak = case when attended then previous_value + 1 else 0 end,
          longest_streak = greatest(
            longest_streak,
            case when attended then previous_value + 1 else 0 end
          )
      where member_user_id = item.member_user_id;

      insert into public.streak_events(
        gym_id, member_user_id, membership_id, event_type,
        previous_value, new_value, effective_date, metadata
      ) values (
        item.gym_id, item.member_user_id, item.membership_id,
        case when attended then 'incremented' else 'reset' end,
        previous_value, case when attended then previous_value + 1 else 0 end,
        evaluation_date, jsonb_build_object('kind', 'daily_compliance')
      );
    end if;

    if item.attendance_mode_snapshot = 'weekly'
       and extract(isodow from evaluation_date) = 7
       and exists (
         select 1 from public.streak_events se
         where se.member_user_id = item.member_user_id
           and se.effective_date > evaluation_date
           and se.metadata ->> 'kind' = 'weekly_compliance'
       ) then
      raise exception 'STREAK_EVALUATION_MUST_BE_CHRONOLOGICAL' using errcode = '23514';
    end if;

    if item.attendance_mode_snapshot = 'weekly'
       and extract(isodow from evaluation_date) = 7
       and not exists (
         select 1 from public.streak_events se
         where se.member_user_id = item.member_user_id
           and se.effective_date = evaluation_date
           and se.metadata ->> 'kind' = 'weekly_compliance'
       ) then
      select * into streak_record
      from public.weekly_attendance_progress wap
      where wap.membership_id = item.membership_id
        and wap.week_starts_on = evaluation_date - 6;

      -- Si no hubo asistencias, se crea igualmente el progreso de la semana.
      if streak_record.id is null then
        insert into public.weekly_attendance_progress(
          gym_id, member_user_id, membership_id, week_starts_on, week_ends_on,
          target_attendances, completed_attendances, is_grace_week
        ) values (
          item.gym_id, item.member_user_id, item.membership_id,
          evaluation_date - 6, evaluation_date, item.weekly_target_snapshot, 0,
          exists (
            select 1 from public.membership_periods mp
            where mp.membership_id = item.membership_id and mp.status = 'active'
              and mp.starts_on between evaluation_date - 5 and evaluation_date
          )
        ) returning * into streak_record;
      end if;

      select us.current_streak into previous_value
      from public.user_streaks us where us.member_user_id = item.member_user_id;

      if not streak_record.is_grace_week then
        update public.user_streaks
        set current_streak = case when streak_record.goal_met then previous_value + 1 else 0 end,
            longest_streak = greatest(
              longest_streak,
              case when streak_record.goal_met then previous_value + 1 else 0 end
            )
        where member_user_id = item.member_user_id;
      end if;

      update public.weekly_attendance_progress
      set evaluated_at = now()
      where id = streak_record.id;

      insert into public.streak_events(
        gym_id, member_user_id, membership_id, event_type,
        previous_value, new_value, effective_date, metadata
      ) values (
        item.gym_id, item.member_user_id, item.membership_id,
        case
          when streak_record.is_grace_week then 'grace_week'
          when streak_record.goal_met then 'weekly_goal_completed'
          else 'reset'
        end,
        previous_value,
        case
          when streak_record.is_grace_week then previous_value
          when streak_record.goal_met then previous_value + 1
          else 0
        end,
        evaluation_date,
        jsonb_build_object(
          'kind', 'weekly_compliance',
          'grace_week', streak_record.is_grace_week,
          'goal_met', streak_record.goal_met
        )
      );
    end if;
  end loop;

  -- También sincroniza membresías cuyo último periodo terminó antes de la fecha.
  for item in select id from public.memberships where status in ('pending', 'active', 'paused', 'expired') loop
    perform private.sync_membership_streak_state(item.id);
  end loop;
end;
$$;

revoke all on function public.run_streak_evaluation(date) from public, anon, authenticated;
grant execute on function public.run_streak_evaluation(date) to service_role;

comment on function public.run_streak_evaluation(date) is
  'Backend-only. Evaluar diariamente la fecha anterior según la zona horaria de cada gimnasio.';

commit;
