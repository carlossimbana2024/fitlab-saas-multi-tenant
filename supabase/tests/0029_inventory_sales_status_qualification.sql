-- Ejecutar después de 0029_inventory_sales_status_qualification.sql.
-- Comprueba que las columnas status ambiguas estén calificadas y que las
-- mutaciones sigan siendo backend-only. No crea datos persistentes.
begin;

do $$
declare
  register_definition text;
  reverse_definition text;
begin
  select pg_get_functiondef(
    'public.register_product_sale_backend(uuid,uuid,uuid,uuid,jsonb,numeric,public.member_payment_method,text,text,boolean)'::regprocedure
  ) into register_definition;

  select pg_get_functiondef(
    'public.reverse_product_sale_backend(uuid,uuid,uuid,public.sale_status,text,boolean)'::regprocedure
  ) into reverse_definition;

  if position('gu.status = ''active''' in register_definition) = 0 then
    raise exception 'REGISTER_MEMBER_STATUS_IS_NOT_QUALIFIED';
  end if;
  if position('and status = ''active''' in register_definition) > 0 then
    raise exception 'REGISTER_MEMBER_STATUS_REMAINS_AMBIGUOUS';
  end if;
  if position('s.status = ''completed''' in reverse_definition) = 0 then
    raise exception 'REVERSE_SALE_STATUS_IS_NOT_QUALIFIED';
  end if;
  if position('p.status = ''confirmed''' in reverse_definition) = 0 then
    raise exception 'REVERSE_PAYMENT_STATUS_IS_NOT_QUALIFIED';
  end if;
  if position('and status = ''completed''' in reverse_definition) > 0
     or position('and status = ''confirmed''' in reverse_definition) > 0 then
    raise exception 'REVERSE_STATUS_REMAINS_AMBIGUOUS';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.register_product_sale_backend(uuid,uuid,uuid,uuid,jsonb,numeric,public.member_payment_method,text,text,boolean)',
    'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_EXECUTE_REGISTER_PRODUCT_SALE';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.reverse_product_sale_backend(uuid,uuid,uuid,public.sale_status,text,boolean)',
    'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_EXECUTE_REVERSE_PRODUCT_SALE';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.register_product_sale_backend(uuid,uuid,uuid,uuid,jsonb,numeric,public.member_payment_method,text,text,boolean)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.reverse_product_sale_backend(uuid,uuid,uuid,public.sale_status,text,boolean)',
    'EXECUTE'
  ) then
    raise exception 'SERVICE_ROLE_CANNOT_EXECUTE_COMMERCE_FUNCTIONS';
  end if;

  raise notice '0029 OK: referencias status calificadas y funciones backend-only comprobadas.';
end;
$$;

rollback;
