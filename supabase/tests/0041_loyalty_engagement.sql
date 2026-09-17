-- Ejecutar después de 0040 y 0041. No envía mensajes. Todo se revierte.
begin;
create function pg_temp.expect_engagement_failure(statement text,expected text) returns void language plpgsql as $$
begin
 begin execute statement; exception when others then if position(expected in sqlerrm)>0 then return; end if; raise; end;
 raise exception 'EXPECTED_FAILURE: %',expected;
end; $$;
do $$
declare g uuid:=gen_random_uuid(); other_g uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); o uuid:=gen_random_uuid();
 a uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); n uuid:=gen_random_uuid(); plan uuid:=gen_random_uuid();
 today date:=(now() at time zone 'America/Guayaquil')::date; p public.gym_promotions; q public.gym_promotions;
 input jsonb; result jsonb; checkout record; code text; referral uuid; reward public.member_rewards; total integer; delivery jsonb; f record;
begin
 for f in select ns.nspname,proc.proname,pg_get_function_identity_arguments(proc.oid) args,proc.oid from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
 where ns.nspname='public' and (proc.proname like '%loyalty%backend' or proc.proname='attach_loyalty_referral_backend') loop
  if has_function_privilege('authenticated',f.oid,'EXECUTE') or has_function_privilege('anon',f.oid,'EXECUTE') then raise exception 'UNSAFE_RPC %',f.proname; end if;
 end loop;
 insert into auth.users(id,email) values(a,a||'@test.invalid');
 insert into public.profiles(id,full_name) values(a,'Owner test');
 insert into public.gyms(id,name,slug) values(g,'Engagement','engagement-'||g),(other_g,'Other','other-'||other_g);
 insert into public.gym_locations(id,gym_id,name) values(l,g,'Principal');
 insert into public.gym_users(id,gym_id,profile_id,role,status,default_location_id) values(o,g,a,'owner','active',l);
 insert into public.gym_users(id,gym_id,role,status,account_mode,managed_full_name,default_location_id,joined_at)
 values(m,g,'member','active','managed','Referente',l,now()),(n,g,'member','active','managed','Invitado',l,now());
 insert into public.location_opening_hours(gym_id,location_id,weekday,opens_at,closes_at,day_mode)
 select g,l,d::smallint,'00:00'::time,'00:00'::time,'required'::public.calendar_day_mode from generate_series(1,7)d;
 insert into public.plans(id,gym_id,name,price,duration_unit,duration_value,attendance_mode) values(plan,g,'Mensual',100,'months',1,'daily');
 input:=jsonb_build_object('name','Referidos test','locationId',l,'startsOn',today,'endsOn',today+20,'redeemUntil',today+30,'ruleType','referral','target',1,'rewardType','discount','rewardValue',20,'maxRewards',2,'autoAward',true,'minimumPayment',50);
 p:=public.save_promotion_backend(g,o,null,input);
 p:=public.set_promotion_status_backend(g,o,p.id,'active');
 code:=public.ensure_loyalty_code_backend(g,m);
 if code<>public.ensure_loyalty_code_backend(g,m) then raise exception 'CODE_NOT_STABLE'; end if;
 perform pg_temp.expect_engagement_failure(format('select public.attach_loyalty_referral_backend(%L,%L,%L,%L,%L)',g,m,m,p.id,code),'REFERRAL_CODE_INVALID');
 perform pg_temp.expect_engagement_failure(format('select public.loyalty_engagement_backend(%L,%L,%L)',other_g,m,m),'LOYALTY_MEMBER_REQUIRED');
 perform pg_temp.expect_engagement_failure(format('select public.loyalty_engagement_backend(%L,%L,%L)',g,m,n),'LOYALTY_OWNER_REQUIRED');
 referral:=public.attach_loyalty_referral_backend(g,n,n,p.id,code);
 if private.loyalty_progress(p,m)<>0 then raise exception 'UNPAID_REFERRAL'; end if;
 select * into checkout from public.register_manual_membership_checkout(g,l,n,plan,o,'cash',null,null,null,false);
 if private.loyalty_progress(p,m)<>1 then raise exception 'PAID_REFERRAL_NOT_QUALIFIED'; end if;
 perform public.loyalty_preferences_backend(g,m,true,false);
 result:=public.evaluate_loyalty_backend(g,o);
 if (select count(*) from public.member_rewards where gym_id=g and promotion_id=p.id)<>2 then raise exception 'PAIR_NOT_AWARDED'; end if;
 select count(*) into total from public.loyalty_notifications where gym_id=g;
 perform public.evaluate_loyalty_backend(g,o);
 if (select count(*) from public.loyalty_notifications where gym_id=g)<>total then raise exception 'DUPLICATE_NOTIFICATIONS'; end if;
 result:=public.loyalty_engagement_backend(g,m,m);
 if result->>'referral_code'<>code or result->'mission' is null then raise exception 'ENGAGEMENT_INCOMPLETE'; end if;
 result:=public.loyalty_analytics_backend(g,o,today);
 if jsonb_array_length(result->'current'->'campaigns')<>1 then raise exception 'ANALYTICS_MISSING'; end if;
 delivery:=public.claim_loyalty_deliveries_backend()->0;
 if delivery is null then raise exception 'OUTBOX_MISSING'; end if;
 perform public.finish_loyalty_delivery_backend((delivery->>'id')::uuid,gen_random_uuid(),true,null);
 if exists(select 1 from private.loyalty_deliveries where id=(delivery->>'id')::uuid and status='sent') then raise exception 'LEASE_BYPASS'; end if;
 perform public.finish_loyalty_delivery_backend((delivery->>'id')::uuid,(delivery->>'lease_token')::uuid,false,'TEST_FAILURE');
 if not exists(select 1 from private.loyalty_deliveries where id=(delivery->>'id')::uuid and status='pending' and attempts=1) then raise exception 'RETRY_BROKEN'; end if;
 perform public.loyalty_preferences_backend(g,m,false,false);
 perform public.claim_loyalty_deliveries_backend();
 if exists(select 1 from private.loyalty_deliveries d join public.loyalty_notifications nn on nn.id=d.notification_id where nn.gym_id=g and d.status in ('pending','processing')) then raise exception 'CONSENT_IGNORED'; end if;
 insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,source,registered_by) values(g,l,n,checkout.membership_id,today,'staff',o);
 perform public.evaluate_loyalty_backend(g,o);
 if not exists(select 1 from public.member_badges where gym_id=g and member_user_id=n and badge_code='first_visit' and valid) then raise exception 'BADGE_MISSING'; end if;
 perform pg_temp.expect_engagement_failure(format('select public.attach_loyalty_referral_backend(%L,%L,%L,%L,%L)',g,n,n,p.id,code),'REFERRAL_BEFORE_FIRST_PAYMENT');
 q:=public.save_promotion_backend(g,o,null,input||jsonb_build_object('name','Recuperación','ruleType','recovery','maxRewards',5));
 q:=public.set_promotion_status_backend(g,o,q.id,'active');
 if private.loyalty_progress(q,n)<>0 then raise exception 'RECOVERY_WITHOUT_INVITATION'; end if;
 insert into public.loyalty_recovery_invitations(gym_id,promotion_id,member_user_id,invited_on,last_visit_on) values(g,q.id,n,today,today-14);
 perform public.evaluate_loyalty_backend(g,o);
 if not exists(select 1 from public.member_rewards where promotion_id=q.id and member_user_id=n) then raise exception 'RECOVERY_NOT_AWARDED'; end if;
 perform public.reverse_member_payment_backend(g,checkout.payment_id,o,'refunded','Prueba de reembolso de referido',false);
 if private.loyalty_progress(p,m)<>0 then raise exception 'REFUNDED_REFERRAL_QUALIFIED'; end if;
 select * into reward from public.member_rewards where promotion_id=p.id and member_user_id=m;
 perform pg_temp.expect_engagement_failure(format('select private.lock_loyalty_reward(%L,%L,%L,%L)',g,o,reward.id,m),'REWARD_TARGET_NOT_MET');
 perform public.evaluate_loyalty_backend(g,o);
 if (select status from public.member_rewards where id=reward.id)<>'revoked' then raise exception 'INVALID_REWARD_NOT_REVOKED'; end if;
 perform public.run_next_loyalty_batch_backend();
end; $$;
select '0041 OK: aislamiento, referidos, pago confirmado, premios dobles, idempotencia, avisos, consentimiento, leases, medallas y análisis' as result;
rollback;
