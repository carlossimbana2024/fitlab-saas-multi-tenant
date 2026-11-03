-- Safe in Supabase SQL Editor: READ ONLY, no fixtures or activation.
begin read only;
do $$
declare c record; actual numeric; m jsonb; f record; n integer:=0;
begin
  for c in select * from (values
    ('lose_weight',80::numeric,90::numeric,85::numeric,50::numeric),
    ('lose_weight',80,90,80,100),('lose_weight',80,90,75,100),
    ('lose_weight',80,90,95,0),('gain_weight',70,60,65,50),
    ('gain_weight',70,60,58,0),('gain_weight',70,60,75,100),
    ('build_muscle',70,60,65,50),('gain_weight',63,60,61,33.3),
    ('lose_weight',80,90,90,0),('lose_weight',85,85,95,null),
    ('gain_weight',85,85,85,null),('lose_weight',80,null,85,null),
    ('lose_weight',80,90,null,null),('lose_weight',null,90,85,null),
    ('lose_weight',80,90,'NaN'::numeric,null),('lose_weight',80,90,'Infinity'::numeric,null),
    ('lose_weight',80,-90,85,null),('gain_weight',700,60,65,null),
    ('improve_fitness',80,90,85,null),('general_wellness',80,90,85,null),
    ('maintain_weight',85,85,85,null),('maintain_weight',85,85,95,null),
    ('maintain_weight',85,90,86.2,null),('maintain_weight',85,90,84.2,null)
  ) v(goal,target,baseline,current_weight,expected) loop
    actual:=private.member_community_goal_percent(c.goal,c.target,c.baseline,c.current_weight);
    if actual is distinct from c.expected then raise exception 'METRIC_CASE_FAILED: % got %',c,actual;end if;
    actual:=private.member_monthly_goal_percent(c.goal,c.target,c.baseline,c.current_weight);
    if actual is distinct from (case when c.expected>0 then c.expected end) then
      raise exception 'MONTHLY_CASE_FAILED: % got %',c,actual;end if;
  end loop;
  foreach actual in array array[85::numeric,86.2,84.2,95] loop
    m:=private.member_weight_goal_metric('maintain_weight',85,85,actual);
    if m->>'progressPercent' is not null
      or (m#>>'{maintenance,currentWeightKg}')::numeric is distinct from actual
      or (m#>>'{maintenance,targetWeightKg}')::numeric is distinct from 85::numeric
      or (m#>>'{maintenance,differenceKg}')::numeric is distinct from actual-85 then
      raise exception 'MAINTENANCE_DIFFERENCE: %',m;end if;
  end loop;
  if private.member_weight_goal_metric('maintain_weight',85,null,null)->>'maintenance' is not null then
    raise exception 'MISSING_HISTORY';end if;
  for f in select oid,proname,prosecdef,proconfig from pg_proc
    where pronamespace='public'::regnamespace and proname in
    ('get_member_attendance_summary_backend','get_member_community_rankings_backend','list_member_community_page_backend') loop
    n:=n+1;
    if has_function_privilege('anon',f.oid,'EXECUTE') or has_function_privilege('authenticated',f.oid,'EXECUTE')
      or not has_function_privilege('service_role',f.oid,'EXECUTE') or not f.prosecdef
      or not ('search_path=pg_catalog, public'=any(f.proconfig)) then raise exception 'RPC_SECURITY: %',f.proname;end if;
  end loop;
  if n<>3 then raise exception 'RPC_COUNT';end if;
  n:=0;
  for f in select oid,proname,proconfig from pg_proc where pronamespace='private'::regnamespace and proname in
    ('member_weight_goal_metric','member_historical_weight_goal','member_community_goal_percent','member_monthly_goal_percent') loop
    n:=n+1;
    if has_function_privilege('anon',f.oid,'EXECUTE') or has_function_privilege('authenticated',f.oid,'EXECUTE')
      or has_function_privilege('service_role',f.oid,'EXECUTE')
      or not (f.proconfig @> array['search_path=pg_catalog'] or f.proconfig @> array['search_path=pg_catalog, public']) then
      raise exception 'HELPER_SECURITY: %',f.proname;end if;
  end loop;
  if n<>4 then raise exception 'HELPER_COUNT';end if;
end;$$;
select '0055 OK: canonical metric, maintenance without percentage, monthly exclusion, ACL' result;
select offers_enabled,offer_window from private.class_waitlist_policy where singleton;
-- Run this last query in Supabase; pg_cron is unavailable in the local emulator.
select jobname,active from cron.job where jobname='fitlab-class-waitlist-offers';
rollback;

