begin;

-- Supabase instala pgcrypto en el esquema extensions. Estas funciones usan un
-- search_path restringido, por lo que las primitivas criptográficas deben
-- referenciarse con su esquema explícito.
create or replace function public.set_gym_admin_pin(
  target_gym_id uuid,
  new_pin text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new_pin is null or new_pin !~ '^[0-9]{4,12}$' then
    raise exception 'INVALID_ADMIN_PIN_FORMAT' using errcode = '22023';
  end if;
  if not exists (select 1 from public.gyms g where g.id = target_gym_id) then
    raise exception 'GYM_NOT_FOUND' using errcode = '23503';
  end if;

  insert into private.gym_security(
    gym_id, admin_passcode_hash, pin_failed_attempts, pin_locked_until, pin_updated_at
  ) values (
    target_gym_id,
    extensions.crypt(new_pin, extensions.gen_salt('bf', 12)),
    0, null, now()
  )
  on conflict (gym_id) do update
    set admin_passcode_hash = excluded.admin_passcode_hash,
        pin_failed_attempts = 0,
        pin_locked_until = null,
        pin_updated_at = now();

  delete from private.admin_elevation_sessions
  where gym_id = target_gym_id
    and used_at is null;
end;
$$;

revoke all on function public.set_gym_admin_pin(uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_gym_admin_pin(uuid, text)
  to service_role;

create or replace function public.create_admin_pin_elevation(
  target_gym_id uuid,
  target_staff_user_id uuid,
  requested_permission text,
  supplied_pin text
)
returns table(elevation_token text, elevation_expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  security_record record;
  raw_token text;
  token_digest text;
  expiration_time timestamptz;
begin
  if supplied_pin is null or supplied_pin !~ '^[0-9]{4,12}$' then
    raise exception 'INVALID_ADMIN_PIN_FORMAT' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.gym_users gu
    join public.staff_permissions sp
      on sp.staff_user_id = gu.id and sp.gym_id = gu.gym_id
    join public.permission_catalog pc on pc.key = sp.permission_key
    where gu.id = target_staff_user_id
      and gu.gym_id = target_gym_id
      and gu.role = 'staff'
      and gu.status = 'active'
      and sp.permission_key = requested_permission
      and sp.access_mode = 'requires_pin'
      and pc.supports_pin_elevation
  ) then
    raise exception 'PERMISSION_DOES_NOT_ALLOW_PIN_ELEVATION' using errcode = '42501';
  end if;

  select gs.admin_passcode_hash, gs.pin_failed_attempts, gs.pin_locked_until
    into security_record
  from private.gym_security gs
  where gs.gym_id = target_gym_id
  for update;

  if security_record.admin_passcode_hash is null then
    raise exception 'ADMIN_PIN_NOT_CONFIGURED' using errcode = '42501';
  end if;

  if security_record.pin_locked_until is not null and security_record.pin_locked_until > now() then
    raise exception 'ADMIN_PIN_TEMPORARILY_LOCKED' using errcode = '42501';
  end if;

  if security_record.pin_locked_until is not null and security_record.pin_locked_until <= now() then
    update private.gym_security
    set pin_failed_attempts = 0,
        pin_locked_until = null
    where gym_id = target_gym_id;
  end if;

  if extensions.crypt(supplied_pin, security_record.admin_passcode_hash)
     is distinct from security_record.admin_passcode_hash then
    update private.gym_security
    set pin_failed_attempts = pin_failed_attempts + 1,
        pin_locked_until = case
          when pin_failed_attempts + 1 >= 5 then now() + interval '15 minutes'
          else null
        end
    where gym_id = target_gym_id;
    return;
  end if;

  update private.gym_security
  set pin_failed_attempts = 0, pin_locked_until = null
  where gym_id = target_gym_id;

  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  token_digest := encode(extensions.digest(raw_token, 'sha256'), 'hex');
  expiration_time := now() + interval '5 minutes';

  insert into private.admin_elevation_sessions(
    gym_id, staff_user_id, permission_key, token_hash, expires_at
  ) values (
    target_gym_id, target_staff_user_id, requested_permission,
    token_digest, expiration_time
  );

  return query select raw_token, expiration_time;
end;
$$;

revoke all on function public.create_admin_pin_elevation(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.create_admin_pin_elevation(uuid, uuid, text, text)
  to service_role;

create or replace function public.consume_admin_pin_elevation(
  target_gym_id uuid,
  target_staff_user_id uuid,
  requested_permission text,
  supplied_token text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  consumed_id uuid;
begin
  update private.admin_elevation_sessions aes
  set used_at = now()
  where aes.gym_id = target_gym_id
    and aes.staff_user_id = target_staff_user_id
    and aes.permission_key = requested_permission
    and aes.token_hash = encode(extensions.digest(supplied_token, 'sha256'), 'hex')
    and aes.used_at is null
    and aes.expires_at > now()
    and exists (
      select 1
      from public.gym_users gu
      join public.staff_permissions sp
        on sp.staff_user_id = gu.id and sp.gym_id = gu.gym_id
      join public.permission_catalog pc on pc.key = sp.permission_key
      where gu.id = target_staff_user_id
        and gu.gym_id = target_gym_id
        and gu.role = 'staff'
        and gu.status = 'active'
        and sp.permission_key = requested_permission
        and sp.access_mode = 'requires_pin'
        and pc.supports_pin_elevation
    )
  returning aes.id into consumed_id;

  return consumed_id is not null;
end;
$$;

revoke all on function public.consume_admin_pin_elevation(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.consume_admin_pin_elevation(uuid, uuid, text, text)
  to service_role;

commit;
