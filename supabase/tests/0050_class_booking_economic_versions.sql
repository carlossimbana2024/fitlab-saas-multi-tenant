-- Ejecutar DESPUÉS de 0050. Fixtures aislados; todo se revierte.
begin;
set local lock_timeout = '5s';
create or replace function pg_temp.expect_terms_error(statement text, expected text) returns void
language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if position(expected in sqlerrm)>0 then return; end if;
    raise;
  end;
  raise exception 'EXPECTED_ERROR_NOT_RAISED: %', expected;
end; $$;
create temporary table if not exists terms_fixture(data jsonb);
truncate terms_fixture;
do $$
declare
  g uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); o uuid:=gen_random_uuid();
  p uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); s uuid:=gen_random_uuid();
  profile_id uuid; m uuid; members uuid[]:='{}'; i integer;
begin
  profile_id:=gen_random_uuid();
  insert into auth.users(id,email) values(profile_id,profile_id||'@terms.invalid');
  insert into public.profiles(id,full_name) values(profile_id,'Terms owner');
  insert into public.gyms(id,name,slug) values(g,'Terms fixture','terms-'||g);
  insert into public.gym_locations(id,gym_id,name) values(l,g,'Terms branch');
  insert into public.gym_users(id,gym_id,profile_id,role,status,default_location_id)
    values(o,g,profile_id,'owner','active',l);
  insert into public.plans(id,gym_id,name,price,duration_unit,duration_value,attendance_mode)
    values(p,g,'Monthly',30,'months',1,'daily');
  for i in 1..8 loop
    profile_id:=gen_random_uuid(); m:=gen_random_uuid();
    insert into auth.users(id,email) values(profile_id,profile_id||'@terms.invalid');
    insert into public.profiles(id,full_name) values(profile_id,'Terms member');
    insert into public.gym_users(id,gym_id,profile_id,role,status,account_mode,default_location_id)
      values(m,g,profile_id,'member','active','portal',l);
    perform public.register_manual_membership_checkout(g,l,m,p,o,'cash',null,null,null,false);
    members:=array_append(members,m);
  end loop;
  insert into public.extra_classes(id,gym_id,name,billing_mode,price,capacity,duration_minutes)
    values(a,g,'Terms activity','additional_fee',5,10,60);
  insert into public.class_schedules(id,gym_id,location_id,extra_class_id,starts_at,ends_at)
    values(s,g,l,a,now()+interval '2 days',now()+interval '2 days 1 hour');
  insert into terms_fixture values(jsonb_build_object('gym',g,'location',l,'owner',o,'activity',a,'session',s,'members',members));
end; $$;

-- NEW TERMS TESTS (the isolated runner also uses the fixture above before 0050).
do $$
declare
  f jsonb; g uuid; l uuid; o uuid; a uuid; s uuid; m uuid[];
  b1 public.class_bookings; b2 public.class_bookings; b3 public.class_bookings;
  b4 public.class_bookings; b5 public.class_bookings; t public.class_booking_terms;
  paid record; pending_id uuid;
begin
  select data into f from terms_fixture;
  g:=(f->>'gym')::uuid; l:=(f->>'location')::uuid; o:=(f->>'owner')::uuid;
  a:=(f->>'activity')::uuid; s:=(f->>'session')::uuid;
  select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
  if has_table_privilege('authenticated','public.class_booking_terms','SELECT')
    or has_table_privilege('service_role','public.class_booking_terms','INSERT')
    or has_function_privilege('authenticated','public.reserve_paid_class_backend(uuid,uuid,uuid,uuid,public.member_payment_method,text,text,boolean)','EXECUTE') then
    raise exception 'TERMS_PRIVILEGES_INVALID';
  end if;
  b1:=public.reserve_member_class_backend(g,s,m[1],m[1]);
  update public.extra_classes set price=8 where id=a;
  b2:=public.reserve_member_class_backend(g,s,m[2],m[2]);
  update public.extra_classes set price=10 where id=a;
  b3:=public.reserve_member_class_backend(g,s,m[3],m[3]);
  if (select agreed_amount from public.class_booking_terms where booking_id=b1.id)<>5
     or (select agreed_amount from public.class_booking_terms where booking_id=b2.id)<>8
     or (select agreed_amount from public.class_booking_terms where booking_id=b3.id)<>10 then
    raise exception 'CATALOG_CHANGED_FROZEN_PRICE';
  end if;
  select * into paid from public.reserve_paid_class_backend(g,s,m[1],o,'cash',null,null,false);
  if (select amount from public.member_payments where id=paid.payment_id)<>5
    or not exists(select 1 from public.class_booking_terms where booking_id=b1.id and payment_evidence_id=paid.payment_id) then
    raise exception 'PAYMENT_NOT_FROZEN_OR_NOT_LINKED';
  end if;
  perform pg_temp.expect_terms_error(format('update public.class_booking_terms set agreed_amount=99 where booking_id=%L',b1.id),'CLASS_TERMS_ARE_IMMUTABLE');
  perform public.cancel_class_booking_backend(g,b2.id,m[2],'New episode',false);
  b2:=public.reserve_member_class_backend(g,s,m[2],m[2]);
  if (select count(*) from public.class_booking_terms where booking_id=b2.id)<>2
    or not exists(select 1 from public.class_booking_terms where booking_id=b2.id and version=1 and agreed_amount=8 and cancelled_at is not null)
    or not exists(select 1 from public.class_booking_terms where booking_id=b2.id and version=2 and agreed_amount=10 and cancelled_at is null and supersedes_id is not null) then
    raise exception 'REBOOKING_LOST_HISTORY';
  end if;
  update public.extra_classes set billing_mode='included',price=0 where id=a;
  b4:=public.reserve_member_class_backend(g,s,m[4],m[4]);
  -- Existing additional reservation stays chargeable even when catalog is included.
  select * into paid from public.reserve_paid_class_backend(g,s,m[3],o,'cash',null,null,false);
  if (select amount from public.member_payments where id=paid.payment_id)<>10 then raise exception 'ADDITIONAL_TO_INCLUDED_CHANGED_CONTRACT'; end if;
  update public.extra_classes set billing_mode='additional_fee',price=12 where id=a;
  b5:=public.reserve_member_class_backend(g,s,m[5],m[5]);
  perform pg_temp.expect_terms_error(format('select public.reserve_paid_class_backend(%L,%L,%L,%L,''cash'',null,null,false)',g,s,m[4],o),'CLASS_DOES_NOT_REQUIRE_ADDITIONAL_PAYMENT');
  if not exists(select 1 from public.class_booking_terms where booking_id=b4.id and billing_mode='included' and agreed_amount=0 and currency='USD')
    or not exists(select 1 from public.class_booking_terms where booking_id=b5.id and agreed_amount=12 and currency='USD') then
    raise exception 'MODE_OR_CURRENCY_NOT_FROZEN';
  end if;
  perform pg_temp.expect_terms_error(format('insert into public.member_payments(gym_id,location_id,member_user_id,class_booking_id,amount,currency,payment_method,status,registered_by) values(%L,%L,%L,%L,12,''EUR'',''cash'',''confirmed'',%L)',g,l,m[2],b2.id,o),'CLASS_PAYMENT_TERMS_MISMATCH');
  insert into public.member_payments(gym_id,location_id,member_user_id,class_booking_id,amount,currency,payment_method,status,registered_by)
    values(g,l,m[2],b2.id,10,'USD','cash','pending',o) returning id into pending_id;
  perform pg_temp.expect_terms_error(format('update public.member_payments set amount=99,status=''confirmed'' where id=%L',pending_id),'CLASS_PAYMENT_TERMS_MISMATCH');
  update public.member_payments set status='confirmed' where id=pending_id;
  select * into paid from public.reserve_paid_class_backend(g,s,m[6],o,'cash',null,null,false);
  if not exists(select 1 from public.class_booking_terms where booking_id=paid.booking_id
    and source='reservation' and agreed_amount=12 and payment_evidence_id=paid.payment_id) then
    raise exception 'DIRECT_PAID_RESERVATION_NOT_CAPTURED';
  end if;
  update public.extra_classes set billing_mode='included',price=0 where id=a;
  b5:=public.reserve_included_class_backend(g,s,m[7],o,false);
  if not exists(select 1 from public.class_booking_terms where booking_id=b5.id and billing_mode='included'
    and evidence_state='verified' and source='reservation') then raise exception 'RECEPTION_INCLUDED_NOT_CAPTURED'; end if;
  -- Existing inactive-session protection remains effective.
  update public.extra_classes set is_active=false where id=a;
  perform pg_temp.expect_terms_error(format('select public.reserve_member_class_backend(%L,%L,%L,%L)',g,s,m[8],m[8]),'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING');
  perform pg_temp.expect_terms_error(format('select public.reserve_member_class_backend(%L,%L,%L,%L)',gen_random_uuid(),s,m[8],m[8]),'MEMBER_CAN_ONLY_BOOK_SELF');
end; $$;
select '0050 OK: snapshot, precio/moneda/modalidad, versiones, cobro congelado, integridad, permisos y aislamiento' as result;
rollback;
