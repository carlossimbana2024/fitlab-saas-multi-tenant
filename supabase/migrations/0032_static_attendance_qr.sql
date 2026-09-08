begin;
set local lock_timeout = '5s';

-- Un cartel vigente por sucursal. Solo se conserva el hash del secreto.
create table public.attendance_qr_codes (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id),
  location_id uuid not null references public.gym_locations(id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.gym_users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.gym_users(id),
  expires_at timestamptz,
  check ((revoked_at is null) = (revoked_by is null))
);
create unique index attendance_qr_one_current_location
  on public.attendance_qr_codes(location_id) where revoked_at is null;
create index attendance_qr_gym_created_idx
  on public.attendance_qr_codes(gym_id, created_at desc);
-- Reutiliza la misma defensa multi-tenant aplicada al resto de referencias.
create trigger attendance_qr_location_tenant
before insert or update of gym_id, location_id on public.attendance_qr_codes
for each row execute function private.enforce_tenant_reference('location_id', 'gym_locations');
create trigger attendance_qr_creator_tenant
before insert or update of gym_id, created_by on public.attendance_qr_codes
for each row execute function private.enforce_tenant_reference('created_by', 'gym_users');
create trigger attendance_qr_revoker_tenant
before insert or update of gym_id, revoked_by on public.attendance_qr_codes
for each row execute function private.enforce_tenant_reference('revoked_by', 'gym_users');
alter table public.attendance_qr_codes enable row level security;
revoke all on public.attendance_qr_codes from public, anon, authenticated;
grant select, insert, update on public.attendance_qr_codes to service_role;

alter table public.attendances add column attendance_qr_code_id uuid references public.attendance_qr_codes(id);
-- Impide saltarse el backend usando directamente la API de Supabase.
drop policy if exists attendances_insert_qr on public.attendances;

create function private.validate_attendance_qr_code()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE' then
    if new.attendance_qr_code_id is distinct from old.attendance_qr_code_id then
      raise exception 'ATTENDANCE_QR_PROVENANCE_IMMUTABLE';
    end if;
  elsif new.source = 'qr' then
    perform 1 from public.attendance_qr_codes q
      where q.id = new.attendance_qr_code_id and q.gym_id = new.gym_id
        and q.location_id = new.location_id and q.revoked_at is null
        and (q.expires_at is null or q.expires_at > now()) for share;
    if not found then raise exception 'ATTENDANCE_QR_INVALID'; end if;
  elsif new.attendance_qr_code_id is not null then
    raise exception 'ATTENDANCE_QR_SOURCE_MISMATCH';
  end if;
  return new;
end;
$$;
create trigger attendances_validate_qr_code before insert or update on public.attendances
  for each row execute function private.validate_attendance_qr_code();
revoke all on function private.validate_attendance_qr_code() from public, anon, authenticated;

create function public.manage_attendance_qr_backend(
  target_gym_id uuid, target_actor_id uuid, target_location_id uuid,
  supplied_action text, supplied_token_hash text default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  actor_profile uuid;
  branch public.gym_locations%rowtype;
  old_code public.attendance_qr_codes%rowtype;
  new_code public.attendance_qr_codes%rowtype;
begin
  select gu.profile_id into actor_profile from public.gym_users gu
    where gu.id = target_actor_id and gu.gym_id = target_gym_id
      and gu.role = 'owner' and gu.status = 'active';
  if actor_profile is null then raise exception 'ATTENDANCE_QR_OWNER_REQUIRED'; end if;
  if supplied_action is null or supplied_action not in ('generate', 'revoke') then
    raise exception 'ATTENDANCE_QR_INVALID_ACTION';
  end if;
  select * into branch from public.gym_locations gl
    where gl.id = target_location_id and gl.gym_id = target_gym_id for update;
  if not found then raise exception 'ATTENDANCE_LOCATION_MISMATCH'; end if;
  if supplied_action = 'generate' and not branch.is_active then
    raise exception 'ATTENDANCE_LOCATION_MISMATCH';
  end if;
  select * into old_code from public.attendance_qr_codes q
    where q.location_id = branch.id and q.revoked_at is null for update;
  if old_code.id is not null then
    update public.attendance_qr_codes q set revoked_at = now(), revoked_by = target_actor_id
      where q.id = old_code.id;
  end if;
  if supplied_action = 'generate' then
    insert into public.attendance_qr_codes(gym_id, location_id, token_hash, created_by)
      values(target_gym_id, branch.id, supplied_token_hash, target_actor_id) returning * into new_code;
  end if;
  if old_code.id is not null or new_code.id is not null then
    insert into public.audit_logs(gym_id, actor_profile_id, actor_gym_user_id, action,
      entity_type, entity_id, used_pin_elevation, before_data, after_data)
    values(target_gym_id, actor_profile, target_actor_id,
      case when supplied_action = 'revoke' then 'attendance.qr_revoked'
        when old_code.id is not null then 'attendance.qr_regenerated' else 'attendance.qr_created' end,
      'gym_location', branch.id, false,
      case when old_code.id is not null then jsonb_build_object('location_name', branch.name, 'status', 'active') end,
      jsonb_build_object('location_name', branch.name, 'status', case when supplied_action = 'revoke' then 'revoked' else 'active' end));
  end if;
  return jsonb_build_object('id', new_code.id, 'created_at', new_code.created_at, 'location_name', branch.name);
end;
$$;

-- Un mismo contexto se usa para vista previa y confirmación. La fecha siempre
-- procede del servidor y conserva la zona horaria canónica del gimnasio.
create function private.attendance_qr_context(target_gym_id uuid, target_member_id uuid, supplied_token_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  member_record public.gym_users%rowtype;
  code_record public.attendance_qr_codes%rowtype;
  gym_record public.gyms%rowtype;
  branch_name text;
  today date;
  existing jsonb;
  coverage jsonb;
begin
  select * into member_record from public.gym_users gu
    where gu.id = target_member_id and gu.gym_id = target_gym_id;
  if not found or member_record.role <> 'member' or member_record.status <> 'active' then
    raise exception 'ATTENDANCE_REQUIRES_ACTIVE_MEMBER';
  end if;
  if member_record.account_mode <> 'portal' or member_record.profile_id is null then
    raise exception 'ATTENDANCE_QR_PORTAL_REQUIRED';
  end if;
  select * into code_record from public.attendance_qr_codes q
    where q.token_hash = supplied_token_hash and q.gym_id = target_gym_id
      and q.revoked_at is null and (q.expires_at is null or q.expires_at > now()) for share;
  if not found then raise exception 'ATTENDANCE_QR_INVALID'; end if;
  select gl.name into branch_name from public.gym_locations gl
    where gl.id = code_record.location_id and gl.gym_id = target_gym_id and gl.is_active;
  if not found then raise exception 'ATTENDANCE_LOCATION_MISMATCH'; end if;
  select * into gym_record from public.gyms g where g.id = target_gym_id;
  today := (now() at time zone gym_record.timezone)::date;
  select jsonb_build_object('id', a.id, 'checked_in_at', a.checked_in_at,
    'attendance_date', a.attendance_date, 'location_name', gl.name) into existing
    from public.attendances a join public.gym_locations gl on gl.id = a.location_id
    where a.member_user_id = target_member_id and a.gym_id = target_gym_id
      and a.attendance_date = today and a.status = 'valid';
  select jsonb_build_object('id', m.id, 'plan_name', p.name, 'ends_on', mp.ends_on) into coverage
    from public.memberships m join public.membership_periods mp on mp.membership_id = m.id
      join public.plans p on p.id = m.plan_id
    where m.gym_id = target_gym_id and m.member_user_id = target_member_id and m.status = 'active'
      and mp.gym_id = target_gym_id and mp.status = 'active' and today between mp.starts_on and mp.ends_on
    order by mp.ends_on desc, m.id limit 1;
  if existing is null and coverage is null then raise exception 'ACTIVE_MEMBERSHIP_PERIOD_REQUIRED'; end if;
  return jsonb_build_object('gym_name', gym_record.name, 'location_name', branch_name,
    'location_id', code_record.location_id, 'qr_code_id', code_record.id,
    'timezone', gym_record.timezone, 'today', today, 'server_time', now(),
    'membership', coverage, 'attendance', existing, 'already_registered', existing is not null);
end;
$$;

create function public.preview_attendance_qr_backend(target_gym_id uuid, target_member_id uuid, supplied_token_hash text)
returns jsonb language sql security definer set search_path = pg_catalog, public as $$
  select private.attendance_qr_context(target_gym_id, target_member_id, supplied_token_hash);
$$;

create function public.register_attendance_qr_backend(target_gym_id uuid, target_member_id uuid, supplied_token_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  context jsonb;
  inserted public.attendances%rowtype;
  actor_profile uuid;
begin
  context := private.attendance_qr_context(target_gym_id, target_member_id, supplied_token_hash);
  if (context->>'already_registered')::boolean then return context; end if;
  begin
    insert into public.attendances(gym_id, location_id, member_user_id, membership_id,
      attendance_date, source, registered_by, attendance_qr_code_id)
    values(target_gym_id, (context->>'location_id')::uuid, target_member_id,
      (context->'membership'->>'id')::uuid, (context->>'today')::date, 'qr', target_member_id,
      (context->>'qr_code_id')::uuid) returning * into inserted;
  exception when unique_violation then
    -- Incluye una carrera con recepción. El índice diario sigue siendo la autoridad.
    context := private.attendance_qr_context(target_gym_id, target_member_id, supplied_token_hash);
    if (context->>'already_registered')::boolean then return context; end if;
    raise;
  end;
  select gu.profile_id into actor_profile from public.gym_users gu where gu.id = target_member_id;
  insert into public.audit_logs(gym_id, actor_profile_id, actor_gym_user_id, action,
    entity_type, entity_id, used_pin_elevation, after_data)
  values(target_gym_id, actor_profile, target_member_id, 'attendance.registered_by_qr',
    'attendance', inserted.id, false, jsonb_build_object('location_name', context->>'location_name',
      'source', 'qr', 'attendance_date', inserted.attendance_date));
  return context || jsonb_build_object('attendance', jsonb_build_object('id', inserted.id,
    'checked_in_at', inserted.checked_in_at, 'attendance_date', inserted.attendance_date,
    'location_name', context->>'location_name'));
end;
$$;

revoke all on function private.attendance_qr_context(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.manage_attendance_qr_backend(uuid,uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.preview_attendance_qr_backend(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.register_attendance_qr_backend(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.manage_attendance_qr_backend(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.preview_attendance_qr_backend(uuid,uuid,text) to service_role;
grant execute on function public.register_attendance_qr_backend(uuid,uuid,text) to service_role;
commit;
