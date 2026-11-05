-- Read only: compare on the actual PostgreSQL instance; do not infer from Intl.
select to_regprocedure('public.get_member_branch_open_status_backend(uuid,uuid,uuid,timestamptz)') as rpc,
  to_regprocedure('private.class_interval_within_opening_hours(uuid,uuid,timestamptz,timestamptz)') as helper_0053;
select p.oid::regprocedure as signature,p.prosecdef as security_definer,p.proconfig as function_settings,
  pg_get_function_result(p.oid) as result_type
from pg_proc p where p.oid=to_regprocedure('public.get_member_branch_open_status_backend(uuid,uuid,uuid,timestamptz)');
select version(),
  timestamp '2026-10-04 00:30' at time zone 'Africa/Casablanca' as casablanca,
  timestamp '2026-03-08 02:30' at time zone 'America/New_York' as spring_forward,
  timestamp '2026-11-01 01:30' at time zone 'America/New_York' as fall_back;
select has_function_privilege('anon','public.get_member_branch_open_status_backend(uuid,uuid,uuid,timestamptz)','EXECUTE') as anon_access,
  has_function_privilege('authenticated','public.get_member_branch_open_status_backend(uuid,uuid,uuid,timestamptz)','EXECUTE') as member_direct_access,
  has_function_privilege('service_role','public.get_member_branch_open_status_backend(uuid,uuid,uuid,timestamptz)','EXECUTE') as backend_access;
select offers_enabled,offer_window from private.class_waitlist_policy where singleton;
select jobname,active from cron.job where jobname='fitlab-class-waitlist-offers';
