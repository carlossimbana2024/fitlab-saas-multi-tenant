-- Ejecutar despues de 0022_staff_offboarding.sql.
-- Comprueba privilegios y, si existe staff, su retiro dentro de ROLLBACK.
begin;

do $$
declare
  owner_record record;
  staff_record record;
  removed_record record;
begin
  if has_function_privilege(
    'authenticated', 'public.remove_staff_backend(uuid,uuid,uuid)', 'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_REMOVE_STAFF';
  end if;
  if not has_function_privilege(
    'service_role', 'public.remove_staff_backend(uuid,uuid,uuid)', 'EXECUTE'
  ) then
    raise exception 'SERVICE_ROLE_CANNOT_REMOVE_STAFF';
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
    into staff_record
  from public.gym_users gu
  where gu.gym_id = owner_record.gym_id
    and gu.role = 'staff'
    and gu.status in ('invited', 'active', 'suspended')
  order by gu.created_at desc
  limit 1;

  if staff_record.staff_user_id is not null then
    select * into removed_record
    from public.remove_staff_backend(
      owner_record.gym_id,
      staff_record.staff_user_id,
      owner_record.owner_user_id
    );

    if removed_record.staff_status <> 'inactive' then
      raise exception 'STAFF_WAS_NOT_REMOVED';
    end if;
    if exists (
      select 1 from public.staff_permissions permission
      where permission.gym_id = owner_record.gym_id
        and permission.staff_user_id = staff_record.staff_user_id
    ) then
      raise exception 'REMOVED_STAFF_RETAINED_PERMISSIONS';
    end if;
  end if;

  raise notice '0022 OK: offboarding privado, historico y sin permisos residuales.';
end;
$$;

rollback;
