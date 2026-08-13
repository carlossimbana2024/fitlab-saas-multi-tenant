-- Ejecutar despues de 0021_staff_accounts_permissions.sql.
-- Comprueba privilegios y limites de rol; todo termina con ROLLBACK.
begin;

do $$
declare
  owner_record record;
  rpc_name text;
  expected_failure boolean := false;
begin
  foreach rpc_name in array array[
    'register_staff_invitation',
    'accept_portal_invitation',
    'update_staff_permissions_backend',
    'update_staff_status_backend',
    'revoke_staff_invitation'
  ] loop
    if exists (
      select 1
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname = rpc_name
        and has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
    ) then
      raise exception 'AUTHENTICATED_CAN_EXECUTE_%', upper(rpc_name);
    end if;
    if not exists (
      select 1
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname = rpc_name
        and has_function_privilege('service_role', procedure.oid, 'EXECUTE')
    ) then
      raise exception 'SERVICE_ROLE_CANNOT_EXECUTE_%', upper(rpc_name);
    end if;
  end loop;

  if not exists (
    select 1 from public.permission_catalog
    where key = 'settings.manage' and supports_pin_elevation
  ) then
    raise exception 'SETTINGS_MANAGE_MUST_SUPPORT_PIN';
  end if;
  if exists (
    select 1 from public.permission_catalog
    where key = 'staff.manage' and supports_pin_elevation
  ) then
    raise exception 'STAFF_MANAGE_MUST_REMAIN_OWNER_CONTROLLED';
  end if;

  select gu.id as owner_user_id, gu.gym_id
  into owner_record
  from public.gym_users gu
  where gu.role = 'owner' and gu.status = 'active' and gu.profile_id is not null
  order by gu.created_at
  limit 1;
  if owner_record.owner_user_id is null then
    raise exception 'TEST_REQUIRES_ACTIVE_OWNER';
  end if;

  begin
    perform public.update_staff_permissions_backend(
      owner_record.gym_id,
      owner_record.owner_user_id,
      owner_record.owner_user_id,
      jsonb_build_object('members.view', 'allowed')
    );
  exception when no_data_found then
    expected_failure := true;
  end;
  if not expected_failure then
    raise exception 'OWNER_WAS_ACCEPTED_AS_STAFF_TARGET';
  end if;

  raise notice '0021 OK: RPC privadas, owner obligatorio y matriz validada.';
end;
$$;

rollback;
