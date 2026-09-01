-- Ejecutar despues de 0031_class_booking_policy_waitlist.sql.
-- Comprueba ventana de cancelacion, lista de espera y privilegios; termina con ROLLBACK.
begin;

do $$
declare
  function_name text;
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'class_waitlists'
  ) then raise exception 'CLASS_WAITLIST_TABLE_MISSING'; end if;

  if not exists (
    select 1 from pg_trigger trigger_record
    join pg_class table_record on table_record.oid = trigger_record.tgrelid
    join pg_namespace namespace_record on namespace_record.oid = table_record.relnamespace
    where namespace_record.nspname = 'public'
      and table_record.relname = 'class_bookings'
      and trigger_record.tgname = 'class_bookings_member_cancellation_window'
  ) then raise exception 'CLASS_CANCELLATION_WINDOW_TRIGGER_MISSING'; end if;

  foreach function_name in array array['join_class_waitlist_backend', 'leave_class_waitlist_backend'] loop
    if exists (
      select 1 from pg_proc function_record
      join pg_namespace namespace_record on namespace_record.oid = function_record.pronamespace
      where namespace_record.nspname = 'public'
        and function_record.proname = function_name
        and has_function_privilege('authenticated', function_record.oid, 'EXECUTE')
    ) then raise exception 'AUTHENTICATED_CAN_EXECUTE_%', upper(function_name); end if;
    if not exists (
      select 1 from pg_proc function_record
      join pg_namespace namespace_record on namespace_record.oid = function_record.pronamespace
      where namespace_record.nspname = 'public'
        and function_record.proname = function_name
        and has_function_privilege('service_role', function_record.oid, 'EXECUTE')
    ) then raise exception 'SERVICE_ROLE_CANNOT_EXECUTE_%', upper(function_name); end if;
  end loop;

  raise notice '0031 OK: ventana de cancelacion, lista de espera y privilegios comprobados.';
end;
$$;

rollback;
