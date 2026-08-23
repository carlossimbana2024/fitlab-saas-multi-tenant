begin;

-- Corrige la ambigüedad de `status` introducida por los parámetros OUT de
-- RETURNS TABLE. En PL/pgSQL, el campo de salida `status` también es una
-- variable local; por eso las columnas deben estar calificadas con alias.

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
  if not exists (
    select 1
    from public.gym_locations gl
    where gl.id = target_location_id
      and gl.gym_id = target_gym_id
      and gl.is_active
  ) then
    raise exception 'SALE_LOCATION_MUST_BE_ACTIVE_IN_SAME_GYM' using errcode = '23514';
  end if;
  if target_member_user_id is not null and not exists (
    select 1
    from public.gym_users gu
    where gu.id = target_member_user_id
      and gu.gym_id = target_gym_id
      and gu.role = 'member'
      and gu.status = 'active'
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
  update public.sales s
  set subtotal = calculated_subtotal, total = calculated_total, currency = final_currency
  where s.id = sale_record.id
  returning s.* into sale_record;

  insert into public.member_payments(gym_id, location_id, member_user_id, sale_id, amount, currency, payment_method, status, external_reference, notes, registered_by, paid_at)
  values (target_gym_id, target_location_id, target_member_user_id, sale_record.id, calculated_total, final_currency, supplied_payment_method, 'confirmed', nullif(trim(supplied_external_reference), ''), nullif(trim(supplied_notes), ''), target_seller_user_id, now())
  returning * into payment_record;

  update public.sales s
  set status = 'completed'
  where s.id = sale_record.id
  returning s.* into sale_record;

  insert into public.audit_logs(gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id, permission_key, used_pin_elevation, after_data)
  values (target_gym_id, actor_profile_id, target_seller_user_id, 'sale.completed', 'sale', sale_record.id, 'sales.register', coalesce(supplied_used_pin_elevation, false), jsonb_build_object('payment_id', payment_record.id, 'receipt_number', payment_record.receipt_number, 'total', sale_record.total, 'location_id', sale_record.location_id));

  return query select sale_record.id, payment_record.id, payment_record.receipt_number, sale_record.total, sale_record.currency, sale_record.status;
end;
$$;

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
  select s.*
  into sale_record
  from public.sales s
  where s.id = target_sale_id
    and s.gym_id = target_gym_id
    and s.status = 'completed'
  for update;
  if not found then raise exception 'REVERSIBLE_SALE_NOT_FOUND' using errcode = 'P0002'; end if;

  select p.*
  into payment_record
  from public.member_payments p
  where p.sale_id = target_sale_id
    and p.status = 'confirmed'
  for update;
  if not found then raise exception 'SALE_CONFIRMED_PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;

  if target_reversal_status = 'voided' then
    update public.sales s
    set status = 'voided', voided_at = now(), voided_by = target_actor_gym_user_id, void_reason = trim(supplied_reason)
    where s.id = target_sale_id;
    update public.member_payments p
    set status = 'voided', voided_at = now(), voided_by = target_actor_gym_user_id, void_reason = trim(supplied_reason)
    where p.id = payment_record.id;
  else
    update public.sales s set status = 'refunded' where s.id = target_sale_id;
    update public.member_payments p
    set status = 'refunded', refunded_at = now(), refunded_by = target_actor_gym_user_id, refund_reason = trim(supplied_reason)
    where p.id = payment_record.id;
  end if;

  insert into public.audit_logs(gym_id, actor_profile_id, actor_gym_user_id, action, entity_type, entity_id, permission_key, used_pin_elevation, before_data, after_data)
  values (target_gym_id, actor_profile_id, target_actor_gym_user_id, case when target_reversal_status = 'voided' then 'sale.voided' else 'sale.refunded' end, 'sale', target_sale_id, 'sales.void', coalesce(supplied_used_pin_elevation, false), jsonb_build_object('status', 'completed'), jsonb_build_object('status', target_reversal_status, 'reason', trim(supplied_reason)));

  return query select target_sale_id, payment_record.id, target_reversal_status;
end;
$$;

revoke all on function public.register_product_sale_backend(uuid, uuid, uuid, uuid, jsonb, numeric, public.member_payment_method, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.register_product_sale_backend(uuid, uuid, uuid, uuid, jsonb, numeric, public.member_payment_method, text, text, boolean) to service_role;

revoke all on function public.reverse_product_sale_backend(uuid, uuid, uuid, public.sale_status, text, boolean)
  from public, anon, authenticated;
grant execute on function public.reverse_product_sale_backend(uuid, uuid, uuid, public.sale_status, text, boolean) to service_role;

commit;
