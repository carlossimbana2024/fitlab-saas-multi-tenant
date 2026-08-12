-- Ejecutar despuÃ©s de 0019_identity_abuse_audit_managed_members.sql.
-- Usa un owner y una sucursal existentes; todo termina con ROLLBACK.
begin;

do $$
declare
  owner_record record;
  created_member record;
  first_rate_limit_hit boolean;
  second_rate_limit_hit boolean;
begin
  if has_function_privilege('authenticated', 'public.create_managed_member(uuid,uuid,text,text,date,text,text,text,uuid)', 'EXECUTE') then
    raise exception 'AUTHENTICATED_CAN_EXECUTE_CREATE_MANAGED_MEMBER';
  end if;
  if not has_function_privilege('service_role', 'public.create_managed_member(uuid,uuid,text,text,date,text,text,text,uuid)', 'EXECUTE') then
    raise exception 'SERVICE_ROLE_CANNOT_EXECUTE_CREATE_MANAGED_MEMBER';
  end if;
  if has_function_privilege('authenticated', 'public.consume_api_rate_limit(text,text,integer,integer)', 'EXECUTE') then
    raise exception 'AUTHENTICATED_CAN_CONSUME_RATE_LIMIT';
  end if;

  select gu.id as owner_user_id, gu.gym_id, gl.id as location_id
    into owner_record
  from public.gym_users gu
  join public.gym_locations gl on gl.gym_id = gu.gym_id and gl.is_active
  where gu.role = 'owner' and gu.status = 'active' and gu.profile_id is not null
  order by gl.is_main desc, gu.created_at
  limit 1;

  if owner_record.owner_user_id is null then
    raise exception 'TEST_REQUIRES_AN_ACTIVE_OWNER_AND_LOCATION';
  end if;

  select * into created_member
  from public.create_managed_member(
    owner_record.gym_id, owner_record.owner_user_id,
    'FitLab prueba miembro sin cuenta', null, date '1950-01-01',
    null, null, 'Registro temporal de la prueba 0019', owner_record.location_id
  );

  if created_member.account_mode <> 'managed' or created_member.member_status <> 'active' then
    raise exception 'MANAGED_MEMBER_WAS_NOT_CREATED_ACTIVE';
  end if;
  if not exists (
    select 1 from public.gym_users gu
    where gu.id = created_member.gym_user_id
      and gu.gym_id = owner_record.gym_id
      and gu.profile_id is null
      and gu.managed_full_name = 'FitLab prueba miembro sin cuenta'
  ) then
    raise exception 'MANAGED_MEMBER_IDENTITY_BOUNDARY_FAILED';
  end if;
  if not exists (
    select 1 from public.audit_logs al
    where al.entity_id = created_member.gym_user_id
      and al.action = 'member.managed_created'
  ) then
    raise exception 'MANAGED_MEMBER_AUDIT_WAS_NOT_WRITTEN';
  end if;

  first_rate_limit_hit := public.consume_api_rate_limit('test.migration_0019', repeat('a', 64), 1, 60);
  second_rate_limit_hit := public.consume_api_rate_limit('test.migration_0019', repeat('a', 64), 1, 60);
  if first_rate_limit_hit is distinct from true or second_rate_limit_hit is distinct from false then
    raise exception 'ATOMIC_RATE_LIMIT_FAILED';
  end if;

  raise notice '0019 OK: identidad sin cuenta, auditorÃ­a, privilegios RPC y rate limiting verificados.';
end;
$$;

rollback;
