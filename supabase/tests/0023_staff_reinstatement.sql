-- Ejecutar despues de 0023_staff_reinstatement.sql.
-- Si existe staff retirado, lo reincorpora dentro de una transaccion con ROLLBACK.
begin;

do $$
declare
  owner_record record;
  removed_staff record;
  reinstated_record record;
  catalog_count bigint;
  denied_count bigint;
begin
  if has_function_privilege(
    'authenticated', 'public.reinstate_staff_backend(uuid,uuid,uuid)', 'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_REINSTATE_STAFF';
  end if;
  if not has_function_privilege(
    'service_role', 'public.reinstate_staff_backend(uuid,uuid,uuid)', 'EXECUTE'
  ) then
    raise exception 'SERVICE_ROLE_CANNOT_REINSTATE_STAFF';
  end if;

  select gu.id as owner_user_id, gu.gym_id
    into owner_record
  from public.gym_users gu
  where gu.role = 'owner'
    and gu.status = 'active'
    and gu.profile_id is not null
  order by gu.created_at
  limit 1;

  if owner_record.owner_user_id is null then
    raise exception 'TEST_REQUIRES_ACTIVE_OWNER';
  end if;

  select gu.id as staff_user_id
    into removed_staff
  from public.gym_users gu
  where gu.gym_id = owner_record.gym_id
    and gu.role = 'staff'
    and gu.status = 'inactive'
    and gu.profile_id is not null
    and gu.joined_at is not null
  order by gu.updated_at desc
  limit 1;

  if removed_staff.staff_user_id is not null then
    select * into reinstated_record
    from public.reinstate_staff_backend(
      owner_record.gym_id,
      removed_staff.staff_user_id,
      owner_record.owner_user_id
    );

    if reinstated_record.staff_status <> 'active' then
      raise exception 'STAFF_WAS_NOT_REINSTATED';
    end if;

    select count(*) into catalog_count from public.permission_catalog;
    select count(*) into denied_count
    from public.staff_permissions permission
    where permission.gym_id = owner_record.gym_id
      and permission.staff_user_id = removed_staff.staff_user_id
      and permission.access_mode = 'denied';

    if denied_count <> catalog_count then
      raise exception 'REINSTATED_STAFF_PERMISSIONS_NOT_DENIED';
    end if;
  end if;

  raise notice '0023 OK: reincorporacion privada, misma identidad y permisos denegados.';
end;
$$;

rollback;
