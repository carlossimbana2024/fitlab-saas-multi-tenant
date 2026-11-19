-- Production-safe after applying 0059: catalog and privilege reads only.
with expected as (
  select to_regprocedure('public.get_owner_dashboard_income_backend(uuid,timestamp with time zone)') as oid
)
select
  p.oid is not null as rpc_exists,
  pg_get_function_result(p.oid) = 'jsonb' as jsonb_result,
  (p.pronargs = 2 and p.pronargdefaults = 1) as gym_only_call_supported,
  (p.provolatile = 's' and not p.prosecdef and l.lanname = 'sql') as stable_sql_invoker,
  coalesce(p.proconfig @> array['search_path=pg_catalog'], false) as restricted_search_path,
  p.oid is not null and not exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ) as no_public_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
  has_schema_privilege('service_role', 'public', 'USAGE')
    and has_table_privilege('service_role', 'public.gyms', 'SELECT')
    and has_table_privilege('service_role', 'public.member_payments', 'SELECT') as service_role_can_read_sources
from expected e
left join pg_proc p on p.oid = e.oid
left join pg_language l on l.oid = p.prolang;
