-- Ejecutar después de 0027_staff_permission_audit_snapshots.sql.
-- Si existe staff, actualiza con su matriz actual y termina con ROLLBACK.
begin;

do $$
declare
  owner_record record;
  staff_record record;
  desired_permissions jsonb;
  audit_record record;
begin
  if has_function_privilege(
    'authenticated',
    'public.update_staff_permissions_backend(uuid,uuid,uuid,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_UPDATE_STAFF_PERMISSIONS';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.update_staff_permissions_backend(uuid,uuid,uuid,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'SERVICE_ROLE_CANNOT_UPDATE_STAFF_PERMISSIONS';
  end if;

  select gu.id, gu.gym_id
  into owner_record
  from public.gym_users gu
  where gu.role = 'owner'
    and gu.status = 'active'
    and gu.account_mode = 'portal'
  order by gu.created_at
  limit 1;

  if owner_record.id is null then
    raise notice '0027 OK: privilegios comprobados; no existe owner para prueba transaccional.';
    return;
  end if;

  select gu.id
  into staff_record
  from public.gym_users gu
  where gu.gym_id = owner_record.gym_id
    and gu.role = 'staff'
    and gu.status in ('invited', 'active', 'suspended')
  order by gu.created_at
  limit 1;

  if staff_record.id is null then
    raise notice '0027 OK: privilegios comprobados; no existe staff para prueba transaccional.';
    return;
  end if;

  select jsonb_object_agg(
    catalog.key,
    coalesce(permission.access_mode::text, 'denied')
    order by catalog.key
  )
  into desired_permissions
  from public.permission_catalog catalog
  left join public.staff_permissions permission
    on permission.permission_key = catalog.key
   and permission.staff_user_id = staff_record.id;

  perform public.update_staff_permissions_backend(
    owner_record.gym_id,
    staff_record.id,
    owner_record.id,
    desired_permissions
  );

  select log.before_data, log.after_data
  into audit_record
  from public.audit_logs log
  where log.gym_id = owner_record.gym_id
    and log.entity_id = staff_record.id
    and log.action = 'staff.permissions_updated'
  order by log.created_at desc, log.id desc
  limit 1;

  if audit_record.before_data is null or audit_record.after_data is null then
    raise exception 'AUDIT_PERMISSION_SNAPSHOT_MISSING';
  end if;
  if audit_record.after_data is distinct from desired_permissions then
    raise exception 'AUDIT_AFTER_SNAPSHOT_DOES_NOT_MATCH_EFFECTIVE_MATRIX';
  end if;

  raise notice '0027 OK: privilegios y matrices antes/despues comprobados.';
end;
$$;

rollback;
