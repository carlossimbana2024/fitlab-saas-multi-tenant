begin;

-- Los miembros administrados no tienen cuenta Auth ni acceso al portal. Siguen
-- siendo gym_users porque membresías, pagos y asistencias ya referencian esa
-- entidad operativa.
create type public.gym_user_account_mode as enum ('portal', 'managed');

alter table public.gym_invitations
  add column auth_user_id uuid references auth.users(id) on delete set null;

create unique index gym_invitations_auth_user_idx
  on public.gym_invitations(auth_user_id)
  where auth_user_id is not null;

alter table public.gym_users
  alter column profile_id drop not null,
  add column account_mode public.gym_user_account_mode not null default 'portal',
  add column invitation_id uuid references public.gym_invitations(id) on delete set null,
  add column managed_full_name text,
  add column managed_phone text,
  add column managed_birth_date date,
  add column managed_guardian_name text,
  add column managed_guardian_phone text,
  add column managed_notes text;

-- Las invitaciones creadas por el backend anterior solo tenÃ­an Auth, profile y
-- gym_user. Se materializa su ciclo de vida para que los enlaces que ya fueron
-- enviados continÃºen funcionando despuÃ©s del despliegue de este bloque.
insert into public.gym_invitations(
  gym_id, email, intended_role, invited_by, token_hash, expires_at,
  status, auth_user_id
)
select
  invited.gym_id, lower(auth_user.email), invited.role, inviter.id,
  encode(extensions.gen_random_bytes(32), 'hex'), now() + interval '24 hours',
  'pending', invited.profile_id
from public.gym_users invited
join auth.users auth_user on auth_user.id = invited.profile_id
join lateral (
  select candidate.id
  from public.gym_users candidate
  where candidate.gym_id = invited.gym_id
    and candidate.role in ('owner', 'staff')
    and candidate.status = 'active'
  order by case when candidate.role = 'owner' then 0 else 1 end, candidate.created_at
  limit 1
) inviter on true
where invited.role = 'member'
  and invited.status = 'invited'
  and not exists (
    select 1 from public.gym_invitations existing
    where existing.gym_id = invited.gym_id
      and lower(existing.email) = lower(auth_user.email)
      and existing.status = 'pending'
  );

update public.gym_invitations invitation
set auth_user_id = invited.profile_id
from public.gym_users invited
join auth.users auth_user on auth_user.id = invited.profile_id
where invitation.gym_id = invited.gym_id
  and lower(invitation.email) = lower(auth_user.email)
  and invitation.status = 'pending'
  and invitation.intended_role = 'member'
  and invited.role = 'member'
  and invited.status = 'invited'
  and invitation.auth_user_id is null;

update public.gym_users invited
set invitation_id = invitation.id
from public.gym_invitations invitation
where invitation.gym_id = invited.gym_id
  and invitation.auth_user_id = invited.profile_id
  and invitation.status = 'pending'
  and invitation.intended_role = 'member'
  and invited.role = 'member'
  and invited.status = 'invited';

alter table public.gym_users
  add constraint gym_users_account_identity_chk check (
    (
      account_mode = 'portal'
      and profile_id is not null
      and managed_full_name is null
      and managed_phone is null
      and managed_birth_date is null
      and managed_guardian_name is null
      and managed_guardian_phone is null
      and managed_notes is null
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
  ),
  add constraint gym_users_managed_phone_length_chk check (
    managed_phone is null or char_length(trim(managed_phone)) between 3 and 40
  ),
  add constraint gym_users_managed_guardian_name_length_chk check (
    managed_guardian_name is null or char_length(trim(managed_guardian_name)) between 2 and 150
  ),
  add constraint gym_users_managed_guardian_phone_length_chk check (
    managed_guardian_phone is null or char_length(trim(managed_guardian_phone)) between 3 and 40
  ),
  add constraint gym_users_managed_notes_length_chk check (
    managed_notes is null or char_length(managed_notes) <= 1000
  );

create unique index gym_users_invitation_idx
  on public.gym_users(invitation_id)
  where invitation_id is not null;

create or replace function private.validate_gym_user_invitation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.invitation_id is not null and not exists (
    select 1 from public.gym_invitations invitation
    where invitation.id = new.invitation_id
      and invitation.gym_id = new.gym_id
      and invitation.auth_user_id = new.profile_id
  ) then
    raise exception 'GYM_USER_INVITATION_IDENTITY_MISMATCH' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_gym_user_invitation()
  from public, anon, authenticated;

create trigger gym_users_validate_invitation
before insert or update of gym_id, profile_id, invitation_id on public.gym_users
for each row execute function private.validate_gym_user_invitation();

comment on column public.gym_users.account_mode is
  'portal: tiene Auth/profile y puede iniciar sesión; managed: el gimnasio administra al miembro sin cuenta.';

-- Registra la identidad Auth, la invitación y el gym_user en una sola
-- transacción. El envío de correo ocurre antes desde el backend y se revierte
-- eliminando el usuario Auth si esta RPC falla.
create or replace function public.register_member_invitation(
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
    and gu.role in ('owner', 'staff')
    and gu.status = 'active'
    and gu.account_mode = 'portal';

  if inviter_profile_id is null then
    raise exception 'INVITER_MUST_BE_ACTIVE_IN_GYM' using errcode = '42501';
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
    target_gym_id, lower(trim(target_email)), 'member', target_invited_by,
    target_token_hash, target_expires_at, 'pending', target_auth_user_id
  ) returning id into created_invitation_id;

  insert into public.gym_users(
    gym_id, profile_id, role, status, default_location_id, account_mode,
    invitation_id
  ) values (
    target_gym_id, target_auth_user_id, 'member', 'invited',
    target_default_location_id, 'portal', created_invitation_id
  ) returning id into created_gym_user_id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, after_data
  ) values (
    target_gym_id, inviter_profile_id, target_invited_by,
    'member.invitation_created', 'gym_invitation', created_invitation_id,
    'members.manage', jsonb_build_object('email', lower(trim(target_email)), 'gym_user_id', created_gym_user_id)
  );

  return query select created_gym_user_id, created_invitation_id;
end;
$$;

revoke all on function public.register_member_invitation(
  uuid, uuid, text, text, text, uuid, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.register_member_invitation(
  uuid, uuid, text, text, text, uuid, uuid, text, timestamptz
) to service_role;

create or replace function public.accept_member_invitation(target_auth_user_id uuid)
returns table(gym_user_id uuid, gym_id uuid, member_role public.gym_role)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  invitation_record record;
  target_gym_user_id uuid;
begin
  select gi.id, gi.gym_id, gi.expires_at
    into invitation_record
  from public.gym_invitations gi
  where gi.auth_user_id = target_auth_user_id
    and gi.status = 'pending'
  for update;

  if invitation_record.id is null then return; end if;

  select gu.id into target_gym_user_id
  from public.gym_users gu
  where gu.invitation_id = invitation_record.id
    and gu.profile_id = target_auth_user_id
    and gu.status = 'invited'
  for update;

  if target_gym_user_id is null then return; end if;

  if invitation_record.expires_at <= now() then
    update public.gym_invitations set status = 'expired'
    where id = invitation_record.id;
    update public.gym_users set status = 'inactive'
    where id = target_gym_user_id;
    return;
  end if;

  update public.gym_invitations
  set status = 'accepted', accepted_at = now()
  where id = invitation_record.id;

  update public.gym_users
  set status = 'active', joined_at = now()
  where id = target_gym_user_id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, after_data
  ) values (
    invitation_record.gym_id, target_auth_user_id, target_gym_user_id,
    'member.invitation_accepted', 'gym_invitation', invitation_record.id,
    jsonb_build_object('gym_user_id', target_gym_user_id)
  );

  return query select target_gym_user_id, invitation_record.gym_id, 'member'::public.gym_role;
end;
$$;

revoke all on function public.accept_member_invitation(uuid)
  from public, anon, authenticated;
grant execute on function public.accept_member_invitation(uuid)
  to service_role;

create or replace function public.revoke_member_invitation(
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
  revoker_profile_id uuid;
  invitation_auth_user_id uuid;
begin
  select gu.profile_id into revoker_profile_id
  from public.gym_users gu
  where gu.id = target_revoked_by
    and gu.gym_id = target_gym_id
    and gu.role in ('owner', 'staff')
    and gu.status = 'active';
  if revoker_profile_id is null then
    raise exception 'INVITATION_REVOKER_MUST_BE_ACTIVE_IN_GYM' using errcode = '42501';
  end if;

  update public.gym_invitations as gi
  set status = 'revoked'
  where gi.id = target_invitation_id
    and gi.gym_id = target_gym_id
    and gi.status = 'pending'
  returning gi.auth_user_id into invitation_auth_user_id;

  if not found then return; end if;

  update public.gym_users
  set status = 'inactive'
  where invitation_id = target_invitation_id
    and gym_id = target_gym_id
    and status = 'invited';

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key
  ) values (
    target_gym_id, revoker_profile_id, target_revoked_by,
    'member.invitation_revoked', 'gym_invitation', target_invitation_id,
    'members.manage'
  );

  return query select invitation_auth_user_id;
end;
$$;

revoke all on function public.revoke_member_invitation(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_member_invitation(uuid, uuid, uuid)
  to service_role;

create or replace function public.create_managed_member(
  target_gym_id uuid,
  target_created_by uuid,
  target_full_name text,
  target_phone text,
  target_birth_date date,
  target_guardian_name text,
  target_guardian_phone text,
  target_notes text,
  target_default_location_id uuid
)
returns table(
  gym_user_id uuid,
  full_name text,
  phone text,
  account_mode public.gym_user_account_mode,
  member_status public.gym_user_status
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  creator_profile_id uuid;
  created_gym_user_id uuid;
begin
  select gu.profile_id into creator_profile_id
  from public.gym_users gu
  where gu.id = target_created_by
    and gu.gym_id = target_gym_id
    and gu.role in ('owner', 'staff')
    and gu.status = 'active';
  if creator_profile_id is null then
    raise exception 'MANAGED_MEMBER_CREATOR_MUST_BE_ACTIVE_IN_GYM' using errcode = '42501';
  end if;
  if target_birth_date is not null and target_birth_date > current_date then
    raise exception 'MEMBER_BIRTH_DATE_CANNOT_BE_FUTURE' using errcode = '22023';
  end if;
  if target_default_location_id is not null and not exists (
    select 1 from public.gym_locations gl
    where gl.id = target_default_location_id
      and gl.gym_id = target_gym_id
      and gl.is_active
  ) then
    raise exception 'MANAGED_MEMBER_LOCATION_MUST_BE_ACTIVE_IN_GYM' using errcode = '23514';
  end if;

  insert into public.gym_users(
    gym_id, profile_id, role, status, default_location_id, joined_at,
    account_mode, managed_full_name, managed_phone, managed_birth_date,
    managed_guardian_name, managed_guardian_phone, managed_notes
  ) values (
    target_gym_id, null, 'member', 'active', target_default_location_id, now(),
    'managed', trim(target_full_name), nullif(trim(target_phone), ''),
    target_birth_date, nullif(trim(target_guardian_name), ''),
    nullif(trim(target_guardian_phone), ''), nullif(trim(target_notes), '')
  ) returning id into created_gym_user_id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, after_data
  ) values (
    target_gym_id, creator_profile_id, target_created_by,
    'member.managed_created', 'gym_user', created_gym_user_id,
    'members.manage', jsonb_build_object('account_mode', 'managed', 'full_name', trim(target_full_name))
  );

  return query select created_gym_user_id, trim(target_full_name),
    nullif(trim(target_phone), ''), 'managed'::public.gym_user_account_mode,
    'active'::public.gym_user_status;
end;
$$;

revoke all on function public.create_managed_member(
  uuid, uuid, text, text, date, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.create_managed_member(
  uuid, uuid, text, text, date, text, text, text, uuid
) to service_role;

-- La validaciÃ³n original usaba profile_id IS NULL como sinÃ³nimo de miembro
-- inexistente. Ahora debe permitir profile_id nulo Ãºnicamente cuando el
-- registro es administrado y la asistencia la carga el personal.
create or replace function private.validate_attendance_relations()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  member_record record;
  membership_plan_id uuid;
  booking_record record;
  actor_profile_id uuid;
begin
  select gu.id, gu.profile_id, gu.account_mode
    into member_record
  from public.gym_users gu
  where gu.id = new.member_user_id
    and gu.gym_id = new.gym_id
    and gu.role = 'member'
    and gu.status = 'active';

  if member_record.id is null then
    raise exception 'ATTENDANCE_REQUIRES_ACTIVE_MEMBER' using errcode = '23514';
  end if;

  select m.plan_id into membership_plan_id
  from public.memberships m
  where m.id = new.membership_id
    and m.gym_id = new.gym_id
    and m.member_user_id = new.member_user_id;

  if membership_plan_id is null then
    raise exception 'ATTENDANCE_MEMBERSHIP_MISMATCH' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.gym_locations gl
    where gl.id = new.location_id and gl.gym_id = new.gym_id and gl.is_active = true
  ) then
    raise exception 'ATTENDANCE_LOCATION_MISMATCH' using errcode = '23514';
  end if;

  if new.source = 'staff' then
    select gu.profile_id into actor_profile_id from public.gym_users gu
    where gu.id = new.registered_by and gu.gym_id = new.gym_id
      and gu.role in ('owner', 'staff') and gu.status = 'active';
    if actor_profile_id is null then
      raise exception 'STAFF_ATTENDANCE_REQUIRES_ACTIVE_ACTOR' using errcode = '23514';
    end if;
  elsif new.source = 'qr' then
    if member_record.account_mode <> 'portal' or member_record.profile_id is null then
      raise exception 'QR_ATTENDANCE_REQUIRES_PORTAL_MEMBER' using errcode = '23514';
    end if;
    if new.registered_by is distinct from new.member_user_id then
      raise exception 'QR_ATTENDANCE_MUST_BE_REGISTERED_BY_MEMBER' using errcode = '23514';
    end if;
    actor_profile_id := member_record.profile_id;
  elsif new.source = 'extra_class' then
    select cb.member_user_id, cb.gym_id, cb.status,
           (cs.starts_at at time zone g.timezone)::date as class_date
      into booking_record
    from public.class_bookings cb
    join public.class_schedules cs on cs.id = cb.class_schedule_id
    join public.gyms g on g.id = cb.gym_id
    where cb.id = new.class_booking_id;

    if booking_record.member_user_id is distinct from new.member_user_id
       or booking_record.gym_id is distinct from new.gym_id
       or booking_record.status not in ('reserved', 'attended')
       or booking_record.class_date is distinct from new.attendance_date then
      raise exception 'EXTRA_CLASS_BOOKING_MISMATCH' using errcode = '23514';
    end if;

    new.counts_toward_streak := coalesce(
      (select p.allows_extra_classes from public.plans p where p.id = membership_plan_id),
      false
    );
  elsif new.source = 'system' then
    if (select auth.uid()) is not null or new.registered_by is not null then
      raise exception 'SYSTEM_ATTENDANCE_REQUIRES_PRIVILEGED_CONTEXT' using errcode = '42501';
    end if;
  end if;

  if new.source <> 'extra_class' and new.class_booking_id is not null then
    raise exception 'CLASS_BOOKING_ONLY_ALLOWED_FOR_EXTRA_CLASS_SOURCE' using errcode = '23514';
  end if;

  if (select auth.uid()) is not null and actor_profile_id <> (select auth.uid()) then
    raise exception 'ATTENDANCE_ACTOR_MUST_MATCH_AUTHENTICATED_USER' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function private.validate_attendance_relations()
  from public, anon, authenticated;

-- El bloqueo del PIN se contabiliza por empleado. Un usuario ya no puede
-- bloquear el PIN administrativo para todo el gimnasio.
create table private.admin_pin_attempts (
  gym_id uuid not null,
  staff_user_id uuid not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (gym_id, staff_user_id),
  foreign key (gym_id, staff_user_id)
    references public.gym_users(gym_id, id) on delete cascade
);

revoke all on private.admin_pin_attempts from public, anon, authenticated;

create or replace function public.set_gym_admin_pin(target_gym_id uuid, new_pin text)
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

  insert into private.gym_security(gym_id, admin_passcode_hash, pin_updated_at)
  values (
    target_gym_id,
    extensions.crypt(new_pin, extensions.gen_salt('bf', 12)),
    now()
  )
  on conflict (gym_id) do update
    set admin_passcode_hash = excluded.admin_passcode_hash,
        pin_failed_attempts = 0,
        pin_locked_until = null,
        pin_updated_at = now();

  delete from private.admin_pin_attempts where gym_id = target_gym_id;
  delete from private.admin_elevation_sessions
  where gym_id = target_gym_id and used_at is null;
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
  attempt_record record;
  staff_profile_id uuid;
  raw_token text;
  token_digest text;
  expiration_time timestamptz;
  next_failed_attempts integer;
begin
  if supplied_pin is null or supplied_pin !~ '^[0-9]{4,12}$' then
    raise exception 'INVALID_ADMIN_PIN_FORMAT' using errcode = '22023';
  end if;

  select gu.profile_id into staff_profile_id
  from public.gym_users gu
  join public.staff_permissions sp
    on sp.staff_user_id = gu.id and sp.gym_id = gu.gym_id
  join public.permission_catalog pc on pc.key = sp.permission_key
  where gu.id = target_staff_user_id
    and gu.gym_id = target_gym_id
    and gu.role = 'staff'
    and gu.status = 'active'
    and gu.account_mode = 'portal'
    and sp.permission_key = requested_permission
    and sp.access_mode = 'requires_pin'
    and pc.supports_pin_elevation;

  if staff_profile_id is null then
    raise exception 'PERMISSION_DOES_NOT_ALLOW_PIN_ELEVATION' using errcode = '42501';
  end if;

  select gs.admin_passcode_hash into security_record
  from private.gym_security gs
  where gs.gym_id = target_gym_id
  for update;
  if security_record.admin_passcode_hash is null then
    raise exception 'ADMIN_PIN_NOT_CONFIGURED' using errcode = '42501';
  end if;

  insert into private.admin_pin_attempts(gym_id, staff_user_id)
  values (target_gym_id, target_staff_user_id)
  on conflict (gym_id, staff_user_id) do nothing;

  select apa.failed_attempts, apa.locked_until into attempt_record
  from private.admin_pin_attempts apa
  where apa.gym_id = target_gym_id
    and apa.staff_user_id = target_staff_user_id
  for update;

  if attempt_record.locked_until is not null and attempt_record.locked_until > now() then
    insert into public.audit_logs(
      gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
      entity_id, permission_key, after_data
    ) values (
      target_gym_id, staff_profile_id, target_staff_user_id,
      'admin_pin.attempt_blocked', 'gym_security', target_gym_id,
      requested_permission, jsonb_build_object('locked_until', attempt_record.locked_until)
    );
    return;
  end if;

  if extensions.crypt(supplied_pin, security_record.admin_passcode_hash)
     is distinct from security_record.admin_passcode_hash then
    next_failed_attempts := case
      when attempt_record.locked_until is not null and attempt_record.locked_until <= now() then 1
      else attempt_record.failed_attempts + 1
    end;
    update private.admin_pin_attempts
    set failed_attempts = next_failed_attempts,
        locked_until = case when next_failed_attempts >= 5 then now() + interval '15 minutes' else null end,
        updated_at = now()
    where gym_id = target_gym_id and staff_user_id = target_staff_user_id;

    insert into public.audit_logs(
      gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
      entity_id, permission_key, after_data
    ) values (
      target_gym_id, staff_profile_id, target_staff_user_id,
      'admin_pin.attempt_failed', 'gym_security', target_gym_id,
      requested_permission, jsonb_build_object('failed_attempts', next_failed_attempts)
    );
    return;
  end if;

  update private.admin_pin_attempts
  set failed_attempts = 0, locked_until = null, updated_at = now()
  where gym_id = target_gym_id and staff_user_id = target_staff_user_id;

  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  token_digest := encode(extensions.digest(raw_token, 'sha256'), 'hex');
  expiration_time := now() + interval '5 minutes';

  insert into private.admin_elevation_sessions(
    gym_id, staff_user_id, permission_key, token_hash, expires_at
  ) values (
    target_gym_id, target_staff_user_id, requested_permission,
    token_digest, expiration_time
  );

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, after_data
  ) values (
    target_gym_id, staff_profile_id, target_staff_user_id,
    'admin_pin.elevation_created', 'admin_elevation_session', null,
    requested_permission, true, jsonb_build_object('expires_at', expiration_time)
  );

  return query select raw_token, expiration_time;
end;
$$;

revoke all on function public.create_admin_pin_elevation(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.create_admin_pin_elevation(uuid, uuid, text, text)
  to service_role;

-- Rate limiting compartido y atómico para entornos serverless. El backend
-- envía únicamente hashes SHA-256, nunca correos, IPs ni tokens en texto plano.
create table private.api_rate_limit_windows (
  bucket text not null,
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  hit_count integer not null default 1 check (hit_count > 0),
  expires_at timestamptz not null,
  primary key (bucket, subject_hash, window_started_at)
);

create index api_rate_limit_windows_expiry_idx
  on private.api_rate_limit_windows(expires_at);
revoke all on private.api_rate_limit_windows from public, anon, authenticated;

create or replace function public.consume_api_rate_limit(
  target_bucket text,
  target_subject_hash text,
  maximum_hits integer,
  window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  calculated_window_start timestamptz;
  current_hits integer;
begin
  if target_bucket !~ '^[a-z0-9_.-]{3,80}$'
     or target_subject_hash !~ '^[0-9a-f]{64}$'
     or maximum_hits < 1 or maximum_hits > 10000
     or window_seconds < 1 or window_seconds > 86400 then
    raise exception 'INVALID_RATE_LIMIT_CONFIGURATION' using errcode = '22023';
  end if;

  calculated_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / window_seconds) * window_seconds
  );

  insert into private.api_rate_limit_windows(
    bucket, subject_hash, window_started_at, hit_count, expires_at
  ) values (
    target_bucket, target_subject_hash, calculated_window_start, 1,
    calculated_window_start + make_interval(secs => window_seconds * 2)
  )
  on conflict (bucket, subject_hash, window_started_at) do update
    set hit_count = private.api_rate_limit_windows.hit_count + 1
  returning hit_count into current_hits;

  if random() < 0.01 then
    delete from private.api_rate_limit_windows where expires_at < now();
  end if;

  return current_hits <= maximum_hits;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, text, integer, integer)
  to service_role;

commit;
