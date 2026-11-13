begin;
set local lock_timeout='5s';

-- FIT-MEMBER-020: additive preparation. Legacy counters, monthly rankings,
-- attendance validity, financial history and all existing crons are untouched.
-- Explicit evidence is required to resolve ambiguous reversals. No automatic
-- classification of refunded/voided payments and no inference from free text.
create table private.member_streak_coverage_resolutions (
  period_id uuid primary key references public.membership_periods(id),
  disposition text not null check(disposition in ('legitimate','retroactively_invalid')),
  effective_end_on date,
  evidence_reference text not null check(length(btrim(evidence_reference)) between 5 and 2000),
  recorded_by text not null default current_user,
  recorded_at timestamptz not null default now(),
  check((disposition='legitimate' and effective_end_on is not null)
    or (disposition='retroactively_invalid' and effective_end_on is null))
);
alter table private.member_streak_coverage_resolutions enable row level security;
revoke all on private.member_streak_coverage_resolutions from public,anon,authenticated,service_role;

create function private.validate_member_streak_resolution()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.disposition='legitimate' and not exists(
    select 1 from public.membership_periods p where p.id=new.period_id
      and new.effective_end_on between p.starts_on-1 and p.ends_on
  ) then raise exception 'STREAK_RESOLUTION_CANNOT_EXTEND_COVERAGE' using errcode='23514';end if;
  return new;
end;$$;
create trigger member_streak_resolution_bounds before insert or update
  on private.member_streak_coverage_resolutions for each row
  execute function private.validate_member_streak_resolution();

-- Internal, read-only reconstruction input. Dates in this function are civil
-- dates in gyms.timezone, never browser dates or 24-hour duration arithmetic.
create function private.member_streak_coverage(g uuid, member_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'periodId',p.id,'membershipId',m.id,'startsOn',p.starts_on,'endsOn',p.ends_on,
    'mode',m.attendance_mode_snapshot,'target',m.weekly_target_snapshot,
    'cancelOn',case when r.disposition='legitimate' then least(r.effective_end_on+1,
        case when normal.proven then (m.cancelled_at at time zone gym.timezone)::date end)
      when normal.proven then (m.cancelled_at at time zone gym.timezone)::date end,
    'classification',case
      when r.disposition='retroactively_invalid' then 'invalid'
      when exists(select 1 from public.weekly_attendance_progress w
        where w.gym_id=g and w.membership_id=m.id
          and w.target_attendances is distinct from m.weekly_target_snapshot) then 'ambiguous'
      when r.disposition='legitimate' then 'valid'
      when pay.status in ('voided','refunded') then 'ambiguous'
      when p.payment_id is not null and (pay.id is null or pay.status<>'confirmed') then 'ambiguous'
      when p.status='active' and m.status<>'cancelled' then 'valid'
      when normal.proven and (p.status='active' or p.status='cancelled') then 'valid'
      else 'ambiguous' end
  ) order by p.starts_on,p.id),'[]'::jsonb)
  from public.membership_periods p
  join public.memberships m on m.id=p.membership_id and m.gym_id=p.gym_id
  join public.gyms gym on gym.id=p.gym_id
  left join public.member_payments pay on pay.id=p.payment_id and pay.gym_id=p.gym_id
  left join private.member_streak_coverage_resolutions r on r.period_id=p.id
  cross join lateral (select m.cancelled_at is not null and exists(
    select 1 from public.audit_logs a where a.gym_id=g and a.entity_type='membership'
      and a.entity_id=m.id and a.action='membership.cancelled'
      and a.before_data->>'status' in ('active','paused','expired')
      and a.after_data->>'history_preserved'='true'
      and a.after_data->>'payments_unchanged'='true'
      and a.after_data->>'cancelled_at'=(to_jsonb(m.cancelled_at)#>>'{}')
  ) proven) normal
  where p.gym_id=g and m.member_user_id=member_id;
$$;

-- Pure evaluator: repeat calls return the same values, never increment a stored
-- counter. Re-evaluates closed weeks after late/voided attendance or corrections.
create function private.evaluate_member_streaks(today date, coverage jsonb, attendance jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare
  d date; first_day date; p record; a record; week_start date;
  current_week integer:=0; best_week integer:=0; daily_current integer:=0; daily_best integer:=0;
  daily_run integer:=0; last_day date; reset_pending boolean:=false;
  day_contract text; week_contract text; day_target integer; week_target integer;
  eligible_days integer:=0; day_count integer; grace boolean:=false;
  week_attendances integer:=0; unknown_history boolean:=false;
  history jsonb:='[]'; ambiguous jsonb:='[]'; state text;
begin
  if today is null or not isfinite(today) or coverage is null or attendance is null
    or jsonb_typeof(coverage)<>'array' or jsonb_typeof(attendance)<>'array' then
    raise exception 'INVALID_STREAK_INPUT' using errcode='22023';
  end if;
  -- attendance supplied here has already passed the authoritative status check.
  for a in select distinct (x->>'date')::date as civil_date from jsonb_array_elements(attendance) x
    where (x->>'date')::date<=today order by civil_date loop
    daily_run:=case when last_day=a.civil_date-1 then daily_run+1 else 1 end;
    daily_best:=greatest(daily_best,daily_run);last_day:=a.civil_date;
  end loop;
  if last_day>=today-1 then daily_current:=daily_run;end if;

  select coalesce(jsonb_agg(x->'periodId'),'[]'::jsonb) into ambiguous
    from jsonb_array_elements(coverage) x
    where x->>'classification'='ambiguous' and (x->>'startsOn')::date<=today;
  unknown_history:=jsonb_array_length(ambiguous)>0;
  select min((x->>'startsOn')::date) into first_day from jsonb_array_elements(coverage) x
    where x->>'classification'='valid' and (x->>'startsOn')::date<=today;
  if first_day is not null then
    first_day:=first_day-(extract(isodow from first_day)::integer-1);
    for d in select first_day+n from generate_series(0,today-first_day) n loop
      if extract(isodow from d)=1 then
        week_start:=d;week_contract:=null;week_target:=null;
        eligible_days:=0;week_attendances:=0;grace:=false;
      end if;
      day_contract:=null;day_target:=null;day_count:=0;
      for p in select x from jsonb_array_elements(coverage) x
        where x->>'classification'='valid' and d between (x->>'startsOn')::date and (x->>'endsOn')::date
          and (x->>'cancelOn' is null or d<(x->>'cancelOn')::date) loop
        -- Same-contract adjoining/overlapping renewal is one daily contract.
        if day_contract is not null and day_contract<>p.x->>'membershipId' then
          unknown_history:=true;
          select coalesce(jsonb_agg(distinct id),'[]'::jsonb) into ambiguous from (
            select value as id from jsonb_array_elements(ambiguous)
            union all select x->'periodId' from jsonb_array_elements(coverage) x
              where x->>'classification'='valid'
                and d between (x->>'startsOn')::date and (x->>'endsOn')::date
                and (x->>'cancelOn' is null or d<(x->>'cancelOn')::date)
          ) unresolved;
        end if;
        day_contract:=p.x->>'membershipId';
        day_target:=case when p.x->>'mode'='weekly' then (p.x->>'target')::integer end;
        day_count:=day_count+1;
      end loop;
      if day_target is null or day_target not between 1 and 7 then
        reset_pending:=true;
      else
        if reset_pending then current_week:=0;reset_pending:=false;end if;
        eligible_days:=eligible_days+1;
        if week_contract is not null and (week_contract<>day_contract or week_target<>day_target) then grace:=true;end if;
        week_contract:=day_contract;week_target:=day_target;
        if exists(select 1 from jsonb_array_elements(attendance) x where (x->>'date')::date=d
          and x->>'membershipId'=day_contract and x->>'eligible'='true') then
          week_attendances:=week_attendances+1;
        end if;
      end if;
      -- Partial start/end or a change within this civil week is grace. A weekly
      -- closed-day count cannot accidentally include a partial contractual week.
      if exists(select 1 from jsonb_array_elements(coverage) x where x->>'classification'='valid'
        and ((x->>'startsOn')::date=d and extract(isodow from d)<>1
          or (x->>'cancelOn')::date=d)) then grace:=true;end if;
      if extract(isodow from d)=7 and d<today then
        state:=case when eligible_days=0 then 'not_evaluable'
          when grace or eligible_days<>7 then 'grace'
          when week_attendances>=week_target then 'met' else 'missed' end;
        if state='met' then current_week:=current_week+1;best_week:=greatest(best_week,current_week);
        elsif state='missed' then current_week:=0;end if;
        history:=history||jsonb_build_array(jsonb_build_object('startsOn',week_start,'state',state,
          'target',week_target,'eligibleAttendances',week_attendances));
      end if;
    end loop;
  end if;
  return jsonb_build_object('weeklyCurrentStreak',case when not unknown_history then current_week end,
    'weeklyBestStreak',case when not unknown_history then best_week end,
    'dailyCurrentStreak',daily_current,'dailyBestStreak',daily_best,
    'weeklyStatus',case when unknown_history then 'needs_review' when reset_pending or first_day is null then 'not_evaluable' else 'available' end,
    'ambiguousPeriodIds',ambiguous,'weeks',history,'today',today);
end;$$;

create function private.member_personal_streaks(g uuid, member_id uuid, instant timestamptz)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select private.evaluate_member_streaks((instant at time zone gym.timezone)::date,
    private.member_streak_coverage(g,member_id),
    coalesce((select jsonb_agg(jsonb_build_object('date',a.attendance_date,
      'membershipId',a.membership_id,'eligible',a.counts_toward_streak))
      from public.attendances a where a.gym_id=g and a.member_user_id=member_id and a.status='valid'),'[]'::jsonb))
    from public.gyms gym where gym.id=g;
$$;

create function public.get_member_personal_streaks_backend(target_gym_id uuid,actor_member_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  perform private.require_member_aggregate_reader(target_gym_id,actor_member_user_id);
  return private.member_personal_streaks(target_gym_id,actor_member_user_id,now())-'weeks'-'ambiguousPeriodIds';
end;$$;

revoke all on function private.member_streak_coverage(uuid,uuid),
  private.validate_member_streak_resolution(),
  private.evaluate_member_streaks(date,jsonb,jsonb),
  private.member_personal_streaks(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.get_member_personal_streaks_backend(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_member_personal_streaks_backend(uuid,uuid) to service_role;
commit;
