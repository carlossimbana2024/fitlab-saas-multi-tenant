-- Ejecutar después de 0043_gym_announcements.sql. Todo se revierte.
begin;
set local lock_timeout = '5s';

do $$
declare
  gym_a uuid := gen_random_uuid();
  gym_b uuid := gen_random_uuid();
  owner_profile uuid := gen_random_uuid();
  owner_id uuid;
  branch_b uuid;
  rejected boolean := false;
begin
  if has_table_privilege('anon', 'public.gym_announcements', 'SELECT')
     or has_table_privilege('authenticated', 'public.gym_announcements', 'SELECT')
     or has_table_privilege('authenticated', 'public.gym_announcements', 'INSERT')
     or not has_table_privilege('service_role', 'public.gym_announcements', 'SELECT') then
    raise exception 'ANNOUNCEMENT_PRIVILEGES_INVALID';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.gym_announcements'::regclass) then
    raise exception 'ANNOUNCEMENT_RLS_DISABLED';
  end if;

  insert into auth.users(id, email) values (owner_profile, owner_profile || '@announcements.invalid');
  insert into public.profiles(id, full_name) values (owner_profile, 'Owner prueba avisos');
  insert into public.gyms(id, name, slug) values
    (gym_a, 'Gym avisos A', 'announcements-a-' || gym_a),
    (gym_b, 'Gym avisos B', 'announcements-b-' || gym_b);
  insert into public.gym_users(gym_id, profile_id, role, status)
    values (gym_a, owner_profile, 'owner', 'active') returning id into owner_id;
  insert into public.gym_locations(gym_id, name) values (gym_b, 'Sucursal B') returning id into branch_b;

  begin
    insert into public.gym_announcements(gym_id, location_id, body, created_by)
      values (gym_a, branch_b, 'No debe publicarse en otra sucursal', owner_id);
  exception when others then
    if position('TENANT_REFERENCE_MISMATCH' in sqlerrm) > 0 then
      rejected := true;
    else
      raise;
    end if;
  end;
  if not rejected then raise exception 'CROSS_TENANT_ANNOUNCEMENT_ACCEPTED'; end if;
  raise notice '0043 OK: privilegios, RLS y sucursal de otro gimnasio rechazados.';
end;
$$;

rollback;
