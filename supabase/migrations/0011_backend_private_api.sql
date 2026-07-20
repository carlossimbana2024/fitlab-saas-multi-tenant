begin;

-- No se expone el esquema private en la Data API. El backend accede únicamente
-- mediante estas operaciones SECURITY DEFINER, concedidas solo a service_role.

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

  -- Un cambio de PIN revoca inmediatamente cualquier elevación pendiente que
  -- haya sido creada con el PIN anterior.
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
    -- No se lanza excepción: una excepción revertiría también el contador y el
    -- bloqueo. Una respuesta sin filas significa PIN inválido para el backend.
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

-- Los costos siguen ocultos; el backend no recibe acceso directo al esquema.
create or replace function public.set_product_cost(
  target_gym_id uuid,
  target_product_id uuid,
  new_cost numeric
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new_cost is not null and new_cost < 0 then
    raise exception 'PRODUCT_COST_CANNOT_BE_NEGATIVE' using errcode = '22023';
  end if;

  insert into private.product_costs(product_id, gym_id, cost_price)
  values (target_product_id, target_gym_id, new_cost)
  on conflict (product_id) do update
    set gym_id = excluded.gym_id,
        cost_price = excluded.cost_price;
end;
$$;

revoke all on function public.set_product_cost(uuid, uuid, numeric)
  from public, anon, authenticated;
grant execute on function public.set_product_cost(uuid, uuid, numeric)
  to service_role;

create or replace function public.get_product_costs(target_gym_id uuid)
returns table(product_id uuid, cost_price numeric, updated_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select pc.product_id, pc.cost_price, pc.updated_at
  from private.product_costs pc
  where pc.gym_id = target_gym_id
$$;

revoke all on function public.get_product_costs(uuid)
  from public, anon, authenticated;
grant execute on function public.get_product_costs(uuid)
  to service_role;

-- Evita depender de privilegios predeterminados de Supabase para tablas públicas.
grant usage on schema public to service_role;
revoke all on all tables in schema public from service_role;
grant select, insert, update on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Se aplica a los objetos públicos que creen posteriormente las migraciones
-- ejecutadas por el mismo rol propietario de esta migración.
alter default privileges in schema public
  revoke all on tables from service_role;
alter default privileges in schema public
  grant select, insert, update on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;

comment on function public.create_admin_pin_elevation(uuid, uuid, text, text) is
  'Backend-only. Verifica el PIN sin exponer su hash y entrega un token de un solo uso.';
comment on function public.consume_admin_pin_elevation(uuid, uuid, text, text) is
  'Backend-only. Consume una elevación temporal para un permiso exacto.';
comment on function public.set_gym_admin_pin(uuid, text) is
  'Backend-only. Crea o reemplaza el hash bcrypt del PIN; nunca almacena el PIN plano.';

commit;
