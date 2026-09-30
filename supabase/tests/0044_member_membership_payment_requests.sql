-- Ejecutar después de 0044. Datos aislados; todas las operaciones se revierten.
begin;
set local lock_timeout = '5s';
create function pg_temp.expect_payment_request_failure(statement text,expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then if position(expected in sqlerrm)>0 then return; end if; raise; end;
  raise exception 'EXPECTED_FAILURE_NOT_RAISED: %',expected;
end; $$;
do $$
declare
  g uuid:=gen_random_uuid(); other_g uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); other_l uuid:=gen_random_uuid();
  op uuid:=gen_random_uuid(); mp uuid:=gen_random_uuid(); sp uuid:=gen_random_uuid(); op2 uuid:=gen_random_uuid();
  owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); staff_id uuid:=gen_random_uuid(); other_owner uuid:=gen_random_uuid();
  p uuid:=gen_random_uuid(); p2 uuid:=gen_random_uuid(); r public.membership_payment_requests; r2 public.membership_payment_requests;
  checkout record; renewed record; before_count integer; today date:=(now() at time zone 'America/Guayaquil')::date; fn text;
begin
  foreach fn in array array[
    'public.prepare_membership_payment_request_backend(uuid,uuid,uuid)',
    'public.submit_membership_payment_request_backend(uuid,uuid,uuid,jsonb,text,text)',
    'public.review_membership_payment_request_backend(uuid,uuid,uuid,text,text,boolean)',
    'public.save_membership_payment_settings_backend(uuid,uuid,uuid,jsonb)',
    'public.cancel_membership_payment_request_backend(uuid,uuid,uuid)',
    'public.register_manual_membership_checkout(uuid,uuid,uuid,uuid,uuid,public.member_payment_method,text,text,uuid,boolean,uuid,uuid)'
  ] loop
    if has_function_privilege('anon',fn,'EXECUTE') or has_function_privilege('authenticated',fn,'EXECUTE') or not has_function_privilege('service_role',fn,'EXECUTE') then raise exception 'UNSAFE_RPC: %',fn; end if;
  end loop;
  if has_table_privilege('authenticated','public.membership_payment_requests','SELECT') or has_table_privilege('anon','public.membership_payment_settings','SELECT') then raise exception 'DIRECT_TABLE_ACCESS'; end if;
  if (select public from storage.buckets where id='membership-payment-proofs') then raise exception 'PUBLIC_PROOF_BUCKET'; end if;
  insert into auth.users(id,email) values(op,op||'@requests.invalid'),(mp,mp||'@requests.invalid'),(sp,sp||'@requests.invalid'),(op2,op2||'@requests.invalid');
  insert into public.profiles(id,full_name) values(op,'Owner'),(mp,'Member'),(sp,'Staff'),(op2,'Other owner');
  insert into public.gyms(id,name,slug) values(g,'Payment gym','payment-'||g),(other_g,'Other gym','payment-'||other_g);
  insert into public.gym_locations(id,gym_id,name,whatsapp_phone) values(l,g,'Principal','+593991234567'),(other_l,other_g,'Otra','+593991234568');
  insert into public.gym_users(id,gym_id,profile_id,role,status,default_location_id) values(owner_id,g,op,'owner','active',l),(member_id,g,mp,'member','active',l),(staff_id,g,sp,'staff','active',l),(other_owner,other_g,op2,'owner','active',other_l);
  insert into public.plans(id,gym_id,name,price,duration_unit,duration_value,attendance_mode) values(p,g,'Mensual',30,'months',1,'daily'),(p2,g,'Otro',50,'months',1,'daily');
  perform pg_temp.expect_payment_request_failure(format('select public.prepare_membership_payment_request_backend(%L,%L,%L)',g,member_id,p),'PAYMENT_REQUEST_SETTINGS_REQUIRED');
  perform pg_temp.expect_payment_request_failure(format('select public.save_membership_payment_settings_backend(%L,%L,%L,%L::jsonb)',g,member_id,l,'{"enabled":true,"instructions":"Banco y cuenta","methods":["bank_transfer"]}'),'PAYMENT_REQUEST_OWNER_REQUIRED');
  perform pg_temp.expect_payment_request_failure(format('select public.save_membership_payment_settings_backend(%L,%L,%L,%L::jsonb)',g,owner_id,other_l,'{"enabled":true,"instructions":"Banco y cuenta","methods":["bank_transfer"]}'),'PAYMENT_REQUEST_LOCATION_INVALID');
  perform public.save_membership_payment_settings_backend(g,owner_id,l,'{"enabled":true,"instructions":"Banco y cuenta","methods":["bank_transfer","deposit"]}'::jsonb);
  select * into checkout from public.register_manual_membership_checkout(g,l,member_id,p,owner_id,'cash',null,null,null,false);
  before_count:=(select count(*) from public.member_payments where gym_id=g);
  r:=public.prepare_membership_payment_request_backend(g,member_id,p);
  perform pg_temp.expect_payment_request_failure(format('select public.submit_membership_payment_request_backend(%L,%L,%L,%L::jsonb,%L,%L)',g,member_id,r.id,jsonb_build_object('channel','fitlab','method','bank_transfer','amount',29,'paidOn',today)::text,repeat('a',64),r.proof_path),'PAYMENT_REQUEST_AMOUNT_OR_DATE_INVALID');
  perform pg_temp.expect_payment_request_failure(format('select public.submit_membership_payment_request_backend(%L,%L,%L,%L::jsonb,%L,%L)',g,member_id,r.id,jsonb_build_object('channel','fitlab','method','bank_transfer','amount',30,'paidOn',today+1)::text,repeat('a',64),r.proof_path),'PAYMENT_REQUEST_AMOUNT_OR_DATE_INVALID');
  r:=public.submit_membership_payment_request_backend(g,member_id,r.id,jsonb_build_object('channel','fitlab','method','bank_transfer','amount',30,'paidOn',today,'reference','REF-1'),repeat('a',64),r.proof_path);
  if (select count(*) from public.member_payments where gym_id=g)<>before_count then raise exception 'PENDING_CREATED_INCOME'; end if;
  perform pg_temp.expect_payment_request_failure(format('select public.prepare_membership_payment_request_backend(%L,%L,%L)',g,member_id,p),'PAYMENT_REQUEST_PENDING');
  perform pg_temp.expect_payment_request_failure(format('select public.review_membership_payment_request_backend(%L,%L,%L,%L,%L,false)',g,member_id,r.id,'approved','Verificado'),'FINANCIAL_ACTOR_ROLE_DENIED');
  perform pg_temp.expect_payment_request_failure(format('select public.review_membership_payment_request_backend(%L,%L,%L,%L,%L,false)',g,staff_id,r.id,'approved','Verificado'),'FINANCIAL_PERMISSION_DENIED');
  perform pg_temp.expect_payment_request_failure(format('select public.review_membership_payment_request_backend(%L,%L,%L,%L,%L,false)',other_g,other_owner,r.id,'approved','Verificado'),'PAYMENT_REQUEST_INVALID_STATE');
  update public.plans set price=45,duration_value=2 where id=p;
  r:=public.review_membership_payment_request_backend(g,owner_id,r.id,'approved','Pago verificado',false);
  select * into renewed from public.membership_periods where payment_id=r.payment_id;
  if renewed.starts_on<>checkout.coverage_ends_on+1 or renewed.ends_on<>(renewed.starts_on+interval '1 month')::date-1 then raise exception 'COVERAGE_OR_DURATION_CHANGED'; end if;
  if (select amount from public.member_payments where id=r.payment_id)<>30 then raise exception 'QUOTE_PRICE_CHANGED'; end if;
  if (select receipt_number from public.member_payments where id=r.payment_id) is null then raise exception 'RECEIPT_MISSING'; end if;
  perform pg_temp.expect_payment_request_failure(format('select public.review_membership_payment_request_backend(%L,%L,%L,%L,%L,false)',g,owner_id,r.id,'approved','Verificado'),'PAYMENT_REQUEST_INVALID_STATE');
  perform pg_temp.expect_payment_request_failure(format('select public.cancel_membership_payment_request_backend(%L,%L,%L)',g,member_id,r.id),'PAYMENT_REQUEST_INVALID_STATE');
  if (select count(*) from public.member_payments where gym_id=g)<>before_count+1 then raise exception 'DUPLICATE_APPROVAL_PAYMENT'; end if;
  perform pg_temp.expect_payment_request_failure(format('select public.prepare_membership_payment_request_backend(%L,%L,%L)',g,member_id,p2),'PAYMENT_REQUEST_CURRENT_PLAN_ONLY');
  r2:=public.prepare_membership_payment_request_backend(g,member_id,p);
  perform pg_temp.expect_payment_request_failure(format('select public.submit_membership_payment_request_backend(%L,%L,%L,%L::jsonb,%L,%L)',g,member_id,r2.id,jsonb_build_object('channel','fitlab','method','bank_transfer','amount',45,'paidOn',today)::text,repeat('a',64),r2.proof_path),'membership_payment_requests_unique_proof');
  r2:=public.submit_membership_payment_request_backend(g,member_id,r2.id,jsonb_build_object('channel','whatsapp','method','deposit','amount',45,'paidOn',today),null,r2.proof_path);
  r2:=public.review_membership_payment_request_backend(g,owner_id,r2.id,'revision_requested','Falta referencia',false);
  r2:=public.prepare_membership_payment_request_backend(g,member_id,p);
  r2:=public.submit_membership_payment_request_backend(g,member_id,r2.id,jsonb_build_object('channel','whatsapp','method','deposit','amount',45,'paidOn',today,'reference','DEP-2'),null,r2.proof_path);
  r2:=public.review_membership_payment_request_backend(g,owner_id,r2.id,'rejected','No consta el ingreso',false);
  if r2.payment_id is not null or (select count(*) from public.member_payments where gym_id=g)<>before_count+1 then raise exception 'REJECTION_CREATED_INCOME'; end if;
  if (select count(*) from public.loyalty_notifications where gym_id=g and member_user_id=member_id and kind='membership_payment')<>3 then raise exception 'NOTIFICATIONS_MISSING'; end if;
  r2:=public.prepare_membership_payment_request_backend(g,member_id,p);
  perform public.cancel_membership_payment_request_backend(g,member_id,r2.id);
  r2:=public.prepare_membership_payment_request_backend(g,member_id,p);
  update public.membership_payment_requests set expires_at=now()-interval '1 second' where id=r2.id;
  perform pg_temp.expect_payment_request_failure(format('select public.submit_membership_payment_request_backend(%L,%L,%L,%L::jsonb,null,%L)',g,member_id,r2.id,jsonb_build_object('channel','whatsapp','method','deposit','amount',45,'paidOn',today)::text,r2.proof_path),'PAYMENT_REQUEST_QUOTE_EXPIRED');
end; $$;
select '0044 OK: aislamiento, permisos, comprobantes, precio, cobertura, aprobación única, revisión, rechazo, WhatsApp y notificaciones' as result;
rollback;
