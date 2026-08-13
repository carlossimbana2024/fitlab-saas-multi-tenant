-- Ejecutar despues de 0020_backend_settings_writes.sql.
-- Actualiza con los mismos valores actuales y termina con ROLLBACK.
begin;

do $$
declare
  owner_record record;
  updated_gym record;
  updated_location record;
  audit_count_before bigint;
  audit_count_after bigint;
begin
  if has_function_privilege(
    'authenticated',
    'public.update_gym_settings_backend(uuid,uuid,text,text,text,text,boolean)',
    'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_UPDATE_GYM_SETTINGS_BACKEND';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.update_location_settings_backend(uuid,uuid,uuid,text,text,text,text,text,text,boolean)',
    'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_UPDATE_LOCATION_SETTINGS_BACKEND';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.update_gym_settings_backend(uuid,uuid,text,text,text,text,boolean)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.update_location_settings_backend(uuid,uuid,uuid,text,text,text,text,text,text,boolean)',
    'EXECUTE'
  ) then
    raise exception 'SERVICE_ROLE_CANNOT_UPDATE_SETTINGS_BACKEND';
  end if;

  select
    owner_user.id as owner_user_id,
    gym.id as gym_id,
    gym.name as gym_name,
    gym.email as gym_email,
    gym.phone as gym_phone,
    gym.whatsapp_phone as gym_whatsapp_phone,
    location.id as location_id,
    location.name as location_name,
    location.address as location_address,
    location.city as location_city,
    location.email as location_email,
    location.phone as location_phone,
    location.whatsapp_phone as location_whatsapp_phone
  into owner_record
  from public.gym_users owner_user
  join public.gyms gym on gym.id = owner_user.gym_id
  join public.gym_locations location
    on location.gym_id = gym.id and location.is_active
  where owner_user.role = 'owner'
    and owner_user.status = 'active'
    and owner_user.profile_id is not null
  order by location.is_main desc, owner_user.created_at
  limit 1;

  if owner_record.owner_user_id is null then
    raise exception 'TEST_REQUIRES_ACTIVE_OWNER_AND_LOCATION';
  end if;

  select count(*) into audit_count_before
  from public.audit_logs audit
  where audit.gym_id = owner_record.gym_id
    and audit.actor_gym_user_id = owner_record.owner_user_id
    and audit.action in ('settings.gym_updated', 'settings.location_updated');

  select * into updated_gym
  from public.update_gym_settings_backend(
    owner_record.gym_id, owner_record.owner_user_id, owner_record.gym_name,
    owner_record.gym_email, owner_record.gym_phone,
    owner_record.gym_whatsapp_phone, false
  );

  if updated_gym.id is distinct from owner_record.gym_id
     or updated_gym.name is distinct from owner_record.gym_name then
    raise exception 'OWNER_GYM_SETTINGS_UPDATE_FAILED';
  end if;

  select * into updated_location
  from public.update_location_settings_backend(
    owner_record.gym_id, owner_record.location_id,
    owner_record.owner_user_id, owner_record.location_name,
    owner_record.location_address, owner_record.location_city,
    owner_record.location_email, owner_record.location_phone,
    owner_record.location_whatsapp_phone, false
  );

  if updated_location.id is distinct from owner_record.location_id
     or updated_location.name is distinct from owner_record.location_name then
    raise exception 'OWNER_LOCATION_SETTINGS_UPDATE_FAILED';
  end if;

  select count(*) into audit_count_after
  from public.audit_logs audit
  where audit.gym_id = owner_record.gym_id
    and audit.actor_gym_user_id = owner_record.owner_user_id
    and audit.action in ('settings.gym_updated', 'settings.location_updated');

  if audit_count_after <> audit_count_before + 2 then
    raise exception 'SETTINGS_AUDIT_NOT_ATOMIC';
  end if;

  raise notice '0020 OK: el owner puede guardar gimnasio y sucursal con auditoria atomica.';
end;
$$;

rollback;
