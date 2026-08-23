-- Ejecutar después de 0028_inventory_sales_backend.sql.
-- Comprueba privilegios backend y termina con ROLLBACK.
begin;

do $$
declare
  function_name text;
begin
  foreach function_name in array array[
    'create_product_backend(uuid,uuid,text,text,text,numeric,text,integer)',
    'update_product_backend(uuid,uuid,uuid,text,text,text,numeric,text,integer,boolean)',
    'adjust_inventory_backend(uuid,uuid,uuid,uuid,public.inventory_movement_type,integer,text,boolean)',
    'register_product_sale_backend(uuid,uuid,uuid,uuid,jsonb,numeric,public.member_payment_method,text,text,boolean)',
    'reverse_product_sale_backend(uuid,uuid,uuid,public.sale_status,text,boolean)'
  ]
  loop
    if has_function_privilege('authenticated', 'public.' || function_name, 'EXECUTE') then
      raise exception 'AUTHENTICATED_CAN_EXECUTE_COMMERCE_FUNCTION_%', function_name;
    end if;
    if not has_function_privilege('service_role', 'public.' || function_name, 'EXECUTE') then
      raise exception 'SERVICE_ROLE_CANNOT_EXECUTE_COMMERCE_FUNCTION_%', function_name;
    end if;
  end loop;

  if not exists (
    select 1 from pg_views
    where schemaname = 'public' and viewname = 'product_stock_levels_by_location'
  ) then
    raise exception 'PRODUCT_STOCK_BY_LOCATION_VIEW_MISSING';
  end if;

  raise notice '0028 OK: stock por sucursal, ventas atomicas y reversiones backend-only comprobados.';
end;
$$;

rollback;
