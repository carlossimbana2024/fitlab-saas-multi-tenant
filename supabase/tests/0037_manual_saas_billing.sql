-- Ejecutar después de 0037_manual_saas_billing.sql en SQL Editor. Todo se revierte.
begin;
set local lock_timeout='5s';
create function pg_temp.expect_failure(statement text,expected text) returns void language plpgsql as $$
begin begin execute statement; exception when others then if position(expected in sqlerrm)>0 then return; end if; raise; end;
raise exception 'EXPECTED_FAILURE_NOT_RAISED: %',expected; end; $$;
do $$
declare gym uuid:=gen_random_uuid(); owner_profile uuid:=gen_random_uuid(); admin_profile uuid:=gen_random_uuid(); plan uuid:=gen_random_uuid(); sub uuid:=gen_random_uuid(); req public.saas_payment_requests; paid_until timestamptz;
begin
  if has_table_privilege('authenticated','public.saas_payment_requests','SELECT')
    or has_function_privilege('authenticated','public.prepare_saas_payment_request(uuid,uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.prepare_saas_payment_request(uuid,uuid)','EXECUTE') then raise exception 'MANUAL_BILLING_PRIVILEGES_INVALID'; end if;
  if exists(select 1 from storage.buckets where id in ('saas-payment-proofs','saas-billing-assets') and public) then raise exception 'BILLING_BUCKET_PUBLIC'; end if;
  insert into auth.users(id,email) values(owner_profile,owner_profile||'@billing.invalid'),(admin_profile,admin_profile||'@billing.invalid');
  insert into public.profiles(id,full_name) values(owner_profile,'Dueño prueba'),(admin_profile,'Administrador prueba');
  insert into public.gyms(id,name,slug) values(gym,'Gimnasio cobro','billing-'||gym);
  insert into public.gym_users(gym_id,profile_id,role,status) values(gym,owner_profile,'owner','active');
  insert into private.platform_admins(profile_id,status) values(admin_profile,'active');
  insert into public.saas_plans(id,name,price,currency,billing_interval,trial_days) values(plan,'Plan prueba manual',30,'USD','month',30);
  insert into public.gym_subscriptions(id,gym_id,saas_plan_id,provider,plan_name_snapshot,price_snapshot,currency_snapshot,billing_interval_snapshot,features_snapshot,status,trial_ends_at)
    values(sub,gym,plan,'stripe','temporal',1,'USD','month','{}','trialing',now()+interval '2 days');
  req:=public.prepare_saas_payment_request(gym,owner_profile);
  perform public.submit_saas_payment_request(req.id,gym,owner_profile,repeat('a',64),'TRX-PRUEBA-001','Pagador prueba',current_date);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_profile,'aal','aal1','role','authenticated')::text,true);
  perform pg_temp.expect_failure(format('select public.review_saas_payment_request(%L,%L,%L)',req.id,'approved','Verificado banco'),'PLATFORM_ADMIN_MFA_REQUIRED');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_profile,'aal','aal2','role','authenticated')::text,true);
  perform public.review_saas_payment_request(req.id,'approved','Verificado en Banco Pichincha');
  perform public.review_saas_payment_request(req.id,'approved','Verificado en Banco Pichincha');
  select current_period_ends_at into paid_until from public.gym_subscriptions where id=sub;
  if paid_until < now()+interval '1 month' or (select count(*) from public.saas_payment_transactions where provider_payment_id=req.id::text)<>1 then raise exception 'MANUAL_PAYMENT_NOT_APPLIED_ONCE'; end if;
  raise notice '0037 OK: acceso, MFA, privacidad, aprobación e idempotencia comprobados.';
end $$;
rollback;
