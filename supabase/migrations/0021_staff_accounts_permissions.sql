begin;

-- El PIN administrativo puede proteger cambios de configuracion realizados por
-- staff. La administracion del propio personal permanece exclusiva del owner.
update public.permission_catalog
set supports_pin_elevation = true
where key = 'settings.manage';

-- Registra Auth, perfil, invitacion, gym_user y la matriz inicial denegada en
-- una sola transaccion. Solo un owner activo del mismo gimnasio puede hacerlo.
create or replace function public.register_staff_invitation(
  target_gym_id uuid,
  target_auth_user_id uuid,
  target_email text,
  target_full_name text,
  target_phone text,
  target_default_location_id uuid,
  target_invited_by uuid,
  target_token_hash text,
  target_expires_at timestamptz
)
returns table(gym_user_id uuid, invitation_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  inviter_profile_id uuid;
  created_invitation_id uuid;
  created_gym_user_id uuid;
begin
  select gu.profile_id into inviter_profile_id
  from public.gym_users gu
  where gu.id = target_invited_by
    and gu.gym_id = target_gym_id
    and gu.role = 'owner'
    and gu.status = 'active'
    and gu.account_mode = 'portal';

  if inviter_profile_id is null then
    raise exception 'STAFF_INVITER_MUST_BE_ACTIVE_OWNER' using errcode = '42501';
  end if;
  if target_expires_at <= now() then
    raise exception 'INVITATION_EXPIRATION_MUST_BE_FUTURE' using errcode = '22023';
  end if;
  if target_token_hash is null or target_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INVITATION_TOKEN_HASH' using errcode = '22023';
  end if;
  if target_default_location_id is not null and not exists (
    select 1 from public.gym_locations gl
    where gl.id = target_default_location_id
      and gl.gym_id = target_gym_id
      and gl.is_active
  ) then
    raise exception 'INVITATION_LOCATION_MUST_BE_ACTIVE_IN_GYM' using errcode = '23514';
  end if;
  if not exists (
    select 1 from auth.users au
    where au.id = target_auth_user_id
      and lower(au.email) = lower(trim(target_email))
  ) then
    raise exception 'INVITATION_AUTH_USER_MISMATCH' using errcode = '23514';
  end if;

  insert into public.profiles(id, full_name, phone)
  values (target_auth_user_id, trim(target_full_name), nullif(trim(target_phone), ''));

  insert into public.gym_invitations(
    gym_id, email, intended_role, invited_by, token_hash, expires_at,
    status, auth_user_id
  ) values (
    target_gym_id, lower(trim(target_email)), 'staff', target_invited_by,
    target_token_hash, target_expires_at, 'pending', target_auth_user_id
  ) returning id into created_invitation_id;

  insert into public.gym_users(
    gym_id, profile_id, role, status, default_location_id, account_mode,
    invitation_id
  ) values (
    target_gym_id, target_auth_user_id, 'staff', 'invited',
    target_default_location_id, 'portal', created_invitation_id
  ) returning id into created_gym_user_id;

  insert into public.staff_permissions(
    gym_id, staff_user_id, permission_key, access_mode, granted_by
  )
  select target_gym_id, created_gym_user_id, catalog.key, 'denied', target_invited_by
  from public.permission_catalog catalog;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, after_data
  ) values (
    target_gym_id, inviter_profile_id, target_invited_by,
    'staff.invitation_created', 'gym_invitation', created_invitation_id,
    'staff.manage', jsonb_build_object(
      'email', lower(trim(target_email)),
      'gym_user_id', created_gym_user_id,
      'default_location_id', target_default_location_id
    )
  );

  return query select created_gym_user_id, created_invitation_id;
end;
$$;

revoke all on function public.register_staff_invitation(
  uuid, uuid, text, text, text, uuid, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.register_staff_invitation(
  uuid, uuid, text, text, text, uuid, uuid, text, timestamptz
) to service_role;

-- Acepta tanto invitaciones de miembros como de staff. El rol siempre se toma
-- de la fila ya creada por el backend, nunca de datos enviados por el cliente.
create or replace function public.accept_portal_invitation(target_auth_user_id uuid)
returns table(gym_user_id uuid, gym_id uuid, account_role public.gym_role)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  invitation_record record;
  invited_user record;
begin
  select gi.id, gi.gym_id, gi.expires_at, gi.intended_role
    into invitation_record
  from public.gym_invitations gi
  where gi.auth_user_id = target_auth_user_id
    and gi.status = 'pending'
  for update;

  if invitation_record.id is null then return; end if;

  select gu.id, gu.role into invited_user
  from public.gym_users gu
  where gu.invitation_id = invitation_record.id
    and gu.profile_id = target_auth_user_id
    and gu.status = 'invited'
    and gu.account_mode = 'portal'
  for update;

  if invited_user.id is null
     or invited_user.role is distinct from invitation_record.intended_role
     or invited_user.role not in ('member', 'staff') then
    return;
  end if;

  if invitation_record.expires_at <= now() then
    update public.gym_invitations set status = 'expired'
    where id = invitation_record.id;
    update public.gym_users set status = 'inactive'
    where id = invited_user.id;
    return;
  end if;

  update public.gym_invitations
  set status = 'accepted', accepted_at = now()
  where id = invitation_record.id;

  update public.gym_users
  set status = 'active', joined_at = now()
  where id = invited_user.id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, after_data
  ) values (
    invitation_record.gym_id, target_auth_user_id, invited_user.id,
    case when invited_user.role = 'staff'
      then 'staff.invitation_accepted'
      else 'member.invitation_accepted'
    end,
    'gym_invitation', invitation_record.id,
    jsonb_build_object('gym_user_id', invited_user.id, 'role', invited_user.role)
  );

  return query select invited_user.id, invitation_record.gym_id, invited_user.role;
end;
$$;

revoke all on function public.accept_portal_invitation(uuid)
  from public, anon, authenticated;
grant execute on function public.accept_portal_invitation(uuid)
  to service_role;

-- Guarda cambios parciales de la matriz y los audita en la misma transaccion.
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

  delete from private.admin_elevation_sessions
  where gym_id = target_gym_id and staff_user_id = target_staff_user_id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, after_data
  ) values (
    target_gym_id, owner_profile_id, target_updated_by,
    'staff.permissions_updated', 'gym_user', target_staff_user_id,
    'staff.manage', target_permissions
  );
end;
$$;

revoke all on function public.update_staff_permissions_backend(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_staff_permissions_backend(uuid, uuid, uuid, jsonb)
  to service_role;

create or replace function public.update_staff_status_backend(
  target_gym_id uuid,
  target_staff_user_id uuid,
  target_updated_by uuid,
  target_status public.gym_user_status
)
returns table(gym_user_id uuid, staff_status public.gym_user_status)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  owner_profile_id uuid;
  previous_status public.gym_user_status;
begin
  select gu.profile_id into owner_profile_id
  from public.gym_users gu
  where gu.id = target_updated_by
    and gu.gym_id = target_gym_id
    and gu.role = 'owner'
    and gu.status = 'active'
    and gu.account_mode = 'portal';
  if owner_profile_id is null then
    raise exception 'STAFF_STATUS_REQUIRES_ACTIVE_OWNER' using errcode = '42501';
  end if;
  if target_status not in ('active', 'suspended') then
    raise exception 'INVALID_STAFF_STATUS' using errcode = '22023';
  end if;

  select gu.status into previous_status
  from public.gym_users gu
  where gu.id = target_staff_user_id
    and gu.gym_id = target_gym_id
    and gu.role = 'staff'
  for update;
  if previous_status is null then
    raise exception 'STAFF_USER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if previous_status = 'invited' then
    raise exception 'PENDING_INVITATION_CANNOT_CHANGE_STATUS' using errcode = '22023';
  end if;

  update public.gym_users
  set status = target_status
  where id = target_staff_user_id;

  if target_status = 'suspended' then
    delete from private.admin_elevation_sessions
    where gym_id = target_gym_id and staff_user_id = target_staff_user_id;
  end if;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, before_data, after_data
  ) values (
    target_gym_id, owner_profile_id, target_updated_by,
    'staff.status_updated', 'gym_user', target_staff_user_id,
    'staff.manage', jsonb_build_object('status', previous_status),
    jsonb_build_object('status', target_status)
  );

  return query select target_staff_user_id, target_status;
end;
$$;

revoke all on function public.update_staff_status_backend(
  uuid, uuid, uuid, public.gym_user_status
) from public, anon, authenticated;
grant execute on function public.update_staff_status_backend(
  uuid, uuid, uuid, public.gym_user_status
) to service_role;

create or replace function public.revoke_staff_invitation(
  target_gym_id uuid,
  target_invitation_id uuid,
  target_revoked_by uuid
)
returns table(auth_user_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  owner_profile_id uuid;
  invitation_auth_user_id uuid;
begin
  select gu.profile_id into owner_profile_id
  from public.gym_users gu
  where gu.id = target_revoked_by
    and gu.gym_id = target_gym_id
    and gu.role = 'owner'
    and gu.status = 'active'
    and gu.account_mode = 'portal';
  if owner_profile_id is null then
    raise exception 'STAFF_REVOCATION_REQUIRES_ACTIVE_OWNER' using errcode = '42501';
  end if;

  update public.gym_invitations invitation
  set status = 'revoked'
  where invitation.id = target_invitation_id
    and invitation.gym_id = target_gym_id
    and invitation.intended_role = 'staff'
    and invitation.status = 'pending'
  returning invitation.auth_user_id into invitation_auth_user_id;
  if not found then return; end if;

  update public.gym_users
  set status = 'inactive'
  where invitation_id = target_invitation_id
    and gym_id = target_gym_id
    and role = 'staff'
    and status = 'invited';

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key
  ) values (
    target_gym_id, owner_profile_id, target_revoked_by,
    'staff.invitation_revoked', 'gym_invitation', target_invitation_id,
    'staff.manage'
  );

  return query select invitation_auth_user_id;
end;
$$;

revoke all on function public.revoke_staff_invitation(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_staff_invitation(uuid, uuid, uuid)
  to service_role;

commit;
