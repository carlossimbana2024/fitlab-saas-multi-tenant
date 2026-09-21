-- Ejecutar después de 0042_member_paid_class_reservations.sql.
-- Comprueba límites de seguridad y el flujo reserva-pago; todo se revierte.
begin;

do $$
declare
  member_function oid;
  paid_function oid;
  member_definition text;
  paid_definition text;
begin
  select function_record.oid, pg_get_functiondef(function_record.oid)
    into member_function, member_definition
  from pg_proc function_record
  join pg_namespace namespace_record on namespace_record.oid = function_record.pronamespace
  where namespace_record.nspname = 'public'
    and function_record.proname = 'reserve_member_class_backend';

  if member_function is null then
    raise exception 'MEMBER_CLASS_RESERVATION_RPC_MISSING';
  end if;
  if has_function_privilege('authenticated', member_function, 'EXECUTE')
     or has_function_privilege('anon', member_function, 'EXECUTE') then
    raise exception 'MEMBER_CLASS_RESERVATION_RPC_IS_PUBLIC';
  end if;
  if not has_function_privilege('service_role', member_function, 'EXECUTE') then
    raise exception 'SERVICE_ROLE_CANNOT_RESERVE_MEMBER_CLASS';
  end if;
  if position('MEMBER_CAN_ONLY_BOOK_SELF' in member_definition) = 0
     or position('class_member_coverage' in member_definition) = 0
     or position('additional_fee' in member_definition) = 0
     or position('for update' in lower(member_definition)) = 0 then
    raise exception 'MEMBER_CLASS_RESERVATION_GUARDS_MISSING';
  end if;

  select function_record.oid, pg_get_functiondef(function_record.oid)
    into paid_function, paid_definition
  from pg_proc function_record
  join pg_namespace namespace_record on namespace_record.oid = function_record.pronamespace
  where namespace_record.nspname = 'public'
    and function_record.proname = 'reserve_paid_class_backend';

  if paid_function is null then
    raise exception 'PAID_CLASS_RESERVATION_RPC_MISSING';
  end if;
  if has_function_privilege('authenticated', paid_function, 'EXECUTE')
     or has_function_privilege('anon', paid_function, 'EXECUTE') then
    raise exception 'PAID_CLASS_RESERVATION_RPC_IS_PUBLIC';
  end if;
  if position('existing_booking.status = ''reserved''' in paid_definition) = 0
     or position('existing_booking.payment_id is null' in paid_definition) = 0
     or position('class.booking_payment_confirmed' in paid_definition) = 0 then
    raise exception 'EXISTING_UNPAID_BOOKING_FLOW_MISSING';
  end if;

  raise notice '0042 OK: reserva propia, aislamiento backend-only y cobro presencial sobre reserva existente comprobados.';
end;
$$;

rollback;
