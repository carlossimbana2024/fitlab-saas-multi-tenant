begin;

-- Stock consolidado y stock operativo por sucursal.
-- Los movimientos históricos sin sucursal siguen incluidos en el total global;
-- las nuevas operaciones de backend siempre exigen location_id.
create or replace view public.product_stock_levels_by_location
with (security_invoker = true)
as
select p.id as product_id,
       p.gym_id,
       im.location_id,
       coalesce(sum(im.quantity_delta), 0)::bigint as current_stock
from public.products p
join public.inventory_movements im on im.product_id = p.id
where im.location_id is not null
group by p.id, p.gym_id, im.location_id;

grant select on public.product_stock_levels_by_location to authenticated;

create or replace function private.authorize_commerce_actor(
  target_gym_id uuid,
  target_actor_gym_user_id uuid,
  target_permission_key text,
  supplied_used_pin_elevation boolean
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_record record;
  actor_access_mode public.permission_access_mode;
begin
  select gu.profile_id, gu.role, gu.status, gu.account_mode
    into actor_record
  from public.gym_users gu
  where gu.id = target_actor_gym_user_id
    and gu.gym_id = target_gym_id;

  if not found or actor_record.profile_id is null
     or actor_record.status <> 'active'
     or actor_record.account_mode <> 'portal' then
    raise exception 'COMMERCE_ACTOR_MUST_BE_ACTIVE_IN_GYM' using errcode = '42501';
  end if;

  if actor_record.role = 'owner' then
    return actor_record.profile_id;
  end if;
  if actor_record.role <> 'staff' then
    raise exception 'COMMERCE_ACTOR_ROLE_DENIED' using errcode = '42501';
  end if;

  select sp.access_mode into actor_access_mode
  from public.staff_permissions sp
  where sp.gym_id = target_gym_id
    and sp.staff_user_id = target_actor_gym_user_id
    and sp.permission_key = target_permission_key;

  if actor_access_mode = 'allowed'
     or (actor_access_mode = 'requires_pin' and coalesce(supplied_used_pin_elevation, false)) then
    return actor_record.profile_id;
  end if;

  raise exception 'COMMERCE_PERMISSION_DENIED' using errcode = '42501';
end;
$$;

revoke all on function private.authorize_commerce_actor(uuid, uuid, text, boolean)
  from public, anon, authenticated;

-- Las escrituras del catálogo pasan por el backend para conservar tenant,
-- auditoría y permisos en una sola operación.
create or replace function public.create_product_backend(
  target_gym_id uuid,
  target_actor_gym_user_id uuid,
  supplied_name text,
  supplied_sku text,
  supplied_description text,
  supplied_sale_price numeric,
  supplied_currency text,
  supplied_minimum_stock integer
)
returns public.products
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  created_product public.products;
begin
  actor_profile_id := private.authorize_commerce_actor(target_gym_id, target_actor_gym_user_id, 'products.manage', false);
  if supplied_name is null or char_length(trim(supplied_name)) not between 2 and 150
     or supplied_sku is null or char_length(trim(supplied_sku)) not between 1 and 80
     or supplied_sale_price is null or supplied_sale_price < 0
     or supplied_currency is null or supplied_currency !~ '^[A-Z]{3}$'
     or supplied_minimum_stock is null or supplied_minimum_stock < 0 then
    raise exception 'INVALID_PRODUCT_INPUT' using errcode = '22023';
  end if;

  insert into public.products(gym_id, name, sku, description, sale_price, currency, minimum_stock)
  values (target_gym_id, trim(supplied_name), trim(supplied_sku), nullif(trim(supplied_description), ''), supplied_sale_price, supplied_currency, supplied_minimum_stock)
  returning * into created_product;

  insert into public.audit_logs(gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id, permission_key, after_data)
  values (target_gym_id, actor_profile_id, target_actor_gym_user_id, 'product.created', 'product', created_product.id, 'products.manage', to_jsonb(created_product));
  return created_product;
end;
$$;

revoke all on function public.create_product_backend(uuid, uuid, text, text, text, numeric, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_product_backend(uuid, uuid, text, text, text, numeric, text, integer) to service_role;

create or replace function public.update_product_backend(
  target_gym_id uuid,
  target_product_id uuid,
  target_actor_gym_user_id uuid,
  supplied_name text,
  supplied_sku text,
  supplied_description text,
  supplied_sale_price numeric,
  supplied_currency text,
  supplied_minimum_stock integer,
  supplied_is_active boolean
)
returns public.products
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  before_product public.products;
  updated_product public.products;
begin
  actor_profile_id := private.authorize_commerce_actor(target_gym_id, target_actor_gym_user_id, 'products.manage', false);
  select * into before_product from public.products where id = target_product_id and gym_id = target_gym_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  if supplied_name is null or char_length(trim(supplied_name)) not between 2 and 150
     or supplied_sku is null or char_length(trim(supplied_sku)) not between 1 and 80
     or supplied_sale_price is null or supplied_sale_price < 0
     or supplied_currency is null or supplied_currency !~ '^[A-Z]{3}$'
     or supplied_minimum_stock is null or supplied_minimum_stock < 0
     or supplied_is_active is null then
    raise exception 'INVALID_PRODUCT_INPUT' using errcode = '22023';
  end if;

  update public.products
  set name = trim(supplied_name), sku = trim(supplied_sku), description = nullif(trim(supplied_description), ''),
      sale_price = supplied_sale_price, currency = supplied_currency, minimum_stock = supplied_minimum_stock,
      is_active = supplied_is_active, updated_at = now()
  where id = target_product_id and gym_id = target_gym_id
  returning * into updated_product;

  insert into public.audit_logs(gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id, permission_key, before_data, after_data)
  values (target_gym_id, actor_profile_id, target_actor_gym_user_id, 'product.updated', 'product', target_product_id, 'products.manage', to_jsonb(before_product), to_jsonb(updated_product));
  return updated_product;
end;
$$;

revoke all on function public.update_product_backend(uuid, uuid, uuid, text, text, text, numeric, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.update_product_backend(uuid, uuid, uuid, text, text, text, numeric, text, integer, boolean) to service_role;

create or replace function public.adjust_inventory_backend(
  target_gym_id uuid,
  target_location_id uuid,
  target_product_id uuid,
  target_actor_gym_user_id uuid,
  supplied_movement_type public.inventory_movement_type,
  supplied_quantity_delta integer,
  supplied_reason text,
  supplied_used_pin_elevation boolean
)
returns public.inventory_movements
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  created_movement public.inventory_movements;
begin
  actor_profile_id := private.authorize_commerce_actor(target_gym_id, target_actor_gym_user_id, 'inventory.adjust', supplied_used_pin_elevation);
  if target_location_id is null or target_product_id is null or supplied_quantity_delta is null or supplied_quantity_delta = 0
     or supplied_movement_type not in ('purchase', 'return', 'adjustment', 'loss')
     or nullif(trim(supplied_reason), '') is null then
    raise exception 'INVALID_INVENTORY_ADJUSTMENT' using errcode = '22023';
  end if;
  if supplied_movement_type in ('purchase', 'return') and supplied_quantity_delta < 1 then
    raise exception 'INVENTORY_INBOUND_QUANTITY_MUST_BE_POSITIVE' using errcode = '22023';
  end if;
  if supplied_movement_type = 'loss' and supplied_quantity_delta > -1 then
    raise exception 'INVENTORY_LOSS_QUANTITY_MUST_BE_NEGATIVE' using errcode = '22023';
  end if;
  if not exists (select 1 from public.gym_locations where id = target_location_id and gym_id = target_gym_id and is_active) then
    raise exception 'INVENTORY_LOCATION_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;
  if not exists (select 1 from public.products where id = target_product_id and gym_id = target_gym_id) then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.inventory_movements(gym_id, product_id, location_id, movement_type, quantity_delta, stock_before, stock_after, performed_by, reason)
  values (target_gym_id, target_product_id, target_location_id, supplied_movement_type, supplied_quantity_delta, 0, 0, target_actor_gym_user_id, trim(supplied_reason))
  returning * into created_movement;

  insert into public.audit_logs(gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id, permission_key, used_pin_elevation, after_data)
  values (target_gym_id, actor_profile_id, target_actor_gym_user_id, 'inventory.adjusted', 'inventory_movement', created_movement.id, 'inventory.adjust', coalesce(supplied_used_pin_elevation, false), to_jsonb(created_movement));
  return created_movement;
end;
$$;

revoke all on function public.adjust_inventory_backend(uuid, uuid, uuid, uuid, public.inventory_movement_type, integer, text, boolean)
  from public, anon, authenticated;
grant execute on function public.adjust_inventory_backend(uuid, uuid, uuid, uuid, public.inventory_movement_type, integer, text, boolean) to service_role;

-- Crea y completa una venta junto con su pago y el descuento de inventario.
-- La operación es atómica: si falla el pago o el stock, no queda venta parcial.
create or replace function public.register_product_sale_backend(
  target_gym_id uuid,
  target_location_id uuid,
  target_seller_user_id uuid,
  target_member_user_id uuid,
  supplied_items jsonb,
  supplied_discount numeric,
  supplied_payment_method public.member_payment_method,
  supplied_external_reference text,
  supplied_notes text,
  supplied_used_pin_elevation boolean
)
returns table(sale_id uuid, payment_id uuid, receipt_number bigint, total numeric, currency text, status public.sale_status)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  sale_record public.sales;
  payment_record public.member_payments;
  item_record record;
  final_currency text;
  calculated_subtotal numeric(12,2);
  calculated_total numeric(12,2);
begin
  actor_profile_id := private.authorize_commerce_actor(target_gym_id, target_seller_user_id, 'sales.register', supplied_used_pin_elevation);
  if target_location_id is null or supplied_items is null or jsonb_typeof(supplied_items) <> 'array' or jsonb_array_length(supplied_items) = 0
     or coalesce(supplied_discount, 0) < 0 or supplied_payment_method is null then
    raise exception 'INVALID_PRODUCT_SALE_INPUT' using errcode = '22023';
  end if;
  if not exists (select 1 from public.gym_locations where id = target_location_id and gym_id = target_gym_id and is_active) then
    raise exception 'SALE_LOCATION_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;
  if target_member_user_id is not null and not exists (
    select 1 from public.gym_users where id = target_member_user_id and gym_id = target_gym_id and role = 'member' and status = 'active'
  ) then
    raise exception 'SALE_MEMBER_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;

  insert into public.sales(gym_id, location_id, member_user_id, seller_user_id, discount, currency, status)
  values (target_gym_id, target_location_id, target_member_user_id, target_seller_user_id, coalesce(supplied_discount, 0), 'USD', 'draft')
  returning * into sale_record;

  for item_record in
    select item.product_id, sum(item.quantity)::integer as quantity
    from jsonb_to_recordset(supplied_items) as item(product_id uuid, quantity integer)
    group by item.product_id
  loop
    if item_record.product_id is null or item_record.quantity is null or item_record.quantity < 1 then
      raise exception 'INVALID_PRODUCT_SALE_ITEM' using errcode = '22023';
    end if;
    insert into public.sale_items(gym_id, sale_id, product_id, product_name_snapshot, unit_price, quantity)
    values (target_gym_id, sale_record.id, item_record.product_id, '', 0, item_record.quantity);
  end loop;

  select coalesce((select p.currency from public.products p join public.sale_items si on si.product_id = p.id where si.sale_id = sale_record.id limit 1), 'USD')
    into final_currency;
  if exists (select 1 from public.products p join public.sale_items si on si.product_id = p.id where si.sale_id = sale_record.id and p.currency <> final_currency) then
    raise exception 'SALE_PRODUCTS_MUST_USE_ONE_CURRENCY' using errcode = '22023';
  end if;

  select coalesce(sum(si.line_total), 0)::numeric(12,2)
    into calculated_subtotal
  from public.sale_items si
  where si.sale_id = sale_record.id;
  calculated_total := calculated_subtotal - coalesce(supplied_discount, 0);
  if calculated_subtotal <= 0 or calculated_total <= 0 then
    raise exception 'SALE_TOTAL_MUST_BE_POSITIVE' using errcode = '22023';
  end if;
  update public.sales
  set subtotal = calculated_subtotal, total = calculated_total, currency = final_currency
  where id = sale_record.id
  returning * into sale_record;

  insert into public.member_payments(gym_id, location_id, member_user_id, sale_id, amount, currency, payment_method, status, external_reference, notes, registered_by, paid_at)
  values (target_gym_id, target_location_id, target_member_user_id, sale_record.id, calculated_total, final_currency, supplied_payment_method, 'confirmed', nullif(trim(supplied_external_reference), ''), nullif(trim(supplied_notes), ''), target_seller_user_id, now())
  returning * into payment_record;

  update public.sales set status = 'completed' where id = sale_record.id returning * into sale_record;

  insert into public.audit_logs(gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id, permission_key, used_pin_elevation, after_data)
  values (target_gym_id, actor_profile_id, target_seller_user_id, 'sale.completed', 'sale', sale_record.id, 'sales.register', coalesce(supplied_used_pin_elevation, false), jsonb_build_object('payment_id', payment_record.id, 'receipt_number', payment_record.receipt_number, 'total', sale_record.total, 'location_id', sale_record.location_id));

  return query select sale_record.id, payment_record.id, payment_record.receipt_number, sale_record.total, sale_record.currency, sale_record.status;
end;
$$;

revoke all on function public.register_product_sale_backend(uuid, uuid, uuid, uuid, jsonb, numeric, public.member_payment_method, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.register_product_sale_backend(uuid, uuid, uuid, uuid, jsonb, numeric, public.member_payment_method, text, text, boolean) to service_role;

create or replace function public.reverse_product_sale_backend(
  target_gym_id uuid,
  target_sale_id uuid,
  target_actor_gym_user_id uuid,
  target_reversal_status public.sale_status,
  supplied_reason text,
  supplied_used_pin_elevation boolean
)
returns table(sale_id uuid, payment_id uuid, status public.sale_status)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  sale_record public.sales;
  payment_record public.member_payments;
begin
  actor_profile_id := private.authorize_commerce_actor(target_gym_id, target_actor_gym_user_id, 'sales.void', supplied_used_pin_elevation);
  if target_reversal_status not in ('voided', 'refunded') or nullif(trim(supplied_reason), '') is null then
    raise exception 'INVALID_PRODUCT_SALE_REVERSAL' using errcode = '22023';
  end if;
  select * into sale_record from public.sales where id = target_sale_id and gym_id = target_gym_id and status = 'completed' for update;
  if not found then raise exception 'REVERSIBLE_SALE_NOT_FOUND' using errcode = 'P0002'; end if;

  select * into payment_record from public.member_payments where sale_id = target_sale_id and status = 'confirmed' for update;
  if not found then raise exception 'SALE_CONFIRMED_PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;

  if target_reversal_status = 'voided' then
    update public.sales set status = 'voided', voided_at = now(), voided_by = target_actor_gym_user_id, void_reason = trim(supplied_reason) where id = target_sale_id;
    update public.member_payments set status = 'voided', voided_at = now(), voided_by = target_actor_gym_user_id, void_reason = trim(supplied_reason) where id = payment_record.id;
  else
    update public.sales set status = 'refunded' where id = target_sale_id;
    update public.member_payments set status = 'refunded', refunded_at = now(), refunded_by = target_actor_gym_user_id, refund_reason = trim(supplied_reason) where id = payment_record.id;
  end if;

  insert into public.audit_logs(gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id, permission_key, used_pin_elevation, before_data, after_data)
  values (target_gym_id, actor_profile_id, target_actor_gym_user_id, case when target_reversal_status = 'voided' then 'sale.voided' else 'sale.refunded' end, 'sale', target_sale_id, 'sales.void', coalesce(supplied_used_pin_elevation, false), jsonb_build_object('status', 'completed'), jsonb_build_object('status', target_reversal_status, 'reason', trim(supplied_reason)));

  return query select target_sale_id, payment_record.id, target_reversal_status;
end;
$$;

revoke all on function public.reverse_product_sale_backend(uuid, uuid, uuid, public.sale_status, text, boolean)
  from public, anon, authenticated;
grant execute on function public.reverse_product_sale_backend(uuid, uuid, uuid, public.sale_status, text, boolean) to service_role;

-- El cálculo de stock se vuelve por sucursal para toda nueva operación.
create or replace function private.validate_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  product_gym_id uuid;
  calculated_stock integer;
  sale_location_id uuid;
begin
  select p.gym_id into product_gym_id from public.products p where p.id = new.product_id for update;
  if product_gym_id is distinct from new.gym_id then
    raise exception 'INVENTORY_PRODUCT_TENANT_MISMATCH' using errcode = '23514';
  end if;
  if new.location_id is not null and not exists (
    select 1 from public.gym_locations gl where gl.id = new.location_id and gl.gym_id = new.gym_id and gl.is_active
  ) then
    raise exception 'INVENTORY_LOCATION_TENANT_MISMATCH' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.gym_users gu where gu.id = new.performed_by and gu.gym_id = new.gym_id
      and gu.role in ('owner', 'staff') and gu.status = 'active'
  ) then
    raise exception 'INVENTORY_ACTOR_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;
  if new.movement_type in ('sale', 'return') then
    select s.location_id into sale_location_id from public.sales s where s.id = new.sale_id and s.gym_id = new.gym_id;
    if sale_location_id is null or new.location_id is distinct from sale_location_id then
      raise exception 'SALE_INVENTORY_LOCATION_MISMATCH' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.sale_items si
      where si.sale_id = new.sale_id and si.product_id = new.product_id and si.gym_id = new.gym_id
    ) then
      raise exception 'SALE_INVENTORY_MOVEMENT_REQUIRES_MATCHING_ITEM' using errcode = '23514';
    end if;
  end if;
  if new.location_id is null then
    select coalesce(sum(im.quantity_delta), 0)::integer into calculated_stock
    from public.inventory_movements im where im.product_id = new.product_id;
  else
    select coalesce(sum(im.quantity_delta), 0)::integer into calculated_stock
    from public.inventory_movements im where im.product_id = new.product_id and im.location_id = new.location_id;
  end if;
  new.stock_before := calculated_stock;
  new.stock_after := calculated_stock + new.quantity_delta;
  if new.stock_after < 0 then
    raise exception 'INSUFFICIENT_STOCK' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_inventory_movement() from public, anon, authenticated;

commit;
