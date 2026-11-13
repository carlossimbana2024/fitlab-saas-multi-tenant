-- READ ONLY: metadata only, no fixtures, no calls to mutating RPCs.
select p.oid::regprocedure as signature, p.prosecdef security_definer,p.provolatile,p.proconfig,
  has_function_privilege('anon',p.oid,'execute') anon_execute,
  has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
  has_function_privilege('service_role',p.oid,'execute') backend_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='get_member_personal_streaks_backend';

select p.oid::regprocedure signature,p.prosecdef,p.proconfig,
  has_function_privilege('anon',p.oid,'execute') anon_execute,
  has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
  has_function_privilege('service_role',p.oid,'execute') backend_direct_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='private' and p.proname in ('validate_member_streak_resolution',
  'member_streak_coverage','evaluate_member_streaks','member_personal_streaks');

select count(*) resolutions, count(*) filter(where disposition='legitimate') legitimate,
  count(*) filter(where disposition='retroactively_invalid') retroactively_invalid
from private.member_streak_coverage_resolutions;

select offers_enabled,offer_window from private.class_waitlist_policy where singleton;
select jobname,active,schedule from cron.job where jobname='fitlab-class-waitlist-offers';

-- Population impact, safe IDs only. Run under administrative SQL-editor role.
-- This is computation only; no stored counters/backfill writes are performed.
with impact as (
  select m.gym_id,m.id member_id,
    private.member_personal_streaks(m.gym_id,m.id,now()) metrics
  from public.gym_users m where m.role='member'
)
select gym_id,count(*) members,
  count(*) filter(where metrics->>'weeklyStatus'='needs_review') members_needing_review,
  coalesce(sum(jsonb_array_length(metrics->'ambiguousPeriodIds')),0) ambiguous_periods,
  coalesce(jsonb_agg(jsonb_build_object('memberId',member_id,'periodIds',metrics->'ambiguousPeriodIds'))
    filter(where metrics->>'weeklyStatus'='needs_review'),'[]'::jsonb) review
from impact group by gym_id order by gym_id;
