begin;

-- Reincorpora una identidad staff existente. No crea otra cuenta Auth ni
-- reutiliza una invitacion: conserva correo, contrasena e historial.
create or replace function public.reinstate_staff_backend(
  target_gym_id uuid,
  target_staff_user_id uuid,
  target_reinstated_by uuid
)
returns table(
  gym_user_id uuid,
  auth_user_id uuid,
  staff_status public.gym_user_status
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  owner_profile_id uuid;
  staff_profile_id uuid;
begin
  select gu.profile_id into owner_profile_id
  from public.gym_users gu
  where gu.id = target_reinstated_by
    and gu.gym_id = target_gym_id
    and gu.role = 'owner'
    and gu.status = 'active'
    and gu.account_mode = 'portal';

  if owner_profile_id is null then
    raise exception 'STAFF_REINSTATEMENT_REQUIRES_ACTIVE_OWNER' using errcode = '42501';
  end if;

  select gu.profile_id into staff_profile_id
  from public.gym_users gu
  where gu.id = target_staff_user_id
    and gu.gym_id = target_gym_id
    and gu.role = 'staff'
    and gu.status = 'inactive'
    and gu.account_mode = 'portal'
    and gu.profile_id is not null
    and gu.joined_at is not null
  for update;

  if staff_profile_id is null then
    raise exception 'REMOVED_STAFF_USER_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from auth.users auth_user
    where auth_user.id = staff_profile_id
  ) then
    raise exception 'STAFF_AUTH_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.gym_users
  set status = 'active'
  where id = target_staff_user_id;

  insert into public.staff_permissions(
    gym_id, staff_user_id, permission_key, access_mode, granted_by
  )
  select target_gym_id, target_staff_user_id, catalog.key, 'denied', target_reinstated_by
  from public.permission_catalog catalog
  on conflict (staff_user_id, permission_key) do update
  set access_mode = 'denied',
      granted_by = excluded.granted_by,
      updated_at = now();

  delete from private.admin_elevation_sessions
  where gym_id = target_gym_id
    and staff_user_id = target_staff_user_id;

  delete from private.admin_pin_attempts
  where gym_id = target_gym_id
    and staff_user_id = target_staff_user_id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, before_data, after_data
  ) values (
    target_gym_id, owner_profile_id, target_reinstated_by,
    'staff.reinstated', 'gym_user', target_staff_user_id, 'staff.manage',
    jsonb_build_object('status', 'inactive'),
    jsonb_build_object('status', 'active', 'permissions', 'denied')
  );

  return query select
    target_staff_user_id,
    staff_profile_id,
    'active'::public.gym_user_status;
end;
$$;

revoke all on function public.reinstate_staff_backend(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reinstate_staff_backend(uuid, uuid, uuid)
  to service_role;

commit;
