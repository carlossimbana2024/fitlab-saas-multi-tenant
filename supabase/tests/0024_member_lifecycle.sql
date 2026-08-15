-- Ejecutar despues de 0024_member_lifecycle.sql.
-- Usa un miembro administrado existente y termina con ROLLBACK.
begin;

do $$
declare
  owner_record record;
  member_record record;
  updated_record record;
  status_record record;
  audit_before bigint;
  audit_after bigint;
begin
  if has_function_privilege(
    'authenticated',
    'public.update_member_backend(uuid,uuid,uuid,text,text,date,text,text,text,uuid,boolean)',
    'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_UPDATE_MEMBER';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.change_member_status_backend(uuid,uuid,uuid,gym_user_status,boolean)',
    'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_CHANGE_MEMBER_STATUS';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.convert_managed_member_to_portal_backend(uuid,uuid,uuid,text,uuid,text,timestamp with time zone,boolean)',
    'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_CONVERT_MEMBER';
  end if;

  select gu.id as owner_user_id, gu.gym_id
    into owner_record
  from public.gym_users gu
  where gu.role = 'owner' and gu.status = 'active'
  order by gu.created_at
  limit 1;

  if owner_record.owner_user_id is null then
    raise exception 'TEST_REQUIRES_ACTIVE_OWNER';
  end if;

  select gu.* into member_record
  from public.gym_users gu
  where gu.gym_id = owner_record.gym_id
    and gu.role = 'member'
    and gu.account_mode = 'managed'
    and gu.status = 'active'
  order by gu.created_at
  limit 1;

  if member_record.id is not null then
    select count(*) into audit_before
    from public.audit_logs log
    where log.gym_id = owner_record.gym_id
      and log.entity_id = member_record.id;

    select * into updated_record
    from public.update_member_backend(
      owner_record.gym_id, member_record.id, owner_record.owner_user_id,
      member_record.managed_full_name, member_record.managed_phone,
      member_record.managed_birth_date, member_record.managed_guardian_name,
      member_record.managed_guardian_phone, member_record.managed_notes,
      member_record.default_location_id, false
    );

    if updated_record.gym_user_id is distinct from member_record.id then
      raise exception 'MEMBER_UPDATE_CHANGED_IDENTITY';
    end if;

    select * into status_record
    from public.change_member_status_backend(
      owner_record.gym_id, member_record.id, owner_record.owner_user_id,
      'suspended', false
    );
    if status_record.member_status <> 'suspended' then
      raise exception 'MEMBER_WAS_NOT_SUSPENDED';
    end if;

    select * into status_record
    from public.change_member_status_backend(
      owner_record.gym_id, member_record.id, owner_record.owner_user_id,
      'active', false
    );
    if status_record.member_status <> 'active' then
      raise exception 'MEMBER_WAS_NOT_REACTIVATED';
    end if;

    select count(*) into audit_after
    from public.audit_logs log
    where log.gym_id = owner_record.gym_id
      and log.entity_id = member_record.id;
    if audit_after < audit_before + 3 then
      raise exception 'MEMBER_LIFECYCLE_WAS_NOT_AUDITED';
    end if;
  end if;

  raise notice '0024 OK: escrituras privadas, ciclo de vida reversible e historial preservado.';
end;
$$;

rollback;
