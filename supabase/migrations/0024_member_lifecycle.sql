begin;

-- Los datos complementarios (nacimiento, representante y notas) pertenecen al
-- miembro, no a su mecanismo de acceso. Se conservan al convertirlo a portal.
alter table public.gym_users
  drop constraint gym_users_account_identity_chk;

alter table public.gym_users
  add constraint gym_users_account_identity_chk check (
    (
      account_mode = 'portal'
      and profile_id is not null
      and managed_full_name is null
      and managed_phone is null
    )
    or (
      account_mode = 'managed'
      and role = 'member'
      and profile_id is null
      and invitation_id is null
      and status <> 'invited'
      and joined_at is not null
      and managed_full_name is not null
      and char_length(trim(managed_full_name)) between 2 and 150
    )
  );

create or replace function private.authorize_members_backend_actor(
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

  if not found
     or actor_record.profile_id is null
     or actor_record.status <> 'active'
     or actor_record.account_mode <> 'portal' then
    raise exception 'MEMBERS_ACTOR_MUST_BE_ACTIVE_IN_GYM' using errcode = '42501';
  end if;

  if actor_record.role = 'owner' then
    return actor_record.profile_id;
  end if;
  if actor_record.role <> 'staff' then
    raise exception 'MEMBERS_ACTOR_ROLE_DENIED' using errcode = '42501';
  end if;

  select permission.access_mode into actor_access_mode
  from public.staff_permissions permission
  where permission.gym_id = target_gym_id
    and permission.staff_user_id = target_actor_gym_user_id
    and permission.permission_key = 'members.manage';

  if actor_access_mode = 'allowed'
     or (actor_access_mode = 'requires_pin' and supplied_used_pin_elevation) then
    return actor_record.profile_id;
  end if;

  raise exception 'MEMBERS_PERMISSION_DENIED' using errcode = '42501';
end;
$$;

revoke all on function private.authorize_members_backend_actor(uuid, uuid, boolean)
  from public, anon, authenticated;

create or replace function public.update_member_backend(
  target_gym_id uuid,
  target_member_user_id uuid,
  target_updated_by uuid,
  supplied_full_name text,
  supplied_phone text,
  supplied_birth_date date,
  supplied_guardian_name text,
  supplied_guardian_phone text,
  supplied_notes text,
  supplied_default_location_id uuid,
  supplied_used_pin_elevation boolean
)
returns table(
  gym_user_id uuid,
  full_name text,
  phone text,
  member_status public.gym_user_status,
  account_mode public.gym_user_account_mode,
  default_location_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  member_record record;
  before_data jsonb;
begin
  if supplied_full_name is null
     or char_length(trim(supplied_full_name)) not between 2 and 150
     or (nullif(trim(supplied_phone), '') is not null and char_length(trim(supplied_phone)) not between 3 and 40)
     or supplied_birth_date > current_date
     or (nullif(trim(supplied_guardian_name), '') is not null and char_length(trim(supplied_guardian_name)) not between 2 and 150)
     or (nullif(trim(supplied_guardian_phone), '') is not null and char_length(trim(supplied_guardian_phone)) not between 3 and 40)
     or char_length(coalesce(supplied_notes, '')) > 1000 then
    raise exception 'INVALID_MEMBER_DETAILS' using errcode = '22023';
  end if;

  actor_profile_id := private.authorize_members_backend_actor(
    target_gym_id, target_updated_by, coalesce(supplied_used_pin_elevation, false)
  );

  select gu.id, gu.profile_id, gu.status, gu.account_mode,
         gu.default_location_id, gu.managed_full_name, gu.managed_phone,
         gu.managed_birth_date, gu.managed_guardian_name,
         gu.managed_guardian_phone, gu.managed_notes,
         profile.full_name as profile_full_name, profile.phone as profile_phone
    into member_record
  from public.gym_users gu
  left join public.profiles profile on profile.id = gu.profile_id
  where gu.id = target_member_user_id
    and gu.gym_id = target_gym_id
    and gu.role = 'member'
    and gu.status <> 'invited'
    and gu.joined_at is not null
  for update of gu;

  if not found then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if supplied_default_location_id is not null and not exists (
    select 1 from public.gym_locations location
    where location.id = supplied_default_location_id
      and location.gym_id = target_gym_id
      and location.is_active
  ) then
    raise exception 'MEMBER_LOCATION_MUST_BE_ACTIVE_IN_GYM' using errcode = '23514';
  end if;

  before_data := jsonb_build_object(
    'full_name', coalesce(member_record.profile_full_name, member_record.managed_full_name),
    'phone', coalesce(member_record.profile_phone, member_record.managed_phone),
    'birth_date', member_record.managed_birth_date,
    'guardian_name', member_record.managed_guardian_name,
    'guardian_phone', member_record.managed_guardian_phone,
    'notes', member_record.managed_notes,
    'default_location_id', member_record.default_location_id
  );

  if member_record.account_mode = 'portal' then
    update public.profiles
    set full_name = trim(supplied_full_name),
        phone = nullif(trim(supplied_phone), '')
    where id = member_record.profile_id;

    update public.gym_users
    set managed_birth_date = supplied_birth_date,
        managed_guardian_name = nullif(trim(supplied_guardian_name), ''),
        managed_guardian_phone = nullif(trim(supplied_guardian_phone), ''),
        managed_notes = nullif(trim(supplied_notes), ''),
        default_location_id = supplied_default_location_id
    where id = target_member_user_id;
  else
    update public.gym_users
    set managed_full_name = trim(supplied_full_name),
        managed_phone = nullif(trim(supplied_phone), ''),
        managed_birth_date = supplied_birth_date,
        managed_guardian_name = nullif(trim(supplied_guardian_name), ''),
        managed_guardian_phone = nullif(trim(supplied_guardian_phone), ''),
        managed_notes = nullif(trim(supplied_notes), ''),
        default_location_id = supplied_default_location_id
    where id = target_member_user_id;
  end if;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_updated_by,
    'member.details_updated', 'gym_user', target_member_user_id,
    'members.manage', coalesce(supplied_used_pin_elevation, false), before_data,
    jsonb_build_object(
      'full_name', trim(supplied_full_name),
      'phone', nullif(trim(supplied_phone), ''),
      'birth_date', supplied_birth_date,
      'guardian_name', nullif(trim(supplied_guardian_name), ''),
      'guardian_phone', nullif(trim(supplied_guardian_phone), ''),
      'notes', nullif(trim(supplied_notes), ''),
      'default_location_id', supplied_default_location_id
    )
  );

  return query select target_member_user_id, trim(supplied_full_name),
    nullif(trim(supplied_phone), ''), member_record.status,
    member_record.account_mode, supplied_default_location_id;
end;
$$;

revoke all on function public.update_member_backend(
  uuid, uuid, uuid, text, text, date, text, text, text, uuid, boolean
) from public, anon, authenticated;
grant execute on function public.update_member_backend(
  uuid, uuid, uuid, text, text, date, text, text, text, uuid, boolean
) to service_role;

create or replace function public.change_member_status_backend(
  target_gym_id uuid,
  target_member_user_id uuid,
  target_changed_by uuid,
  target_status public.gym_user_status,
  supplied_used_pin_elevation boolean
)
returns table(gym_user_id uuid, member_status public.gym_user_status)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  previous_status public.gym_user_status;
  audit_action text;
begin
  actor_profile_id := private.authorize_members_backend_actor(
    target_gym_id, target_changed_by, coalesce(supplied_used_pin_elevation, false)
  );

  select gu.status into previous_status
  from public.gym_users gu
  where gu.id = target_member_user_id
    and gu.gym_id = target_gym_id
    and gu.role = 'member'
    and gu.status <> 'invited'
    and gu.joined_at is not null
  for update;

  if not found then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if target_status not in ('active', 'suspended', 'inactive')
     or target_status = previous_status
     or (previous_status = 'inactive' and target_status <> 'active') then
    raise exception 'INVALID_MEMBER_STATUS_TRANSITION' using errcode = '22023';
  end if;

  update public.gym_users set status = target_status
  where id = target_member_user_id;

  audit_action := case target_status
    when 'suspended' then 'member.suspended'
    when 'inactive' then 'member.retired'
    else case when previous_status = 'inactive'
      then 'member.reinstated' else 'member.reactivated' end
  end;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_changed_by, audit_action,
    'gym_user', target_member_user_id, 'members.manage',
    coalesce(supplied_used_pin_elevation, false),
    jsonb_build_object('status', previous_status),
    jsonb_build_object('status', target_status, 'history_preserved', true)
  );

  return query select target_member_user_id, target_status;
end;
$$;

revoke all on function public.change_member_status_backend(
  uuid, uuid, uuid, public.gym_user_status, boolean
) from public, anon, authenticated;
grant execute on function public.change_member_status_backend(
  uuid, uuid, uuid, public.gym_user_status, boolean
) to service_role;

-- Convierte el mismo gym_user: no se crean nuevas referencias operativas y por
-- ello membresias, pagos, asistencias y rachas permanecen intactos.
create or replace function public.convert_managed_member_to_portal_backend(
  target_gym_id uuid,
  target_member_user_id uuid,
  target_auth_user_id uuid,
  target_email text,
  target_converted_by uuid,
  target_token_hash text,
  target_expires_at timestamptz,
  supplied_used_pin_elevation boolean
)
returns table(gym_user_id uuid, invitation_id uuid, auth_user_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  actor_profile_id uuid;
  member_record record;
  created_invitation_id uuid;
begin
  actor_profile_id := private.authorize_members_backend_actor(
    target_gym_id, target_converted_by, coalesce(supplied_used_pin_elevation, false)
  );

  if target_expires_at <= now()
     or target_token_hash is null
     or target_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INVITATION_DATA' using errcode = '22023';
  end if;
  if not exists (
    select 1 from auth.users auth_user
    where auth_user.id = target_auth_user_id
      and lower(auth_user.email) = lower(trim(target_email))
  ) then
    raise exception 'INVITATION_AUTH_USER_MISMATCH' using errcode = '23514';
  end if;

  select gu.managed_full_name, gu.managed_phone, gu.status,
         gu.managed_birth_date, gu.managed_guardian_name,
         gu.managed_guardian_phone, gu.managed_notes
    into member_record
  from public.gym_users gu
  where gu.id = target_member_user_id
    and gu.gym_id = target_gym_id
    and gu.role = 'member'
    and gu.account_mode = 'managed'
    and gu.status = 'active'
    and gu.joined_at is not null
  for update;

  if not found then
    raise exception 'ACTIVE_MANAGED_MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.profiles(id, full_name, phone)
  values (target_auth_user_id, member_record.managed_full_name, member_record.managed_phone);

  insert into public.gym_invitations(
    gym_id, email, intended_role, invited_by, token_hash, expires_at,
    status, auth_user_id
  ) values (
    target_gym_id, lower(trim(target_email)), 'member', target_converted_by,
    target_token_hash, target_expires_at, 'pending', target_auth_user_id
  ) returning id into created_invitation_id;

  update public.gym_users
  set profile_id = target_auth_user_id,
      account_mode = 'portal',
      invitation_id = created_invitation_id,
      status = 'invited',
      managed_full_name = null,
      managed_phone = null
  where id = target_member_user_id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_converted_by,
    'member.converted_to_portal', 'gym_user', target_member_user_id,
    'members.manage', coalesce(supplied_used_pin_elevation, false),
    jsonb_build_object('account_mode', 'managed', 'status', member_record.status),
    jsonb_build_object(
      'account_mode', 'portal', 'status', 'invited',
      'email', lower(trim(target_email)), 'invitation_id', created_invitation_id,
      'history_preserved', true
    )
  );

  return query select target_member_user_id, created_invitation_id, target_auth_user_id;
end;
$$;

revoke all on function public.convert_managed_member_to_portal_backend(
  uuid, uuid, uuid, text, uuid, text, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function public.convert_managed_member_to_portal_backend(
  uuid, uuid, uuid, text, uuid, text, timestamptz, boolean
) to service_role;

-- Al aceptar una conversion se conserva joined_at; esa fecha representa la
-- antiguedad real del miembro, no la fecha en que obtuvo acceso al portal.
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
  set status = 'active', joined_at = coalesce(joined_at, now())
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

commit;
