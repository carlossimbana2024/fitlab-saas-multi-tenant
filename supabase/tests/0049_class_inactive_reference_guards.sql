-- Run after migration 0049 in a development database. All fixtures roll back.
begin;
set local lock_timeout = '5s';
create function pg_temp.expect_unavailable(statement text) returns void
language plpgsql as $$
begin
  begin
    execute statement;
  exception when check_violation then
    if sqlerrm = 'CLASS_IS_NOT_AVAILABLE_FOR_BOOKING' then return; end if;
    raise;
  end;
  raise exception 'EXPECTED_UNAVAILABLE: %', statement;
end;
$$;

do $$
declare
  g uuid := gen_random_uuid(); l uuid := gen_random_uuid();
  owner_profile uuid := gen_random_uuid(); owner_id uuid := gen_random_uuid();
  member_id uuid; profile_id uuid; members uuid[] := '{}';
  plan_id uuid := gen_random_uuid(); activity_id uuid := gen_random_uuid();
  schedule_id uuid := gen_random_uuid(); i integer; variant integer;
  booking public.class_bookings; waitlist_before jsonb; booking_before jsonb;
  schedule_before jsonb; payments_before jsonb;
begin
  insert into auth.users(id,email) values(owner_profile,owner_profile||'@class-test.invalid');
  insert into public.profiles(id,full_name) values(owner_profile,'Class test owner');
  insert into public.gyms(id,name,slug) values(g,'Inactive class test','inactive-'||g);
  insert into public.gym_locations(id,gym_id,name) values(l,g,'Test branch');
  insert into public.gym_users(id,gym_id,profile_id,role,status,default_location_id)
    values(owner_id,g,owner_profile,'owner','active',l);
  insert into public.plans(id,gym_id,name,price,duration_unit,duration_value,attendance_mode)
    values(plan_id,g,'Test monthly',30,'months',1,'daily');
  for i in 1..3 loop
    profile_id := gen_random_uuid(); member_id := gen_random_uuid();
    insert into auth.users(id,email) values(profile_id,profile_id||'@class-test.invalid');
    insert into public.profiles(id,full_name) values(profile_id,'Class test member');
    insert into public.gym_users(id,gym_id,profile_id,role,status,account_mode,default_location_id)
      values(member_id,g,profile_id,'member','active','portal',l);
    perform public.register_manual_membership_checkout(g,l,member_id,plan_id,owner_id,'cash',null,null,null,false);
    members := array_append(members,member_id);
  end loop;
  insert into public.extra_classes(id,gym_id,name,billing_mode,price,capacity,duration_minutes)
    values(activity_id,g,'Test class','included',0,1,60);
  insert into public.class_schedules(id,gym_id,location_id,extra_class_id,starts_at,ends_at)
    values(schedule_id,g,l,activity_id,now()+interval '2 days',now()+interval '2 days 1 hour');

  -- A: active references permit an ordinary reservation and waitlist entry.
  booking := public.reserve_member_class_backend(g,schedule_id,members[1],members[1]);
  perform public.join_class_waitlist_backend(g,schedule_id,members[2],members[2]);
  booking_before := to_jsonb(booking);
  select to_jsonb(cw) into waitlist_before from public.class_waitlists cw
    where class_schedule_id = schedule_id and member_user_id = members[2];
  select to_jsonb(cs) into schedule_before from public.class_schedules cs where id = schedule_id;
  select jsonb_agg(to_jsonb(mp) order by mp.id) into payments_before
    from public.member_payments mp where gym_id = g;

  -- B/C: deactivate activity, branch, then both; call real backend RPCs.
  for variant in 1..3 loop
    update public.extra_classes set is_active = (variant = 2) where id = activity_id;
    update public.gym_locations set is_active = (variant = 1) where id = l;
    perform pg_temp.expect_unavailable(format(
      'select public.reserve_member_class_backend(%L::uuid,%L::uuid,%L::uuid,%L::uuid)',
      g,schedule_id,members[3],members[3]));
    perform pg_temp.expect_unavailable(format(
      'select public.join_class_waitlist_backend(%L::uuid,%L::uuid,%L::uuid,%L::uuid)',
      g,schedule_id,members[3],members[3]));
    -- Staff/owner reservation path cannot bypass the new protection either.
    perform pg_temp.expect_unavailable(format(
      'select public.reserve_included_class_backend(%L::uuid,%L::uuid,%L::uuid,%L::uuid,false)',
      g,schedule_id,members[3],owner_id));
    if (select to_jsonb(cb) from public.class_bookings cb where id = booking.id) is distinct from booking_before
       or (select to_jsonb(cw) from public.class_waitlists cw where class_schedule_id = schedule_id and member_user_id = members[2]) is distinct from waitlist_before
       or (select to_jsonb(cs) from public.class_schedules cs where id = schedule_id) is distinct from schedule_before
       or (select jsonb_agg(to_jsonb(mp) order by mp.id) from public.member_payments mp where gym_id = g) is distinct from payments_before then
      raise exception 'DEACTIVATION_CHANGED_EXISTING_RECORDS';
    end if;
  end loop;
  -- Existing participants can still leave; deactivation itself did not cancel them.
  perform public.leave_class_waitlist_backend(g,(waitlist_before->>'id')::uuid,members[2],'Test cancellation');
end;
$$;
select '0049 OK: active flow, inactive activity/branch/both, RPC protection, existing records preserved' as result;
rollback;
