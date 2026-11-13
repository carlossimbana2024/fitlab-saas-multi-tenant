-- LOCAL ONLY. Full-schema fixtures. Never run in production.
begin;
do $$
declare g uuid:=gen_random_uuid(); owner_profile uuid:=gen_random_uuid(); member_profile uuid:=gen_random_uuid();
  owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); plan_id uuid:=gen_random_uuid();
  contract uuid:=gen_random_uuid(); period uuid:=gen_random_uuid(); location_id uuid:=gen_random_uuid(); r jsonb; failed boolean;
  today date:=(now() at time zone 'America/Guayaquil')::date;
  first_monday date;
begin
  if current_setting('fitlab.isolated_aggregate_test',true) is distinct from 'true' then raise exception 'LOCAL_RUNNER_REQUIRED';end if;
  first_monday:=today-(extract(isodow from today)::integer-1)-21;
  insert into auth.users(id,email) values(owner_profile,owner_profile||'@streak.invalid'),(member_profile,member_profile||'@streak.invalid');
  insert into public.profiles(id,full_name) values(owner_profile,'Streak owner'),(member_profile,'Streak member');
  insert into public.gyms(id,name,slug,timezone) values(g,'Streak fixture','streak-'||g,'America/Guayaquil');
  insert into public.gym_locations(id,gym_id,name) values(location_id,g,'Streak branch');
  insert into public.gym_users(id,gym_id,profile_id,role,status,account_mode) values
    (owner_id,g,owner_profile,'owner','active','portal'),(member_id,g,member_profile,'member','active','portal');
  insert into public.plans(id,gym_id,name,price,currency,duration_unit,duration_value,attendance_mode,weekly_target)
    values(plan_id,g,'Weekly',30,'USD','months',1,'weekly',3);
  insert into public.memberships(id,gym_id,member_user_id,plan_id,status,price_at_purchase,currency,
    attendance_mode_snapshot,weekly_target_snapshot,created_by)
    values(contract,g,member_id,plan_id,'pending',30,'USD','weekly',3,owner_id);
  insert into public.membership_periods(id,gym_id,membership_id,starts_on,ends_on,status,charged_amount,currency)
    values(period,g,contract,first_monday,today+30,'active',30,'USD');
  update public.memberships set status='active' where id=contract;
  -- Seed historical valid rows ONLY in this isolated DB. Restore triggers before
  -- invoking the actual cancellation and read RPCs. No production fixture use.
  perform set_config('session_replication_role','replica',true);
  insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,checked_in_at,source,status,counts_toward_streak)
    select g,location_id,member_id,contract,first_monday+n,(first_monday+n+time '12:00') at time zone 'America/Guayaquil','system','valid',true
      from generate_series(0,20) n where n%7<3;
  perform set_config('session_replication_role','origin',true);
  r:=private.member_streak_coverage(g,member_id);
  if r#>>'{0,classification}'<>'valid' then raise exception 'ACTIVE_PERIOD';end if;
  perform public.cancel_membership_backend(g,contract,owner_id,'Administrative termination fixture',false);
  r:=private.member_streak_coverage(g,member_id);
  if r#>>'{0,classification}'<>'valid' or r#>>'{0,cancelOn}'<>today::text then
    raise exception 'REAL_CANCELLATION_EVIDENCE %',r;end if;
  r:=public.get_member_personal_streaks_backend(g,member_id);
  if r->>'today'<>today::text or r->>'dailyCurrentStreak'<>'0' or r->>'weeklyBestStreak'<>'3'
    or r->>'weeklyCurrentStreak'<>'3' or r->>'weeklyStatus'='needs_review' then
    raise exception 'RPC_RESULT %',r;end if;
  if r?'weeks' or r?'ambiguousPeriodIds' then raise exception 'INTERNAL_DETAILS_EXPOSED';end if;
  failed:=false;
  begin perform public.get_member_personal_streaks_backend(gen_random_uuid(),member_id);
    exception when insufficient_privilege then failed:=true;end;
  if not failed then raise exception 'TENANT_ESCAPE';end if;
  if has_function_privilege('authenticated','public.get_member_personal_streaks_backend(uuid,uuid)','execute')
    or has_function_privilege('anon','public.get_member_personal_streaks_backend(uuid,uuid)','execute')
    or not has_function_privilege('service_role','public.get_member_personal_streaks_backend(uuid,uuid)','execute') then
    raise exception 'RPC_ACL';end if;
  if (select offers_enabled from private.class_waitlist_policy where singleton) then raise exception 'WAITLIST_ENABLED';end if;
end;$$;
select '0057 full schema OK: real cancellation RPC, coverage evidence, civil date, tenant, ACL, waitlist disabled' result;
rollback;
