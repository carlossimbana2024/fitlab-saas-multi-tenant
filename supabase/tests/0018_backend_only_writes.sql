-- Ejecutar después de 0018_backend_only_writes.sql.
-- No altera datos persistentes: solo crea una tabla temporal y termina con ROLLBACK.
begin;

do $$
declare
  target_table record;
begin
  for target_table in
    select format('%I.%I', n.nspname, c.relname) as qualified_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
  loop
    if has_table_privilege('authenticated', target_table.qualified_name, 'INSERT')
       or has_table_privilege('authenticated', target_table.qualified_name, 'UPDATE')
       or has_table_privilege('authenticated', target_table.qualified_name, 'DELETE') then
      raise exception 'AUTHENTICATED_STILL_HAS_WRITE_PRIVILEGE_ON_%', target_table.qualified_name;
    end if;
  end loop;
end;
$$;

-- Prepara dos identidades activas de gimnasios diferentes usando únicamente
-- datos existentes. La comprobación falla claramente si no hay dos tenants.
create temporary table fitlab_rls_test_context as
select profile_id, gym_id, row_number() over (order by gym_id) as position
from (
  select distinct on (gu.gym_id) gu.profile_id, gu.gym_id
  from public.gym_users gu
  where gu.status = 'active'
  order by gu.gym_id, gu.created_at
) active_tenants
order by gym_id
limit 2;

do $$
begin
  if (select count(*) from fitlab_rls_test_context) <> 2 then
    raise exception 'RLS_TEST_REQUIRES_TWO_ACTIVE_TENANTS';
  end if;
end;
$$;

grant select on fitlab_rls_test_context to authenticated;
select set_config(
  'request.jwt.claim.sub',
  (select profile_id::text from fitlab_rls_test_context where position = 1),
  true
);
set local role authenticated;

do $$
declare
  own_gym uuid;
  foreign_gym uuid;
begin
  select gym_id into own_gym from fitlab_rls_test_context where position = 1;
  select gym_id into foreign_gym from fitlab_rls_test_context where position = 2;

  if not exists (select 1 from public.gyms where id = own_gym) then
    raise exception 'RLS_HIDES_OWN_TENANT';
  end if;
  if exists (select 1 from public.gyms where id = foreign_gym) then
    raise exception 'RLS_EXPOSES_FOREIGN_TENANT';
  end if;
end;
$$;

reset role;
rollback;
