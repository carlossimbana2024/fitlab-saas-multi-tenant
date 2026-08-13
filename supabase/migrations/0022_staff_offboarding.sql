begin;

-- Retira el acceso operativo sin borrar la identidad ni romper referencias
-- historicas. Solo un owner activo del mismo gimnasio puede ejecutarlo.
create or replace function public.remove_staff_backend(
  target_gym_id uuid,
  target_staff_user_id uuid,
  target_removed_by uuid
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
  staff_record record;
begin
  select gu.profile_id into owner_profile_id
  from public.gym_users gu
  where gu.id = target_removed_by
    and gu.gym_id = target_gym_id
    and gu.role = 'owner'
    and gu.status = 'active'
    and gu.account_mode = 'portal';

  if owner_profile_id is null then
    raise exception 'STAFF_REMOVAL_REQUIRES_ACTIVE_OWNER' using errcode = '42501';
  end if;

  select gu.profile_id, gu.status, gu.invitation_id
    into staff_record
  from public.gym_users gu
  where gu.id = target_staff_user_id
    and gu.gym_id = target_gym_id
    and gu.role = 'staff'
    and gu.status in ('invited', 'active', 'suspended')
  for update;

  if not found then
    raise exception 'STAFF_USER_NOT_FOUND' using errcode = 'P0002';
  end if;

  if staff_record.invitation_id is not null then
    update public.gym_invitations invitation
    set status = 'revoked'
    where invitation.id = staff_record.invitation_id
      and invitation.gym_id = target_gym_id
      and invitation.status = 'pending';
  end if;

  delete from public.staff_permissions
  where gym_id = target_gym_id
    and staff_user_id = target_staff_user_id;

  delete from private.admin_elevation_sessions
  where gym_id = target_gym_id
    and staff_user_id = target_staff_user_id;

  delete from private.admin_pin_attempts
  where gym_id = target_gym_id
    and staff_user_id = target_staff_user_id;

  update public.gym_users
  set status = 'inactive'
  where id = target_staff_user_id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, before_data, after_data
  ) values (
    target_gym_id, owner_profile_id, target_removed_by,
    'staff.removed', 'gym_user', target_staff_user_id, 'staff.manage',
    jsonb_build_object('status', staff_record.status),
    jsonb_build_object('status', 'inactive', 'permissions', 'revoked')
  );

  return query select
    target_staff_user_id,
    staff_record.profile_id,
    'inactive'::public.gym_user_status;
end;
$$;

revoke all on function public.remove_staff_backend(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.remove_staff_backend(uuid, uuid, uuid)
  to service_role;

commit;
