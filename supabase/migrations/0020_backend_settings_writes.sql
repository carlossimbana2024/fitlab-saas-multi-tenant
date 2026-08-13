begin;

-- Autoriza al owner siempre y al staff solo cuando settings.manage esta
-- permitido o la elevacion por PIN ya fue consumida por el backend.
create or replace function private.authorize_settings_backend_actor(
  target_gym_id uuid,
  target_actor_gym_user_id uuid,
  supplied_used_pin_elevation boolean
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_record record;
  actor_access_mode public.permission_access_mode;
begin
  select gu.profile_id, gu.role, gu.status, gu.account_mode
    into actor_record
  from public.gym_users gu
  where gu.id = target_actor_gym_user_id
    and gu.gym_id = target_gym_id;

  if not found then
    raise exception 'SETTINGS_ACTOR_MUST_BE_ACTIVE_IN_GYM' using errcode = '42501';
  end if;

  if actor_record.profile_id is null
     or actor_record.status <> 'active'
     or actor_record.account_mode <> 'portal' then
    raise exception 'SETTINGS_ACTOR_MUST_BE_ACTIVE_IN_GYM' using errcode = '42501';
  end if;

  if actor_record.role = 'owner' then
    return actor_record.profile_id;
  end if;

  if actor_record.role <> 'staff' then
    raise exception 'SETTINGS_ACTOR_ROLE_DENIED' using errcode = '42501';
  end if;

  select sp.access_mode into actor_access_mode
  from public.staff_permissions sp
  where sp.gym_id = target_gym_id
    and sp.staff_user_id = target_actor_gym_user_id
    and sp.permission_key = 'settings.manage';

  if actor_access_mode = 'allowed'
     or (actor_access_mode = 'requires_pin' and supplied_used_pin_elevation) then
    return actor_record.profile_id;
  end if;

  raise exception 'SETTINGS_PERMISSION_DENIED' using errcode = '42501';
end;
$$;

revoke all on function private.authorize_settings_backend_actor(uuid, uuid, boolean)
  from public, anon, authenticated;

create or replace function public.update_gym_settings_backend(
  target_gym_id uuid,
  target_actor_gym_user_id uuid,
  supplied_name text,
  supplied_email text,
  supplied_phone text,
  supplied_whatsapp_phone text,
  supplied_used_pin_elevation boolean
)
returns table(
  id uuid,
  name text,
  email text,
  phone text,
  whatsapp_phone text,
  timezone text,
  currency character(3)
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  updated_gym record;
begin
  if supplied_name is null
     or char_length(trim(supplied_name)) not between 2 and 150
     or (nullif(trim(supplied_email), '') is not null
       and nullif(trim(supplied_email), '') !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
     or (nullif(trim(supplied_phone), '') is not null
       and char_length(trim(supplied_phone)) > 30)
     or (nullif(trim(supplied_whatsapp_phone), '') is not null
       and char_length(trim(supplied_whatsapp_phone)) > 30) then
    raise exception 'INVALID_GYM_SETTINGS' using errcode = '22023';
  end if;

  actor_profile_id := private.authorize_settings_backend_actor(
    target_gym_id, target_actor_gym_user_id,
    coalesce(supplied_used_pin_elevation, false)
  );

  update public.gyms as gym
  set name = trim(supplied_name),
      email = nullif(trim(supplied_email), ''),
      phone = nullif(trim(supplied_phone), ''),
      whatsapp_phone = nullif(trim(supplied_whatsapp_phone), '')
  where gym.id = target_gym_id
  returning gym.id, gym.name, gym.email, gym.phone, gym.whatsapp_phone,
            gym.timezone, gym.currency
    into updated_gym;

  if not found then
    raise exception 'GYM_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'settings.gym_updated', 'gym', target_gym_id, 'settings.manage',
    coalesce(supplied_used_pin_elevation, false), to_jsonb(updated_gym)
  );

  return query select updated_gym.id, updated_gym.name, updated_gym.email,
    updated_gym.phone, updated_gym.whatsapp_phone, updated_gym.timezone,
    updated_gym.currency;
end;
$$;

revoke all on function public.update_gym_settings_backend(
  uuid, uuid, text, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.update_gym_settings_backend(
  uuid, uuid, text, text, text, text, boolean
) to service_role;

create or replace function public.update_location_settings_backend(
  target_gym_id uuid,
  target_location_id uuid,
  target_actor_gym_user_id uuid,
  supplied_name text,
  supplied_address text,
  supplied_city text,
  supplied_email text,
  supplied_phone text,
  supplied_whatsapp_phone text,
  supplied_used_pin_elevation boolean
)
returns table(
  id uuid,
  name text,
  address text,
  city text,
  email text,
  phone text,
  whatsapp_phone text,
  timezone text,
  is_main boolean,
  is_active boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  updated_location record;
begin
  if supplied_name is null
     or char_length(trim(supplied_name)) not between 2 and 150
     or supplied_city is null
     or char_length(trim(supplied_city)) not between 2 and 100
     or (nullif(trim(supplied_address), '') is not null
       and char_length(trim(supplied_address)) > 300)
     or (nullif(trim(supplied_email), '') is not null
       and nullif(trim(supplied_email), '') !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
     or (nullif(trim(supplied_phone), '') is not null
       and char_length(trim(supplied_phone)) > 30)
     or (nullif(trim(supplied_whatsapp_phone), '') is not null
       and char_length(trim(supplied_whatsapp_phone)) > 30) then
    raise exception 'INVALID_LOCATION_SETTINGS' using errcode = '22023';
  end if;

  actor_profile_id := private.authorize_settings_backend_actor(
    target_gym_id, target_actor_gym_user_id,
    coalesce(supplied_used_pin_elevation, false)
  );

  update public.gym_locations as location
  set name = trim(supplied_name),
      address = nullif(trim(supplied_address), ''),
      city = trim(supplied_city),
      email = nullif(trim(supplied_email), ''),
      phone = nullif(trim(supplied_phone), ''),
      whatsapp_phone = nullif(trim(supplied_whatsapp_phone), '')
  where location.id = target_location_id
    and location.gym_id = target_gym_id
  returning location.id, location.name, location.address, location.city,
            location.email, location.phone, location.whatsapp_phone,
            location.timezone, location.is_main, location.is_active
    into updated_location;

  if not found then
    raise exception 'LOCATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'settings.location_updated', 'gym_location', target_location_id,
    'settings.manage', coalesce(supplied_used_pin_elevation, false),
    to_jsonb(updated_location)
  );

  return query select updated_location.id, updated_location.name,
    updated_location.address, updated_location.city, updated_location.email,
    updated_location.phone, updated_location.whatsapp_phone,
    updated_location.timezone, updated_location.is_main,
    updated_location.is_active;
end;
$$;

revoke all on function public.update_location_settings_backend(
  uuid, uuid, uuid, text, text, text, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.update_location_settings_backend(
  uuid, uuid, uuid, text, text, text, text, text, text, boolean
) to service_role;

commit;
