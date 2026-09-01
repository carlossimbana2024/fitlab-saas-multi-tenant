-- Ejecutar despues de 0030_extra_activities_bookings_payments.sql.
-- Comprueba estructura y privilegios; todo termina con ROLLBACK.
begin;

do $$
declare
  function_name text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'extra_classes'
      and column_name = 'billing_mode'
  ) then raise exception 'EXTRA_CLASS_BILLING_MODE_MISSING'; end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'member_payments'
      and column_name = 'class_booking_id'
  ) then raise exception 'CLASS_PAYMENT_REFERENCE_MISSING'; end if;

  if not exists (
    select 1 from public.permission_catalog
    where key = 'classes.attendance_manage'
  ) then raise exception 'CLASS_ATTENDANCE_PERMISSION_MISSING'; end if;

  foreach function_name in array array[
    'create_extra_class_backend',
    'update_extra_class_backend',
    'create_class_schedule_backend',
    'cancel_class_schedule_backend',
    'reserve_included_class_backend',
    'reserve_paid_class_backend',
    'cancel_class_booking_backend',
    'mark_class_booking_attendance_backend',
    'refund_class_booking_backend'
  ] loop
    if exists (
      select 1 from pg_proc function_record
      join pg_namespace namespace_record on namespace_record.oid = function_record.pronamespace
      where namespace_record.nspname = 'public'
        and function_record.proname = function_name
        and has_function_privilege('authenticated', function_record.oid, 'EXECUTE')
    ) then
      raise exception 'AUTHENTICATED_CAN_EXECUTE_%', upper(function_name);
    end if;
    if not exists (
      select 1 from pg_proc function_record
      join pg_namespace namespace_record on namespace_record.oid = function_record.pronamespace
      where namespace_record.nspname = 'public'
        and function_record.proname = function_name
        and has_function_privilege('service_role', function_record.oid, 'EXECUTE')
    ) then
      raise exception 'SERVICE_ROLE_CANNOT_EXECUTE_%', upper(function_name);
    end if;
  end loop;

  raise notice '0030 OK: actividades, reservas, cobros y asistencia de clases comprobados.';
end;
$$;

rollback;
