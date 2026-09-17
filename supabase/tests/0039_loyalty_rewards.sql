-- Ejecutar DESPUÉS de 0039_loyalty_rewards.sql. Fixtures aisladas; todo se revierte.
begin;
set local lock_timeout = '5s';
create function pg_temp.expect_loyalty_failure(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if position(expected in sqlerrm)>0 then return; end if;
    raise;
  end;
  raise exception 'EXPECTED_FAILURE_NOT_RAISED: %',expected;
end; $$;

do $$
declare
  g uuid:=gen_random_uuid(); other_g uuid:=gen_random_uuid(); branch uuid:=gen_random_uuid(); other_branch uuid:=gen_random_uuid();
  owner_profile uuid:=gen_random_uuid(); member_profile uuid:=gen_random_uuid(); owner_id uuid:=gen_random_uuid();
  member_id uuid:=gen_random_uuid(); second_member uuid:=gen_random_uuid(); plan_id uuid:=gen_random_uuid(); product_id uuid:=gen_random_uuid();
  today date:=(now() at time zone 'America/Guayaquil')::date;
  p public.gym_promotions; perfect public.gym_promotions; free_p public.gym_promotions; product_p public.gym_promotions;
  r public.member_rewards; free_r public.member_rewards; product_r public.member_rewards; revoked public.member_rewards;
  checkout record; first_checkout record; second_checkout record; free_checkout record; redemption public.reward_redemptions;
  input jsonb; result jsonb; count_before integer; func text; attendance_id uuid;
begin
  foreach func in array array[
    'public.save_promotion_backend(uuid,uuid,uuid,jsonb)','public.set_promotion_status_backend(uuid,uuid,uuid,text)',
    'public.member_loyalty_backend(uuid,uuid,uuid)','public.claim_reward_backend(uuid,uuid,uuid,uuid)',
    'public.redeem_product_reward_backend(uuid,uuid,uuid)','public.revoke_reward_backend(uuid,uuid,uuid,text)',
    'public.register_manual_membership_checkout(uuid,uuid,uuid,uuid,uuid,public.member_payment_method,text,text,uuid,boolean,uuid)'
  ] loop
    if has_function_privilege('anon',func,'EXECUTE') or has_function_privilege('authenticated',func,'EXECUTE')
      or not has_function_privilege('service_role',func,'EXECUTE') then raise exception 'UNSAFE_RPC: %',func; end if;
  end loop;
  if has_table_privilege('authenticated','public.gym_promotions','SELECT')
    or has_table_privilege('authenticated','public.member_rewards','INSERT')
    or has_table_privilege('anon','public.reward_redemptions','SELECT') then raise exception 'DIRECT_TABLE_ACCESS'; end if;
  if exists(select 1 from pg_class where oid in ('public.gym_promotions'::regclass,'public.member_rewards'::regclass,'public.reward_redemptions'::regclass) and not relrowsecurity) then raise exception 'RLS_NOT_ENABLED'; end if;

  insert into auth.users(id,email) values(owner_profile,owner_profile||'@loyalty.invalid'),(member_profile,member_profile||'@loyalty.invalid');
  insert into public.profiles(id,full_name) values(owner_profile,'Owner loyalty'),(member_profile,'Member loyalty');
  insert into public.gyms(id,name,slug) values(g,'Gym loyalty','loyalty-'||g),(other_g,'Other gym','loyalty-'||other_g);
  insert into public.gym_locations(id,gym_id,name) values(branch,g,'Principal'),(other_branch,other_g,'Otra');
  insert into public.gym_users(id,gym_id,profile_id,role,status,default_location_id)
    values(owner_id,g,owner_profile,'owner','active',branch),(member_id,g,member_profile,'member','active',branch);
  insert into public.gym_users(id,gym_id,role,status,account_mode,managed_full_name,default_location_id,joined_at)
    values(second_member,g,'member','active','managed','Miembro sin portal',branch,now());
  insert into public.location_opening_hours(gym_id,location_id,weekday,opens_at,closes_at,day_mode)
    select g,branch,n::smallint,'00:00'::time,'00:00'::time,'required'::public.calendar_day_mode from generate_series(1,7)n;
  insert into public.plans(id,gym_id,name,price,duration_unit,duration_value,attendance_mode)
    values(plan_id,g,'Mensual',100,'months',1,'daily');
  -- Original ten-argument signature still works unchanged.
  select * into first_checkout from public.register_manual_membership_checkout(g,branch,member_id,plan_id,owner_id,'cash',null,null,null,false);
  select * into second_checkout from public.register_manual_membership_checkout(g,branch,second_member,plan_id,owner_id,'cash',null,null,null,false);
  if first_checkout.charged_amount<>100 or first_checkout.receipt_number is null then raise exception 'LEGACY_CHECKOUT_BROKEN'; end if;
  insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,source,registered_by)
    values(g,branch,member_id,first_checkout.membership_id,today,'staff',owner_id) returning id into attendance_id;
  insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,source,registered_by)
    values(g,branch,second_member,second_checkout.membership_id,today,'staff',owner_id);

  input:=jsonb_build_object('name','Premio mensual','description','Prueba','locationId',branch,'startsOn',today,'endsOn',today,
    'redeemUntil',today+30,'ruleType','attendance_count','target',1,'rewardType','discount','rewardValue',30,'productId',null,'maxRewards',1);
  perform pg_temp.expect_loyalty_failure(format('select public.save_promotion_backend(%L,%L,null,%L::jsonb)',g,member_id,input),'LOYALTY_OWNER_REQUIRED');
  perform pg_temp.expect_loyalty_failure(format('select public.save_promotion_backend(%L,%L,null,%L::jsonb)',other_g,owner_id,input),'LOYALTY_OWNER_REQUIRED');
  perform pg_temp.expect_loyalty_failure(format('select public.save_promotion_backend(%L,%L,null,%L::jsonb)',g,owner_id,input||jsonb_build_object('locationId',other_branch)),'ATTENDANCE_LOCATION_MISMATCH');
  p:=public.save_promotion_backend(g,owner_id,null,input);
  result:=public.member_loyalty_backend(g,member_id,member_id);
  if jsonb_array_length(result->'promotions')<>0 then raise exception 'DRAFT_EXPOSED'; end if;
  p:=public.set_promotion_status_backend(g,owner_id,p.id,'active');
  perform pg_temp.expect_loyalty_failure(format('select public.save_promotion_backend(%L,%L,%L,%L::jsonb)',g,owner_id,p.id,input),'PROMOTION_TERMS_LOCKED');
  perform pg_temp.expect_loyalty_failure(format('select public.member_loyalty_backend(%L,%L,%L)',g,member_id,second_member),'LOYALTY_OWNER_REQUIRED');
  perform pg_temp.expect_loyalty_failure(format('select public.member_loyalty_backend(%L,%L,%L)',other_g,member_id,member_id),'LOYALTY_MEMBER_REQUIRED');
  result:=public.member_loyalty_backend(g,member_id,member_id);
  if (result->'promotions'->0->>'progress')::integer<>1 then raise exception 'PROGRESS_INVALID'; end if;
  r:=public.claim_reward_backend(g,member_id,member_id,p.id);
  if (public.claim_reward_backend(g,member_id,member_id,p.id)).id<>r.id then raise exception 'CLAIM_NOT_IDEMPOTENT'; end if;
  perform pg_temp.expect_loyalty_failure(format('select public.claim_reward_backend(%L,%L,%L,%L)',g,owner_id,second_member,p.id),'REWARD_QUOTA_REACHED');
  perform pg_temp.expect_loyalty_failure(format('select public.register_manual_membership_checkout(%L,%L,%L,%L,%L,''cash'',null,null,%L,false,%L)',g,branch,member_id,plan_id,member_id,first_checkout.membership_id,r.id),'FINANCIAL_ACTOR_ROLE_DENIED');
  select * into checkout from public.register_manual_membership_checkout(g,branch,member_id,plan_id,owner_id,'cash',null,null,first_checkout.membership_id,false,r.id);
  if checkout.charged_amount<>70 or checkout.receipt_number is null or checkout.coverage_starts_on<>first_checkout.coverage_ends_on+1 then raise exception 'DISCOUNT_CHECKOUT_INVALID'; end if;
  if not exists(select 1 from public.membership_periods where id=checkout.membership_period_id and original_amount=100 and discount_amount=30 and charged_amount=70 and reward_id=r.id) then raise exception 'DISCOUNT_BREAKDOWN_INVALID'; end if;
  if not exists(select 1 from public.member_payments where id=checkout.payment_id and amount=70 and status='confirmed') then raise exception 'PAYMENT_TOTAL_INVALID'; end if;
  perform pg_temp.expect_loyalty_failure(format('select public.register_manual_membership_checkout(%L,%L,%L,%L,%L,''cash'',null,null,%L,false,%L)',g,branch,member_id,plan_id,owner_id,first_checkout.membership_id,r.id),'REWARD_NOT_AVAILABLE');

  -- Perfect attendance snapshots the calendar; later timetable edits do not change terms.
  perfect:=public.save_promotion_backend(g,owner_id,null,input||jsonb_build_object('name','Asistencia perfecta','ruleType','perfect_attendance','target',99));
  perfect:=public.set_promotion_status_backend(g,owner_id,perfect.id,'active');
  if perfect.target<>1 or perfect.required_dates<>array[today] then raise exception 'PERFECT_DATES_INVALID'; end if;
  update public.location_opening_hours set day_mode='bonus' where location_id=branch;
  if private.loyalty_progress(perfect,member_id)<>1 then raise exception 'FROZEN_CALENDAR_CHANGED'; end if;
  update public.location_opening_hours set day_mode='required' where location_id=branch;
  revoked:=public.claim_reward_backend(g,member_id,member_id,perfect.id);
  perform public.revoke_reward_backend(g,owner_id,revoked.id,'Prueba de revocación');
  if (public.claim_reward_backend(g,member_id,member_id,perfect.id)).status<>'revoked' then raise exception 'REVOKED_REISSUED'; end if;

  free_p:=public.save_promotion_backend(g,owner_id,null,input||jsonb_build_object('name','Mes gratis','rewardType','free_period','rewardValue',1));
  free_p:=public.set_promotion_status_backend(g,owner_id,free_p.id,'active');
  free_r:=public.claim_reward_backend(g,member_id,member_id,free_p.id);
  select count(*) into count_before from public.member_payments where gym_id=g;
  select * into free_checkout from public.register_manual_membership_checkout(g,branch,member_id,plan_id,owner_id,'cash',null,null,first_checkout.membership_id,false,free_r.id);
  if free_checkout.payment_id is not null or free_checkout.receipt_number is not null or free_checkout.charged_amount<>0
    or free_checkout.coverage_starts_on<>checkout.coverage_ends_on+1 or free_checkout.coverage_ends_on<>(free_checkout.coverage_starts_on+interval '1 month')::date-1
    or (select count(*) from public.member_payments where gym_id=g)<>count_before then raise exception 'FREE_PERIOD_CREATED_REVENUE_OR_INVALID_COVERAGE'; end if;

  insert into public.products(id,gym_id,name,sku,sale_price) values(product_id,g,'Producto de regalo','GIFT',25);
  product_p:=public.save_promotion_backend(g,owner_id,null,input||jsonb_build_object('name','Producto gratis','rewardType','product','rewardValue',1,'productId',product_id,'maxRewards',2));
  product_p:=public.set_promotion_status_backend(g,owner_id,product_p.id,'active');
  product_r:=public.claim_reward_backend(g,member_id,member_id,product_p.id);
  perform pg_temp.expect_loyalty_failure(format('select public.redeem_product_reward_backend(%L,%L,%L)',g,owner_id,product_r.id),'INSUFFICIENT_STOCK');
  if (select status from public.member_rewards where id=product_r.id)<>'available' then raise exception 'FAILED_REDEMPTION_CONSUMED_REWARD'; end if;
  perform public.adjust_inventory_backend(g,branch,product_id,owner_id,'purchase',2,'Stock de prueba',false);
  -- Voiding an attendance after claim must block redemption.
  update public.attendances set status='voided',voided_at=now(),voided_by=owner_id,void_reason='Prueba' where id=attendance_id;
  perform pg_temp.expect_loyalty_failure(format('select public.redeem_product_reward_backend(%L,%L,%L)',g,owner_id,product_r.id),'REWARD_TARGET_NOT_MET');
  -- Another eligible member can claim and receive the product.
  product_r:=public.claim_reward_backend(g,owner_id,second_member,product_p.id);
  perform pg_temp.expect_loyalty_failure(format('select public.redeem_product_reward_backend(%L,%L,%L)',g,member_id,product_r.id),'LOYALTY_OWNER_REQUIRED');
  perform pg_temp.expect_loyalty_failure(format('select public.redeem_product_reward_backend(%L,%L,%L)',other_g,owner_id,product_r.id),'LOYALTY_OWNER_REQUIRED');
  redemption:=public.redeem_product_reward_backend(g,owner_id,product_r.id);
  if not exists(select 1 from public.inventory_movements where id=redemption.inventory_movement_id and quantity_delta=-1 and stock_after=1)
    or exists(select 1 from public.sales where gym_id=g) then raise exception 'PRODUCT_REDEMPTION_INVALID'; end if;
  perform pg_temp.expect_loyalty_failure(format('select public.redeem_product_reward_backend(%L,%L,%L)',g,owner_id,product_r.id),'REWARD_NOT_AVAILABLE');
  if not exists(select 1 from public.audit_logs where gym_id=g and action='reward.redeemed') then raise exception 'MISSING_AUDIT'; end if;

  -- Streak, pause/close, backdating and immutable history.
  p:=public.save_promotion_backend(g,owner_id,null,input||jsonb_build_object('ruleType','required_streak','target',2));
  perform pg_temp.expect_loyalty_failure(format('select public.set_promotion_status_backend(%L,%L,%L,''active'')',g,owner_id,p.id),'PROMOTION_UNREACHABLE_TARGET');
  p:=public.save_promotion_backend(g,owner_id,p.id,input||jsonb_build_object('ruleType','required_streak','target',1));
  p:=public.set_promotion_status_backend(g,owner_id,p.id,'active');
  if private.loyalty_progress(p,second_member)<>1 then raise exception 'STREAK_INCORRECT'; end if;
  p:=public.set_promotion_status_backend(g,owner_id,p.id,'paused');
  perform pg_temp.expect_loyalty_failure(format('select public.claim_reward_backend(%L,%L,%L,%L)',g,owner_id,second_member,p.id),'PROMOTION_UNAVAILABLE');
  p:=public.set_promotion_status_backend(g,owner_id,p.id,'active');
  revoked:=public.claim_reward_backend(g,owner_id,second_member,p.id);
  p:=public.set_promotion_status_backend(g,owner_id,p.id,'closed');
  if (select status from public.member_rewards where id=revoked.id)<>'available' then raise exception 'CLOSING_INVALIDATED_EARNED_REWARD'; end if;
  perform pg_temp.expect_loyalty_failure(format('update public.gym_promotions set target=2 where id=%L',p.id),'PROMOTION_TERMS_LOCKED');
  perform pg_temp.expect_loyalty_failure(format('update public.member_rewards set expires_on=expires_on+1 where id=%L',revoked.id),'REWARD_HISTORY_IMMUTABLE');
  p:=public.save_promotion_backend(g,owner_id,null,input||jsonb_build_object('startsOn',today-1));
  perform pg_temp.expect_loyalty_failure(format('select public.set_promotion_status_backend(%L,%L,%L,''active'')',g,owner_id,p.id),'PROMOTION_START_IN_PAST');
  p:=public.save_promotion_backend(g,owner_id,null,input||jsonb_build_object('startsOn',today+1,'endsOn',today+2));
  p:=public.set_promotion_status_backend(g,owner_id,p.id,'active');
  perform pg_temp.expect_loyalty_failure(format('select public.claim_reward_backend(%L,%L,%L,%L)',g,owner_id,second_member,p.id),'PROMOTION_UNAVAILABLE');

  -- Expiry fixture represents a previously earned reward; no mutation of existing snapshots.
  insert into public.member_rewards(gym_id,promotion_id,member_user_id,expires_on,terms)
    values(g,p.id,second_member,today-1,to_jsonb(p)) returning * into revoked;
  perform pg_temp.expect_loyalty_failure(format('select private.lock_loyalty_reward(%L,%L,%L,%L)',g,owner_id,revoked.id,second_member),'REWARD_EXPIRED');
  result:=public.member_loyalty_backend(g,owner_id,second_member);
  if not exists(select 1 from jsonb_array_elements(result->'rewards') x where x->>'id'=revoked.id::text and x->>'status'='expired') then raise exception 'EXPIRY_NOT_EXPOSED'; end if;
  update public.gym_users set status='suspended' where id=second_member;
  perform pg_temp.expect_loyalty_failure(format('select public.member_loyalty_backend(%L,%L,%L)',g,owner_id,second_member),'LOYALTY_MEMBER_REQUIRED');
  update public.gym_users set status='active' where id=second_member;

  perform public.reverse_member_payment_backend(g,checkout.payment_id,owner_id,'refunded','Reembolso de prueba',false);
  if (select status from public.member_rewards where id=r.id)<>'redeemed'
    or (select status from public.membership_periods where id=checkout.membership_period_id)<>'cancelled' then raise exception 'REFUND_REOPENED_REWARD_OR_RETAINED_COVERAGE'; end if;
end; $$;
select '0039 OK: permisos, aislamiento, reglas, cupos, duplicados, descuentos, cobertura gratis, inventario y auditoría' as result;
rollback;
