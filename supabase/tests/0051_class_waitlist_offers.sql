-- Ejecutar después de 0051 (y antes o después de activar 0052).
-- Datos aislados y ROLLBACK. Solo invoca el worker global con el motor apagado.
begin;
set local lock_timeout='5s';
-- Enabled only in this transaction; rollback restores the rollout setting.
update private.class_waitlist_policy set offers_enabled=true where singleton;
create or replace function pg_temp.expect_waitlist_error(statement text,expected text) returns void
language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if position(expected in sqlerrm)>0 then return; end if;
    raise;
  end;
  raise exception 'EXPECTED_WAITLIST_ERROR: %',expected;
end; $$;

create or replace function pg_temp.waitlist_fixture(seats integer default 1,mode public.class_billing_mode default 'included')
returns jsonb language plpgsql as $$
declare g uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); p uuid:=gen_random_uuid();
  a uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); profile_id uuid; m uuid; members uuid[]:='{}'; i integer;
begin
  profile_id:=gen_random_uuid();
  insert into auth.users(id,email) values(profile_id,profile_id||'@queue-test.invalid');
  insert into public.profiles(id,full_name) values(profile_id,'Queue owner');
  insert into public.gyms(id,name,slug) values(g,'Queue fixture','queue-'||g);
  insert into public.gym_locations(id,gym_id,name) values(l,g,'Queue branch');
  insert into public.gym_users(id,gym_id,profile_id,role,status,default_location_id) values(o,g,profile_id,'owner','active',l);
  insert into public.plans(id,gym_id,name,price,duration_unit,duration_value,attendance_mode)
    values(p,g,'Monthly',30,'months',1,'daily');
  for i in 1..12 loop
    profile_id:=gen_random_uuid();m:=gen_random_uuid();
    insert into auth.users(id,email) values(profile_id,profile_id||'@queue-test.invalid');
    insert into public.profiles(id,full_name) values(profile_id,'Queue member');
    insert into public.gym_users(id,gym_id,profile_id,role,status,account_mode,default_location_id)
      values(m,g,profile_id,'member','active','portal',l);
    -- The last member intentionally has no membership coverage.
    if i<12 then perform public.register_manual_membership_checkout(g,l,m,p,o,'cash',null,null,null,false); end if;
    members:=array_append(members,m);
  end loop;
  insert into public.extra_classes(id,gym_id,name,billing_mode,price,currency,capacity,duration_minutes)
    values(a,g,'Queue class',mode,case when mode='included' then 0 else 5 end,'USD',seats,60);
  insert into public.class_schedules(id,gym_id,location_id,extra_class_id,starts_at,ends_at)
    values(s,g,l,a,now()+interval '2 days',now()+interval '2 days 1 hour');
  return jsonb_build_object('gym',g,'branch',l,'owner',o,'activity',a,'session',s,'members',members);
end; $$;

-- A: FIFO, idempotent join, real positions, leaving, reservations cannot jump
-- offers, secure acceptance, and repeat acceptance does not duplicate a booking.
do $$
declare f jsonb:=pg_temp.waitlist_fixture();g uuid; s uuid; o uuid; m uuid[]; b public.class_bookings;
  q2 record;q3 record;q4 record;again record; offer public.class_waitlist_offers; result jsonb; view jsonb; left_row public.class_waitlists;
  foreign_fixture jsonb; foreign_member uuid;
begin
  g:=(f->>'gym')::uuid;s:=(f->>'session')::uuid;o:=(f->>'owner')::uuid;
  select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
  b:=public.reserve_member_class_backend(g,s,m[1],m[1]);
  select * into q2 from public.join_class_waitlist_backend(g,s,m[2],m[2]);
  perform pg_sleep(0.003); -- Distinct timestamps even in the WASM test clock.
  select * into q3 from public.join_class_waitlist_backend(g,s,m[3],m[3]);
  perform pg_sleep(0.003);
  select * into q4 from public.join_class_waitlist_backend(g,s,m[4],m[4]);
  select * into again from public.join_class_waitlist_backend(g,s,m[2],m[2]);
  if (q2.waitlist_position,q3.waitlist_position,q4.waitlist_position) is distinct from (1::bigint,2::bigint,3::bigint)
    or again.waitlist_id<>q2.waitlist_id then raise exception 'FIFO_OR_DUPLICATE_JOIN_WRONG'; end if;
  perform pg_temp.expect_waitlist_error(format('insert into public.class_waitlists(gym_id,class_schedule_id,member_user_id) values(%L,%L,%L)',g,s,m[2]),'class_waitlists_one_active_episode_idx');
  perform pg_temp.expect_waitlist_error(format('select public.join_class_waitlist_backend(%L,%L,%L,%L)',g,s,m[1],m[1]),'CLASS_WAITLIST_MEMBER_INELIGIBLE');
  perform pg_temp.expect_waitlist_error(format('select public.join_class_waitlist_backend(%L,%L,%L,%L)',g,s,m[12],m[12]),'CLASS_ACTIVE_MEMBERSHIP_COVERAGE_REQUIRED');
  perform pg_temp.expect_waitlist_error(format('select public.join_class_waitlist_backend(%L,%L,%L,%L)',g,s,m[5],m[6]),'MEMBER_CAN_ONLY_JOIN_OWN_WAITLIST');
  left_row:=public.leave_class_waitlist_backend(g,q3.waitlist_id,m[3],'Test leave');
  if left_row.state<>'cancelled' or private.class_waitlist_position(q4.waitlist_id)<>2 then raise exception 'POSITION_AFTER_LEAVE_WRONG'; end if;
  perform public.cancel_class_booking_backend(g,b.id,m[1],'Release one seat',false);
  select * into offer from public.class_waitlist_offers where waitlist_id=q2.waitlist_id and status='offered';
  if not found or offer.expires_at-offer.offered_at<>interval '30 minutes'
    or exists(select 1 from public.class_bookings where gym_id=g and member_user_id=m[2]) then raise exception 'OFFER_NOT_FIRST_OR_AUTO_BOOKED'; end if;
  perform pg_temp.expect_waitlist_error(format('select public.reserve_member_class_backend(%L,%L,%L,%L)',g,s,m[5],m[5]),'CLASS_WAITLIST_PRIORITY_REQUIRED');
  perform pg_temp.expect_waitlist_error(format('select public.reserve_included_class_backend(%L,%L,%L,%L,false)',g,s,m[5],o),'CLASS_WAITLIST_PRIORITY_REQUIRED');
  perform pg_temp.expect_waitlist_error(format('select public.reserve_member_class_backend(%L,%L,%L,%L)',g,s,m[2],m[2]),'CLASS_WAITLIST_OFFER_ACCEPT_REQUIRED');
  perform pg_temp.expect_waitlist_error(format('select public.accept_class_waitlist_offer_backend(%L,%L,%L)',g,offer.id,m[4]),'CLASS_WAITLIST_OFFER_NOT_FOUND');
  view:=public.get_class_waitlist_state_backend(g,m[4],array[s]);
  if (view#>>'{sessions,0,myWaitlist,position}')::integer<>2
    or (view#>>'{sessions,0,available}')::integer<>0
    or jsonb_array_length(view#>'{sessions,0,waitlist}')<>1
    or view::text like '%'||m[2]::text||'%' then raise exception 'POSITION_AVAILABILITY_OR_MEMBER_PRIVACY_WRONG'; end if;
  if jsonb_array_length(public.get_class_waitlist_state_backend(g,m[4],array[gen_random_uuid()])->'sessions')<>0 then raise exception 'FOREIGN_SESSION_EXPOSED'; end if;
  view:=public.get_class_waitlist_state_backend(g,o,array[s]);
  if jsonb_array_length(view#>'{sessions,0,waitlist}')<>2 then raise exception 'OWNER_CANNOT_READ_QUEUE'; end if;
  foreign_fixture:=pg_temp.waitlist_fixture();foreign_member:=(foreign_fixture#>>'{members,0}')::uuid;
  perform pg_temp.expect_waitlist_error(format('select public.accept_class_waitlist_offer_backend(%L,%L,%L)',(foreign_fixture->>'gym')::uuid,offer.id,foreign_member),'CLASS_WAITLIST_OFFER_NOT_FOUND');
  if jsonb_array_length(public.get_class_waitlist_state_backend((foreign_fixture->>'gym')::uuid,foreign_member,array[s])->'sessions')<>0 then raise exception 'CROSS_TENANT_QUEUE_VISIBLE'; end if;
  result:=public.accept_class_waitlist_offer_backend(g,offer.id,m[2]);
  if not (result->>'accepted')::boolean or (select state from public.class_waitlists where id=q2.waitlist_id)<>'accepted' then raise exception 'OFFER_NOT_ACCEPTED'; end if;
  result:=public.accept_class_waitlist_offer_backend(g,offer.id,m[2]);
  if not (result->>'already_accepted')::boolean or (select count(*) from public.class_bookings where gym_id=g and member_user_id=m[2])<>1 then raise exception 'ACCEPTANCE_NOT_IDEMPOTENT'; end if;
  if (select count(*) from public.class_bookings where class_schedule_id=s and status in ('reserved','attended'))>1 then raise exception 'CAPACITY_OVERBOOKED'; end if;
end; $$;

-- B: deterministic ID tie break; refusal loses the turn, explicit re-entry is
-- a new episode behind others and does not overwrite the old offer/history.
do $$
declare f jsonb:=pg_temp.waitlist_fixture();g uuid;s uuid;m uuid[];b public.class_bookings;
  q1 uuid;q2 uuid;first_entry public.class_waitlists;offer public.class_waitlist_offers;new_entry record;
begin
  g:=(f->>'gym')::uuid;s:=(f->>'session')::uuid;select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
  b:=public.reserve_member_class_backend(g,s,m[1],m[1]);
  insert into public.class_waitlists(gym_id,class_schedule_id,member_user_id,joined_at) values(g,s,m[2],now()) returning id into q1;
  insert into public.class_waitlists(gym_id,class_schedule_id,member_user_id,joined_at) values(g,s,m[3],now()) returning id into q2;
  if private.class_waitlist_position(least(q1,q2))<>1 or private.class_waitlist_position(greatest(q1,q2))<>2 then raise exception 'TIE_BREAK_NOT_STABLE'; end if;
  select * into first_entry from public.class_waitlists where id=least(q1,q2);
  perform public.cancel_class_booking_backend(g,b.id,m[1],'Release',false);
  select * into offer from public.class_waitlist_offers where waitlist_id=first_entry.id and status='offered';
  perform public.leave_class_waitlist_backend(g,first_entry.id,first_entry.member_user_id,'Decline offered place');
  if (select status from public.class_waitlist_offers where id=offer.id)<>'rejected'
    or (select state from public.class_waitlists where id=first_entry.id)<>'rejected'
    or not exists(select 1 from public.class_waitlist_offers where class_schedule_id=s and status='offered' and waitlist_id<>first_entry.id) then
    raise exception 'DECLINE_DID_NOT_ADVANCE'; end if;
  select * into new_entry from public.join_class_waitlist_backend(g,s,first_entry.member_user_id,first_entry.member_user_id);
  if new_entry.waitlist_id=first_entry.id or new_entry.waitlist_position<>2 then raise exception 'REJOIN_OVERWROTE_OR_JUMPED'; end if;
end; $$;

-- C: real server clock expiry; accepting an expired offer must COMMIT its
-- expiry and advance the next member instead of rolling all that back.
do $$
declare f jsonb:=pg_temp.waitlist_fixture();g uuid;s uuid;m uuid[];b public.class_bookings;q record;offer uuid;result jsonb;
begin
  g:=(f->>'gym')::uuid;s:=(f->>'session')::uuid;select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
  b:=public.reserve_member_class_backend(g,s,m[1],m[1]);
  select * into q from public.join_class_waitlist_backend(g,s,m[2],m[2]);
  perform pg_sleep(0.003);
  perform public.join_class_waitlist_backend(g,s,m[3],m[3]);
  update private.class_waitlist_policy set offer_window=interval '20 milliseconds';
  perform public.cancel_class_booking_backend(g,b.id,m[1],'Release',false);
  select id into offer from public.class_waitlist_offers where waitlist_id=q.waitlist_id and status='offered';
  update private.class_waitlist_policy set offer_window=interval '30 minutes';
  perform pg_sleep(0.04);
  result:=public.accept_class_waitlist_offer_backend(g,offer,m[2]);
  if result->>'code'<>'CLASS_WAITLIST_OFFER_EXPIRED' or (result->>'accepted')::boolean
    or (select status from public.class_waitlist_offers where id=offer)<>'expired'
    or not exists(select 1 from public.class_waitlist_offers where class_schedule_id=s and member_user_id=m[3] and status='offered') then
    raise exception 'EXPIRY_DID_NOT_ADVANCE'; end if;
end; $$;

-- D: three released places create exactly three FIFO offers; repeating the
-- processor cannot duplicate them. Capacity reduction revokes newest first.
do $$
declare f jsonb:=pg_temp.waitlist_fixture(3);g uuid;s uuid;o uuid;m uuid[];bookings uuid[]:='{}';b public.class_bookings;i integer;counts record;
begin
  g:=(f->>'gym')::uuid;s:=(f->>'session')::uuid;o:=(f->>'owner')::uuid;select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
  for i in 1..3 loop b:=public.reserve_member_class_backend(g,s,m[i],m[i]);bookings:=array_append(bookings,b.id);end loop;
  for i in 4..8 loop perform pg_sleep(0.003);perform public.join_class_waitlist_backend(g,s,m[i],m[i]);end loop;
  for i in 1..3 loop perform public.cancel_class_booking_backend(g,bookings[i],o,'Release several',false);end loop;
  perform private.process_class_waitlist_queue(g,s);perform private.process_class_waitlist_queue(g,s);
  if (select count(*) from public.class_waitlist_offers where class_schedule_id=s and status='offered')<>3
    or exists(select 1 from public.class_waitlist_offers where class_schedule_id=s and status='offered' and member_user_id<>all(m[4:6])) then raise exception 'MULTIPLE_OFFERS_NOT_FIFO_OR_DUPLICATED'; end if;
  update public.class_schedules set capacity_override=1 where id=s;
  if (select count(*) from public.class_waitlist_offers where class_schedule_id=s and status='offered')<>1
    or not exists(select 1 from public.class_waitlist_offers where class_schedule_id=s and status='offered' and member_user_id=m[4]) then raise exception 'CAPACITY_REDUCTION_WRONG_PRIORITY'; end if;
  update public.class_schedules set capacity_override=3 where id=s;
  select * into counts from private.class_waitlist_capacity(g,s);
  if counts.offered_count<>3 or counts.occupied<>0 then raise exception 'CAPACITY_INCREASE_DID_NOT_ADVANCE'; end if;
end; $$;

-- E: paid activities are eligible for the queue. No price is frozen when
-- joining/offered; accepting captures the then-current quote through 0050.
do $$
declare f jsonb:=pg_temp.waitlist_fixture(1,'additional_fee');g uuid;s uuid;a uuid;o uuid;m uuid[];
  b public.class_bookings;q record;offer uuid;accepted jsonb;paid record;
begin
  g:=(f->>'gym')::uuid;s:=(f->>'session')::uuid;a:=(f->>'activity')::uuid;o:=(f->>'owner')::uuid;
  select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
  b:=public.reserve_member_class_backend(g,s,m[1],m[1]);
  select * into q from public.join_class_waitlist_backend(g,s,m[2],m[2]);
  update public.extra_classes set price=8 where id=a;
  perform public.cancel_class_booking_backend(g,b.id,m[1],'Release paid activity seat',false);
  select id into offer from public.class_waitlist_offers where waitlist_id=q.waitlist_id and status='offered';
  if exists(select 1 from public.class_bookings where class_schedule_id=s and member_user_id=m[2]) then raise exception 'WAITLIST_CREATED_CONTRACT'; end if;
  accepted:=public.accept_class_waitlist_offer_backend(g,offer,m[2]);
  if not (accepted->>'accepted')::boolean or not exists(select 1 from public.class_booking_terms
    where booking_id=(accepted->>'booking_id')::uuid and agreed_amount=8 and currency='USD' and billing_mode='additional_fee' and source='reservation') then
    raise exception 'ACCEPTANCE_DID_NOT_FREEZE_CURRENT_TERMS'; end if;
  update public.extra_classes set price=10 where id=a;
  select * into paid from public.reserve_paid_class_backend(g,s,m[2],o,'cash',null,null,false);
  if (select amount from public.member_payments where id=paid.payment_id)<>8 then raise exception 'LATER_PAYMENT_IGNORED_SNAPSHOT'; end if;
end; $$;

-- F: inactive references, cancelled/started sessions and lost member eligibility
-- cannot create reservations. Offer deadlines are strictly before the start.
do $$
declare f jsonb;g uuid;s uuid;m uuid[];o uuid;b public.class_bookings;q record;offer public.class_waitlist_offers;result jsonb;i integer;
begin
  for i in 1..5 loop
    f:=pg_temp.waitlist_fixture();g:=(f->>'gym')::uuid;s:=(f->>'session')::uuid;o:=(f->>'owner')::uuid;
    select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
    b:=public.reserve_member_class_backend(g,s,m[1],m[1]);
    select * into q from public.join_class_waitlist_backend(g,s,m[2],m[2]);
    perform pg_sleep(0.003);
    perform public.join_class_waitlist_backend(g,s,m[3],m[3]);
    perform public.cancel_class_booking_backend(g,b.id,m[1],'Release',false);
    select * into offer from public.class_waitlist_offers where waitlist_id=q.waitlist_id and status='offered';
    if not found then raise exception 'TEST_OFFER_MISSING_IN_VARIANT_%',i; end if;
    if i=1 then update public.extra_classes set is_active=false where id=(f->>'activity')::uuid;
    elsif i=2 then update public.gym_locations set is_active=false where id=(f->>'branch')::uuid;
    elsif i=3 then perform public.cancel_class_schedule_backend(g,s,o,'Cancel queue session',false);
    elsif i=4 then update public.class_schedules set starts_at=clock_timestamp()-interval '1 minute' where id=s;
    else update public.gym_users set status='suspended' where id=m[2]; end if;
    if i<5 then
      result:=public.accept_class_waitlist_offer_backend(g,offer.id,m[2]);
      if (result->>'accepted')::boolean or exists(select 1 from public.class_waitlist_offers where class_schedule_id=s and status='offered')
        or exists(select 1 from public.class_waitlists where class_schedule_id=s and status in ('waiting','offered')) then raise exception 'UNAVAILABLE_SESSION_STILL_OFFERS'; end if;
    else
      perform private.process_class_waitlist_queue(g,s);
      if not exists(select 1 from public.class_waitlist_offers where class_schedule_id=s and member_user_id=m[3] and status='offered') then raise exception 'INELIGIBLE_HEAD_BLOCKS_QUEUE'; end if;
    end if;
  end loop;
  f:=pg_temp.waitlist_fixture();g:=(f->>'gym')::uuid;s:=(f->>'session')::uuid;o:=(f->>'owner')::uuid;
  select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
  b:=public.reserve_member_class_backend(g,s,m[1],m[1]);perform public.join_class_waitlist_backend(g,s,m[2],m[2]);
  update public.class_schedules set starts_at=clock_timestamp()+interval '5 minutes' where id=s;
  perform public.cancel_class_booking_backend(g,b.id,o,'Owner cancellation near start',false);
  select * into offer from public.class_waitlist_offers where class_schedule_id=s and status='offered';
  if offer.expires_at>=(select starts_at from public.class_schedules where id=s) then raise exception 'OFFER_EXPIRES_TOO_LATE'; end if;
end; $$;

do $$ begin
  if has_table_privilege('authenticated','public.class_waitlist_offers','SELECT')
    or has_table_privilege('service_role','public.class_waitlist_offers','UPDATE')
    or has_function_privilege('authenticated','public.accept_class_waitlist_offer_backend(uuid,uuid,uuid)','EXECUTE')
    or has_function_privilege('anon','public.process_class_waitlists_backend(integer)','EXECUTE') then raise exception 'WAITLIST_PRIVILEGES_INVALID'; end if;
end; $$;
-- Disabled OR missing policy is fail-closed, even with expired live offers.
-- Snapshot only fixture rows, avoiding scans of real gyms:
-- the global worker must return before selecting/locking any session.
do $$
declare before_state jsonb;after_state jsonb;result jsonb;variant integer;
  f jsonb:=pg_temp.waitlist_fixture();g uuid; s uuid;m uuid[];b public.class_bookings;
begin
  g:=(f->>'gym')::uuid;s:=(f->>'session')::uuid;
  select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
  b:=public.reserve_member_class_backend(g,s,m[1],m[1]);
  perform public.join_class_waitlist_backend(g,s,m[2],m[2]);
  perform public.join_class_waitlist_backend(g,s,m[3],m[3]);
  update private.class_waitlist_policy set offer_window=interval '20 milliseconds';
  perform public.cancel_class_booking_backend(g,b.id,m[1],'No-op fixture',false);
  perform pg_sleep(0.04);
  update private.class_waitlist_policy set offer_window=interval '30 minutes';
  update private.class_waitlist_policy set offers_enabled=false where singleton;
  for variant in 1..2 loop
    if variant=2 then delete from private.class_waitlist_policy where singleton; end if;
    select jsonb_build_object(
      'queue',(select jsonb_agg(to_jsonb(w) order by id) from public.class_waitlists w where gym_id=g),
      'offers',(select jsonb_agg(to_jsonb(o) order by id) from public.class_waitlist_offers o where gym_id=g),
      'bookings',(select jsonb_agg(to_jsonb(bk) order by id) from public.class_bookings bk where gym_id=g),
      'runs',(select jsonb_agg(to_jsonb(r) order by class_schedule_id) from private.class_waitlist_runs r where class_schedule_id=s)
    ) into before_state;
    result:=public.process_class_waitlists_backend(100);
    select jsonb_build_object(
      'queue',(select jsonb_agg(to_jsonb(w) order by id) from public.class_waitlists w where gym_id=g),
      'offers',(select jsonb_agg(to_jsonb(o) order by id) from public.class_waitlist_offers o where gym_id=g),
      'bookings',(select jsonb_agg(to_jsonb(bk) order by id) from public.class_bookings bk where gym_id=g),
      'runs',(select jsonb_agg(to_jsonb(r) order by class_schedule_id) from private.class_waitlist_runs r where class_schedule_id=s)
    ) into after_state;
    if before_state is distinct from after_state or result->>'processed'<>'0' or result->>'offers_enabled'<>'false' then
      raise exception 'WAITLIST_DISABLED_WORKER_NOT_NOOP'; end if;
  end loop;
  insert into private.class_waitlist_policy(singleton,offers_enabled) values(true,true);
end; $$;

-- Exhaustive ACL/search_path check for every function introduced/replaced here.
do $$
declare f record;role_name text;expected boolean;total integer:=0;
begin
  for f in select p.*,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname in ('join_class_waitlist_backend','leave_class_waitlist_backend',
      'accept_class_waitlist_offer_backend','get_class_waitlist_state_backend','process_class_waitlists_backend'))
    or (n.nspname='private' and p.proname in ('guard_class_waitlist_episode','validate_class_waitlist_offer',
      'check_waitlist_acceptance_complete','audit_class_waitlist_transition','require_waitlist_member',
      'waitlist_member_eligible','close_class_waitlist_entry','class_waitlist_capacity','process_class_waitlist_queue',
      'class_waitlist_position','enforce_class_waitlist_priority','close_waitlist_after_reservation',
      'advance_waitlist_on_release','refresh_waitlist_on_session_change')) loop
    total:=total+1;
    if not f.prosecdef or not ('search_path=pg_catalog, public'=any(f.proconfig)) then
      raise exception 'WAITLIST_DEFINER_CONFIG_INVALID: %',f.proname; end if;
    if exists(select 1 from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) where grantee=0 and privilege_type='EXECUTE') then
      raise exception 'WAITLIST_PUBLIC_EXECUTE: %',f.proname; end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      expected:=role_name='service_role' and f.nspname='public';
      if has_function_privilege(role_name,f.oid,'EXECUTE') is distinct from expected then
        raise exception 'WAITLIST_FUNCTION_ACL_INVALID: % %',f.proname,role_name; end if;
    end loop;
  end loop;
  if total<>19 then raise exception 'WAITLIST_FUNCTION_INVENTORY_CHANGED: %',total; end if;
end; $$;
set constraints all immediate;
select '0051 OK: FIFO, posiciones, ofertas, aceptación, rechazo, expiración, prioridad, cupos, aislamiento y condiciones económicas' as result;
rollback;
