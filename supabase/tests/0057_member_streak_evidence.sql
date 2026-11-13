-- LOCAL ONLY. Mutating evidence fixtures. Never run in production.
begin;
do $$
declare g uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); contract uuid:=gen_random_uuid();
  period uuid:=gen_random_uuid(); pay uuid:=gen_random_uuid(); r jsonb; failed boolean;
  stopped timestamptz:='2026-10-28 12:00-05';
begin
  insert into public.gyms(id,timezone) values(g,'America/Guayaquil');
  insert into public.gym_users(id,gym_id,role,status,account_mode) values(m,g,'member','active','portal');
  insert into public.memberships(id,gym_id,member_user_id,status,attendance_mode_snapshot,weekly_target_snapshot,cancelled_at)
    values(contract,g,m,'cancelled','weekly',3,stopped);
  insert into public.member_payments(id,gym_id,status) values(pay,g,'confirmed');
  insert into public.membership_periods(id,gym_id,membership_id,starts_on,ends_on,status,payment_id)
    values(period,g,contract,'2026-10-05','2026-12-31','cancelled',pay);
  r:=private.member_streak_coverage(g,m);
  if r#>>'{0,classification}'<>'ambiguous' then raise exception 'CANCELLED_ALONE_NOT_EVIDENCE';end if;
  insert into public.audit_logs(gym_id,entity_id,entity_type,action,before_data,after_data) values(g,contract,'membership','membership.cancelled','{"status":"active"}',
    jsonb_build_object('cancelled_at',stopped,'history_preserved',true,'payments_unchanged',true));
  r:=private.member_streak_coverage(g,m);
  if r#>>'{0,classification}'<>'valid' or r#>>'{0,cancelOn}'<>'2026-10-28' then raise exception 'AUDITED_CANCELLATION';end if;
  update public.member_payments set status='refunded' where id=pay;
  r:=private.member_streak_coverage(g,m);
  if r#>>'{0,classification}'<>'ambiguous' then raise exception 'REFUND_INTENT_UNKNOWN';end if;
  insert into private.member_streak_coverage_resolutions(period_id,disposition,effective_end_on,evidence_reference)
    values(period,'legitimate','2026-10-27','Fixture: commercial refund after legitimate coverage');
  r:=private.member_streak_coverage(g,m);
  if r#>>'{0,classification}'<>'valid' or r#>>'{0,cancelOn}'<>'2026-10-28' then raise exception 'LEGITIMATE_REFUND';end if;
  failed:=false;
  begin update private.member_streak_coverage_resolutions set effective_end_on='2027-01-01' where period_id=period;
    exception when check_violation then failed:=true;end;
  if not failed then raise exception 'RESOLUTION_EXTENDED_COVERAGE';end if;
  update private.member_streak_coverage_resolutions set disposition='retroactively_invalid',effective_end_on=null where period_id=period;
  if private.member_streak_coverage(g,m)#>>'{0,classification}'<>'invalid' then raise exception 'RETROACTIVE_INVALIDATION';end if;
  if private.member_streak_coverage(gen_random_uuid(),m)<>'[]'::jsonb then raise exception 'TENANT_EVIDENCE_LEAK';end if;
  failed:=false;
  begin perform public.get_member_personal_streaks_backend(gen_random_uuid(),m);
    exception when insufficient_privilege then failed:=true;end;
  if not failed then raise exception 'TENANT_RPC_LEAK';end if;
  update public.gym_users set status='inactive' where id=m;
  failed:=false;
  begin perform public.get_member_personal_streaks_backend(g,m);
    exception when insufficient_privilege then failed:=true;end;
  if not failed then raise exception 'INACTIVE_MEMBER_ACCESS';end if;
  if has_function_privilege('anon','public.get_member_personal_streaks_backend(uuid,uuid)','execute')
    or has_function_privilege('authenticated','public.get_member_personal_streaks_backend(uuid,uuid)','execute')
    or not has_function_privilege('service_role','public.get_member_personal_streaks_backend(uuid,uuid)','execute')
    or has_function_privilege('service_role','private.member_personal_streaks(uuid,uuid,timestamptz)','execute')
    or has_table_privilege('service_role','private.member_streak_coverage_resolutions','insert') then
    raise exception 'STREAK_ACL';end if;
end;$$;
select '0057 evidence contract OK: ambiguous cancellation, audited termination, refund, retroactive, tenant, ACL' result;
rollback;
