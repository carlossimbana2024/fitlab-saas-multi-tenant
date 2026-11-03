-- Safe remote verification: read-only, no fixture inserts, no rollout changes.
begin read only;
do $$declare f record;n integer:=0;begin
 for f in select oid,proname,prosecdef,proconfig from pg_proc
 where pronamespace='public'::regnamespace and proname in
 ('get_member_attendance_summary_backend','get_member_community_rankings_backend','list_member_community_page_backend') loop
   n:=n+1;
   if has_function_privilege('anon',f.oid,'EXECUTE') or has_function_privilege('authenticated',f.oid,'EXECUTE')
     or not has_function_privilege('service_role',f.oid,'EXECUTE') or not f.prosecdef
     or not ('search_path=pg_catalog, public'=any(f.proconfig)) then raise exception 'INVALID_RPC_SECURITY: %',f.proname;end if;
 end loop;
 if n<>3 then raise exception 'MISSING_OR_OVERLOADED_RPC';end if;
 for f in select oid from pg_proc where pronamespace='private'::regnamespace and proname in
 ('require_member_aggregate_reader','member_monthly_goal_percent','member_community_goal_percent') loop
   if has_function_privilege('anon',f.oid,'EXECUTE') or has_function_privilege('authenticated',f.oid,'EXECUTE')
     or has_function_privilege('service_role',f.oid,'EXECUTE') then raise exception 'EXPOSED_HELPER';end if;
 end loop;
end;$$;
select '0054 OK: three backend-only RPCs, fixed search_path and private helpers' result;
select offers_enabled,offer_window from private.class_waitlist_policy where singleton;
-- Run this last query in Supabase; pg_cron is unavailable in the local emulator.
select jobname,active from cron.job where jobname='fitlab-class-waitlist-offers';
rollback;
