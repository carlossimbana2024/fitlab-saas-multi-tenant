begin;

-- Conserva la matriz efectiva antes y después de cada actualización. El JSON
-- sigue disponible para investigación técnica, mientras la interfaz presenta
-- únicamente las diferencias con etiquetas comprensibles para el owner.
create or replace function public.update_staff_permissions_backend(
  target_gym_id uuid,
  target_staff_user_id uuid,
  target_updated_by uuid,
  target_permissions jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  owner_profile_id uuid;
  permission_entry record;
  parsed_access_mode public.permission_access_mode;
  pin_supported boolean;
  previous_permissions jsonb;
  resulting_permissions jsonb;
begin
  select gu.profile_id into owner_profile_id
  from public.gym_users gu
  where gu.id = target_updated_by
    and gu.gym_id = target_gym_id
    and gu.role = 'owner'
    and gu.status = 'active'
    and gu.account_mode = 'portal';
  if owner_profile_id is null then
    raise exception 'STAFF_PERMISSIONS_REQUIRE_ACTIVE_OWNER' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.gym_users gu
    where gu.id = target_staff_user_id
      and gu.gym_id = target_gym_id
      and gu.role = 'staff'
      and gu.status in ('invited', 'active', 'suspended')
  ) then
    raise exception 'STAFF_USER_NOT_FOUND' using errcode = 'P0002';
  end if;

  if target_permissions is null
     or jsonb_typeof(target_permissions) <> 'object'
     or target_permissions = '{}'::jsonb then
    raise exception 'PERMISSIONS_MUST_BE_NON_EMPTY_OBJECT' using errcode = '22023';
  end if;

  select coalesce(
    jsonb_object_agg(permission.permission_key, permission.access_mode order by permission.permission_key),
    '{}'::jsonb
  ) into previous_permissions
  from public.staff_permissions permission
  where permission.gym_id = target_gym_id
    and permission.staff_user_id = target_staff_user_id;

  for permission_entry in select key, value from jsonb_each_text(target_permissions)
  loop
    begin
      parsed_access_mode := permission_entry.value::public.permission_access_mode;
    exception when invalid_text_representation then
      raise exception 'INVALID_PERMISSION_ACCESS_MODE' using errcode = '22023';
    end;

    select catalog.supports_pin_elevation into pin_supported
    from public.permission_catalog catalog
    where catalog.key = permission_entry.key;
    if not found then
      raise exception 'UNKNOWN_PERMISSION_KEY' using errcode = '22023';
    end if;
    if parsed_access_mode = 'requires_pin' and not pin_supported then
      raise exception 'PERMISSION_DOES_NOT_SUPPORT_PIN_ELEVATION' using errcode = '22023';
    end if;

    insert into public.staff_permissions(
      gym_id, staff_user_id, permission_key, access_mode, granted_by
    ) values (
      target_gym_id, target_staff_user_id, permission_entry.key,
      parsed_access_mode, target_updated_by
    )
    on conflict (staff_user_id, permission_key) do update
    set access_mode = excluded.access_mode,
        granted_by = excluded.granted_by,
        updated_at = now();
  end loop;

  select coalesce(
    jsonb_object_agg(permission.permission_key, permission.access_mode order by permission.permission_key),
    '{}'::jsonb
  ) into resulting_permissions
  from public.staff_permissions permission
  where permission.gym_id = target_gym_id
    and permission.staff_user_id = target_staff_user_id;

  delete from private.admin_elevation_sessions
  where gym_id = target_gym_id and staff_user_id = target_staff_user_id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, before_data, after_data
  ) values (
    target_gym_id, owner_profile_id, target_updated_by,
    'staff.permissions_updated', 'gym_user', target_staff_user_id,
    'staff.manage', previous_permissions, resulting_permissions
  );
end;
$$;

revoke all on function public.update_staff_permissions_backend(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_staff_permissions_backend(uuid, uuid, uuid, jsonb)
  to service_role;

commit;
