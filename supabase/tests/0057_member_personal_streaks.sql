-- LOCAL ONLY. Temporary functions and fixtures; never run in production.
begin;
create function pg_temp.assert_streak(value jsonb, key text, expected jsonb) returns void
language plpgsql as $$begin
  if value->key is distinct from expected then raise exception 'STREAK_ASSERT % expected %, got %',key,expected,value;end if;
end;$$;
do $$
declare c jsonb; a jsonb; r jsonb; r2 jsonb; n integer; z text;
begin
  c:='[{"periodId":"p","membershipId":"m","startsOn":"2026-10-05","endsOn":"2026-12-31","mode":"weekly","target":3,"classification":"valid"}]';
  select jsonb_agg(jsonb_build_object('date',('2026-10-05'::date+offset_days),'membershipId','m','eligible',true)) into a
    from generate_series(0,20) offset_days where offset_days%7<3;
  r:=private.evaluate_member_streaks('2026-10-26',c,a);
  perform pg_temp.assert_streak(r,'weeklyCurrentStreak','3');
  perform pg_temp.assert_streak(r,'weeklyBestStreak','3');
  perform pg_temp.assert_streak(r,'dailyBestStreak','3');
  perform pg_temp.assert_streak(r,'dailyCurrentStreak','0');
  -- SW1-6: >=target, missed week, open week, no duplicate increments.
  r2:=private.evaluate_member_streaks('2026-10-26',c,a);
  if r<>r2 then raise exception 'NOT_IDEMPOTENT';end if;
  perform pg_temp.assert_streak(private.evaluate_member_streaks('2026-10-28',c,a),'weeklyCurrentStreak','3');
  perform pg_temp.assert_streak(private.evaluate_member_streaks('2026-11-02',c,a),'weeklyCurrentStreak','0');
  perform pg_temp.assert_streak(private.evaluate_member_streaks('2026-11-02',c,a),'weeklyBestStreak','3');
  perform pg_temp.assert_streak(private.evaluate_member_streaks('2026-10-12',jsonb_set(c,'{0,target}','4'),a),'weeklyCurrentStreak','0');
  perform pg_temp.assert_streak(private.evaluate_member_streaks('2026-10-12',jsonb_set(c,'{0,target}','2'),a),'weeklyCurrentStreak','1');
  -- H1/H2: three legitimate weeks retained, cancellation week is grace.
  c:=jsonb_set(c,'{0,cancelOn}','"2026-10-28"');
  r:=private.evaluate_member_streaks('2026-11-02',c,a);
  perform pg_temp.assert_streak(r,'weeklyBestStreak','3');
  perform pg_temp.assert_streak(r,'weeklyCurrentStreak','3');
  if r#>>'{weeks,3,state}'<>'grace' then raise exception 'CANCELLATION_WEEK';end if;
  -- H3: explicit legitimate commercial refund uses the same bounded coverage.
  perform pg_temp.assert_streak(private.evaluate_member_streaks('2026-11-09',c,a),'weeklyBestStreak','3');
  -- H4: explicit retroactive invalidation excludes history; daily uses validity.
  r:=private.evaluate_member_streaks('2026-11-02',jsonb_set(c,'{0,classification}','"invalid"'),a);
  perform pg_temp.assert_streak(r,'weeklyBestStreak','0');
  perform pg_temp.assert_streak(r,'dailyBestStreak','3');
  -- H5/H7: ambiguity never becomes a false confirmed zero or a fabricated record.
  r:=private.evaluate_member_streaks('2026-11-02',jsonb_set(c,'{0,classification}','"ambiguous"'),a);
  perform pg_temp.assert_streak(r,'weeklyBestStreak','null');
  perform pg_temp.assert_streak(r,'weeklyCurrentStreak','null');
  perform pg_temp.assert_streak(r,'weeklyStatus','"needs_review"');
  perform pg_temp.assert_streak(r,'ambiguousPeriodIds','["p"]');
  -- H6/SW9/SW10: returning after a gap starts at zero, keeps best.
  c:=c||'[{"periodId":"q","membershipId":"new","startsOn":"2026-11-02","endsOn":"2026-12-31","mode":"weekly","target":3,"classification":"valid"}]';
  r:=private.evaluate_member_streaks('2026-11-03',c,a);
  perform pg_temp.assert_streak(r,'weeklyCurrentStreak','0');
  perform pg_temp.assert_streak(r,'weeklyBestStreak','3');
  -- Contiguous midweek weekly contract change: grace, no broken continuity.
  c:=jsonb_set(c,'{0,cancelOn}','"2026-10-28"');
  c:=jsonb_set(c,'{1,startsOn}','"2026-10-28"');
  r:=private.evaluate_member_streaks('2026-11-02',c,a);
  perform pg_temp.assert_streak(r,'weeklyCurrentStreak','3');
  if r#>>'{weeks,3,state}'<>'grace' then raise exception 'CONTRACT_CHANGE_GRACE';end if;
  -- Daily interval cannot add weekly units; return resets even within one week.
  c:=jsonb_set(c,'{1,mode}','"daily"');
  r:=private.evaluate_member_streaks('2026-11-02',c,a);
  perform pg_temp.assert_streak(r,'weeklyCurrentStreak','3');
  perform pg_temp.assert_streak(r,'weeklyStatus','"not_evaluable"');
  c:=jsonb_set(c,'{1,endsOn}','"2026-11-03"')||'[{"periodId":"r","membershipId":"last","startsOn":"2026-11-04","endsOn":"2026-12-31","mode":"weekly","target":3,"classification":"valid"}]';
  perform pg_temp.assert_streak(private.evaluate_member_streaks('2026-11-05',c,a),'weeklyCurrentStreak','0');
  -- D1-9: civil consecutive dates, duplicates, gaps, month/year boundary.
  for n in 1..10 loop
    select jsonb_agg(jsonb_build_object('date','2026-12-27'::date+i,'eligible',false)) into a from generate_series(0,n-1) i;
    r:=private.evaluate_member_streaks('2026-12-27'::date+n-1,'[]',a||a);
    perform pg_temp.assert_streak(r,'dailyCurrentStreak',to_jsonb(n));
    perform pg_temp.assert_streak(r,'dailyBestStreak',to_jsonb(n));
    perform pg_temp.assert_streak(r,'weeklyCurrentStreak','0');
    perform pg_temp.assert_streak(private.evaluate_member_streaks('2026-12-27'::date+n,'[]',a),'dailyCurrentStreak',to_jsonb(n));
    perform pg_temp.assert_streak(private.evaluate_member_streaks('2026-12-27'::date+n+1,'[]',a),'dailyCurrentStreak','0');
  end loop;
  a:=a||'[{"date":"2027-01-08","eligible":true}]';
  r:=private.evaluate_member_streaks('2027-01-08','[]',a);
  perform pg_temp.assert_streak(r,'dailyCurrentStreak','1');
  perform pg_temp.assert_streak(r,'dailyBestStreak','10');
  -- DST: evaluator receives civil dates, no elapsed-24-hours calculation.
  foreach z in array array['America/Guayaquil','America/New_York'] loop
    r:=private.evaluate_member_streaks(('2026-03-09 05:00Z'::timestamptz at time zone z)::date,
      '[]','[{"date":"2026-03-07"},{"date":"2026-03-08"}]');
    perform pg_temp.assert_streak(r,'dailyCurrentStreak','2');
    r:=private.evaluate_member_streaks(('2026-11-02 05:30Z'::timestamptz at time zone z)::date,
      '[]','[{"date":"2026-10-31"},{"date":"2026-11-01"}]');
    perform pg_temp.assert_streak(r,'dailyCurrentStreak','2');
  end loop;
  -- X1: weekly and daily units are simultaneously different, never mixed.
  c:='[{"periodId":"p","membershipId":"m","startsOn":"2026-10-05","endsOn":"2026-12-31","mode":"weekly","target":3,"classification":"valid"}]';
  select jsonb_agg(jsonb_build_object('date','2026-10-05'::date+i,'membershipId','m','eligible',true)) into a
    from generate_series(0,27) i where i%7<3;
  a:=a||'[{"date":"2026-11-02","membershipId":"m","eligible":true},{"date":"2026-11-03","membershipId":"m","eligible":true}]';
  r:=private.evaluate_member_streaks('2026-11-03',c,a);
  perform pg_temp.assert_streak(r,'weeklyCurrentStreak','4');
  perform pg_temp.assert_streak(r,'dailyCurrentStreak','2');
  r:=private.evaluate_member_streaks('2026-11-03',c||jsonb_set(jsonb_set(c,'{0,membershipId}','"other"'),'{0,periodId}','"q"'),a);
  perform pg_temp.assert_streak(r,'weeklyStatus','"needs_review"');
  if jsonb_array_length(r->'ambiguousPeriodIds')<>2 then raise exception 'OVERLAP_PERIOD_IMPACT';end if;
end;$$;
select '0057 pure evaluator OK: weekly/daily, H1-H7, grace, gaps, midnight, DST, idempotence' result;
rollback;
