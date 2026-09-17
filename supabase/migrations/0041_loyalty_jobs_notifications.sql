begin;
set local lock_timeout='5s';

create function private.evaluate_member_loyalty(g uuid,m uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare today date; tz text; week_start date; last_visit date; visits integer; early integer; weekly integer; target integer; goal text;
 p public.gym_promotions; r public.member_rewards; prog integer; badge record; qualified boolean; pair record;
begin
 perform private.loyalty_member(g,m);
 select timezone,(now() at time zone timezone)::date into tz,today from public.gyms where id=g;
 week_start:=date_trunc('week',today)::date;
 select count(distinct attendance_date),count(distinct attendance_date) filter(where (checked_in_at at time zone tz)::time<'07:00'),
 count(distinct attendance_date) filter(where attendance_date>=week_start),max(attendance_date)
 into visits,early,weekly,last_visit from public.attendances where gym_id=g and member_user_id=m and status='valid' and source<>'extra_class' and attendance_date<=today;
 select least(training_frequency_per_week,7),goal_type into target,goal from public.member_fitness_profiles where gym_id=g and member_user_id=m;
 target:=least(coalesce(target,3),greatest(1,7-(today-week_start)+weekly));
 insert into public.loyalty_missions(gym_id,member_user_id,week_starts_on,target,goal_type) values(g,m,week_start,target,coalesce(goal,'general_wellness')) on conflict do nothing;
 select lm.target into target from public.loyalty_missions lm where gym_id=g and member_user_id=m and week_starts_on=week_start;
 if weekly>=target then perform private.loyalty_notify(g,m,'mission:'||week_start,'mission','¡Meta semanal completada!','Has alcanzado tu meta personal de '||target||' días.'); end if;

 for p in select * from public.gym_promotions where gym_id=g and status='active' and starts_on<=today and redeem_until>=today order by published_at,id loop
   if p.rule_type='recovery' and today<=p.ends_on and p.target<=p.ends_on-today+1 and last_visit is not null and today-last_visit>=p.inactive_days
     and exists(select 1 from public.gym_users where id=m and default_location_id=p.location_id)
     and exists(select 1 from public.memberships ms join public.membership_periods mp on mp.membership_id=ms.id and mp.gym_id=g where ms.gym_id=g and ms.member_user_id=m and ms.status='active' and mp.status='active' and today between mp.starts_on and mp.ends_on) then
     insert into public.loyalty_recovery_invitations(gym_id,promotion_id,member_user_id,invited_on,last_visit_on) values(g,p.id,m,today,last_visit) on conflict do nothing;
     perform private.loyalty_notify(g,m,'recovery:'||p.id,'recovery','Tu próximo paso te espera',p.name||'. Vuelve a tu ritmo y consulta este reto en Recompensas.');
   end if;
   prog:=private.loyalty_progress(p,m);
   if prog>0 then
     insert into public.loyalty_participation(gym_id,promotion_id,member_user_id,first_progress_on,progress) values(g,p.id,m,today,prog)
     on conflict(gym_id,promotion_id,member_user_id) do update set progress=excluded.progress,evaluated_at=now();
   end if;
   if prog>=p.target and not exists(select 1 from public.member_rewards where gym_id=g and promotion_id=p.id and member_user_id=m) then
     if p.auto_award then
       begin
         if p.rule_type='referral' then
           for pair in select id from private.valid_loyalty_referrals(g,p.id) where referrer_id=m or referred_id=m order by id loop perform private.issue_referral_pair(g,pair.id); end loop;
         else perform private.issue_loyalty_reward(g,m,p.id); end if;
       exception when raise_exception then
         if sqlerrm not in ('REWARD_QUOTA_REACHED','PROMOTION_UNAVAILABLE','LOYALTY_MEMBER_REQUIRED','REWARD_TARGET_NOT_MET','REFERRAL_PAYMENT_REQUIRED') then raise; end if;
       end;
     else perform private.loyalty_notify(g,m,'ready:'||p.id,'reward_ready','¡Meta alcanzada!',p.name||'. Reclama tu recompensa mientras queden cupos.'); end if;
   end if;
 end loop;
 -- Revalidate badges from original events; changing weight never grants competitive awards.
 for badge in select * from public.loyalty_badges loop
   qualified:=case badge.code when 'first_visit' then visits>=1 when 'visits_10' then visits>=10 when 'visits_50' then visits>=50 when 'early_bird' then early>=5
    when 'weekly_goal' then exists(select 1 from public.loyalty_missions lm where lm.gym_id=g and lm.member_user_id=m and
      (select count(distinct attendance_date) from public.attendances where gym_id=g and member_user_id=m and status='valid' and source<>'extra_class' and attendance_date between lm.week_starts_on and least(lm.week_starts_on+6,today))>=lm.target)
    when 'comeback' then exists(select 1 from public.gym_promotions cp join public.loyalty_recovery_invitations ri on ri.promotion_id=cp.id and ri.gym_id=g and ri.member_user_id=m where cp.gym_id=g and cp.rule_type='recovery' and private.loyalty_progress(cp,m)>=cp.target)
    else false end;
   if qualified then
     insert into public.member_badges(gym_id,member_user_id,badge_code) values(g,m,badge.code)
     on conflict(gym_id,member_user_id,badge_code) do update set valid=true;
     perform private.loyalty_notify(g,m,'badge:'||badge.code,'badge','Nueva medalla: '||badge.name,badge.description);
   else update public.member_badges set valid=false where gym_id=g and member_user_id=m and badge_code=badge.code and valid; end if;
 end loop;
 for r in select * from public.member_rewards where gym_id=g and member_user_id=m and status='available' loop
   select * into p from public.gym_promotions where id=r.promotion_id and gym_id=g;
   if r.expires_on>=today and private.loyalty_progress(p,m)<p.target then
     update public.member_rewards set status='revoked',revoked_reason='La condición original dejó de ser válida.' where id=r.id;
     insert into public.audit_logs(gym_id,action,entity_type,entity_id,before_data,after_data)
     values(g,'reward.automatically_revoked','reward',r.id,to_jsonb(r),jsonb_build_object('reason','eligibility_reversed'));
     continue;
   end if;
   if r.expires_on<today then perform private.loyalty_notify(g,m,'expired:'||r.id,'expired','Una recompensa ha vencido',r.terms->>'name');
   elsif r.expires_on-today in (1,3) then perform private.loyalty_notify(g,m,'expiry:'||r.id||':'||(r.expires_on-today),'expiry','Tu recompensa está por vencer',(r.terms->>'name')||'. Canje hasta '||r.expires_on||'.'); end if;
 end loop;
end; $$;

create function private.reward_status_notification() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if old.status is distinct from new.status then
 perform private.loyalty_notify(new.gym_id,new.member_user_id,'status:'||new.id||':'||new.status,'reward_status',
  case new.status when 'redeemed' then 'Recompensa canjeada' else 'Recompensa revocada' end,
  (new.terms->>'name')||case when new.status='revoked' then '. Motivo: '||coalesce(new.revoked_reason,'Consulta al gimnasio') else '. Gracias por tu constancia.' end);
 end if; return new;
end; $$;
create trigger reward_status_notification after update of status on public.member_rewards for each row execute function private.reward_status_notification();

-- Monthly metrics: event dates for awards/redemptions; observational 30-day retention, not a causal claim.
create function private.loyalty_month_metrics(g uuid,month_start date) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb; month_end date:=(month_start+interval '1 month')::date; tz text; today date;
begin
 select timezone,(now() at time zone timezone)::date into tz,today from public.gyms where id=g;
 select coalesce(jsonb_agg(jsonb_build_object(
   'promotion_id',p.id,'name',p.name,'currency',(select currency from public.gyms where id=g),'reward_type',p.reward_type,
   'participants',(select count(*) from public.loyalty_participation a where a.gym_id=g and a.promotion_id=p.id and a.first_progress_on<month_end and a.first_progress_on>=month_start),
   'awarded',(select count(*) from public.member_rewards r where r.gym_id=g and r.promotion_id=p.id and (r.earned_at at time zone tz)::date>=month_start and (r.earned_at at time zone tz)::date<month_end),
   'redeemed',(select count(*) from public.reward_redemptions d join public.member_rewards r on r.id=d.reward_id and r.gym_id=g where d.gym_id=g and r.promotion_id=p.id and (d.created_at at time zone tz)::date>=month_start and (d.created_at at time zone tz)::date<month_end),
   'discount_total',coalesce((select sum(d.discount_amount) from public.reward_redemptions d join public.member_rewards r on r.id=d.reward_id and r.gym_id=g where d.gym_id=g and r.promotion_id=p.id and (d.created_at at time zone tz)::date>=month_start and (d.created_at at time zone tz)::date<month_end),0),
   'product_cost',coalesce((select sum(d.product_cost) from public.reward_redemptions d join public.member_rewards r on r.id=d.reward_id and r.gym_id=g where d.gym_id=g and r.promotion_id=p.id and (d.created_at at time zone tz)::date>=month_start and (d.created_at at time zone tz)::date<month_end),0),
   'unknown_product_costs',(select count(*) from public.reward_redemptions d join public.member_rewards r on r.id=d.reward_id and r.gym_id=g where d.gym_id=g and r.promotion_id=p.id and d.inventory_movement_id is not null and d.product_cost is null and (d.created_at at time zone tz)::date>=month_start and (d.created_at at time zone tz)::date<month_end),
   'free_months',coalesce((select sum((r.terms->>'reward_value')::integer) from public.reward_redemptions d join public.member_rewards r on r.id=d.reward_id and r.gym_id=g where d.gym_id=g and r.promotion_id=p.id and r.terms->>'reward_type'='free_period' and (d.created_at at time zone tz)::date>=month_start and (d.created_at at time zone tz)::date<month_end),0),
   'retention_eligible',(select count(*) from public.loyalty_participation a where a.gym_id=g and a.promotion_id=p.id and a.first_progress_on>=month_start and a.first_progress_on<month_end and a.first_progress_on+60<=today),
   'retention_returned',(select count(*) from public.loyalty_participation a where a.gym_id=g and a.promotion_id=p.id and a.first_progress_on>=month_start and a.first_progress_on<month_end and a.first_progress_on+60<=today and exists(select 1 from public.attendances t where t.gym_id=g and t.member_user_id=a.member_user_id and t.status='valid' and t.source<>'extra_class' and t.attendance_date between a.first_progress_on+30 and a.first_progress_on+59)),
   'referrals',(select count(*) from public.loyalty_referrals r where r.gym_id=g and r.promotion_id=p.id and (r.created_at at time zone tz)::date>=month_start and (r.created_at at time zone tz)::date<month_end),
   'qualified_referrals',(select count(*) from private.valid_loyalty_referrals(g,p.id) f join public.loyalty_referrals r on r.id=f.id where (r.created_at at time zone tz)::date>=month_start and (r.created_at at time zone tz)::date<month_end)
 ) order by p.created_at),'[]') into result from public.gym_promotions p where p.gym_id=g and p.status<>'draft' and p.starts_on<month_end and p.redeem_until>=month_start;
 return jsonb_build_object('month',month_start,'campaigns',result,'calculated_at',now());
end; $$;

create function private.run_loyalty_batch(g uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare job private.loyalty_jobs; m record; n integer:=0; today date; month_start date; closed_month date; failures integer:=0;
begin
 insert into private.loyalty_jobs(gym_id) values(g) on conflict do nothing;
 select * into job from private.loyalty_jobs where gym_id=g for update;
 select (now() at time zone timezone)::date into today from public.gyms where id=g;
 if job.completed_on=today and job.cursor_id is null then return jsonb_build_object('gym_id',g,'processed',0,'done',true); end if;
 for m in select id from public.gym_users where gym_id=g and role='member' and status='active' and (job.cursor_id is null or id>job.cursor_id) order by id limit 100 loop
   perform private.evaluate_member_loyalty(g,m.id);
   job.cursor_id:=m.id; n:=n+1;
 end loop;
 if n<100 then
   month_start:=date_trunc('month',today)::date;
   -- Catch up all completed months since feature installation, with a 24-month bound per run.
   for closed_month in select d::date from generate_series(greatest(coalesce((select max(month)+interval '1 month' from public.loyalty_monthly_reports where gym_id=g),(select date_trunc('month',min(first_progress_on)) from public.loyalty_participation where gym_id=g),month_start-interval '1 month'),month_start-interval '24 months'),month_start-interval '1 month',interval '1 month')d loop
     insert into public.loyalty_monthly_reports(gym_id,month,metrics) values(g,closed_month,private.loyalty_month_metrics(g,closed_month)) on conflict do nothing;
   end loop;
   update public.gym_promotions set status='closed' where gym_id=g and status in ('active','paused') and redeem_until<today;
   update private.loyalty_jobs set cursor_id=null,completed_on=today,last_run_at=now(),last_error=null where gym_id=g;
 else update private.loyalty_jobs set cursor_id=job.cursor_id,last_run_at=now(),last_error=null where gym_id=g;
 end if;
 return jsonb_build_object('gym_id',g,'processed',n,'done',n<100);
end; $$;

create function public.run_next_loyalty_batch_backend() returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare g uuid;
begin
 insert into private.loyalty_jobs(gym_id) select id from public.gyms where status in ('trial','active','past_due') on conflict do nothing;
 select j.gym_id into g from private.loyalty_jobs j join public.gyms gym on gym.id=j.gym_id
 where gym.status in ('trial','active','past_due') and (j.completed_on is null or j.completed_on<(now() at time zone gym.timezone)::date or j.cursor_id is not null)
 and (j.last_error is null or j.last_run_at<now()-interval '30 minutes')
 order by j.last_run_at nulls first,j.gym_id for update of j skip locked limit 1;
 if g is null then return null; end if;
 begin return private.run_loyalty_batch(g);
 exception when others then
   update private.loyalty_jobs set last_error='EVALUATION_FAILED',last_run_at=now() where gym_id=g;
   return jsonb_build_object('gym_id',g,'failed',true);
 end;
end; $$;

create function public.evaluate_loyalty_backend(g uuid,actor uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform private.loyalty_owner(g,actor);
 insert into private.loyalty_jobs(gym_id) values(g) on conflict do nothing;
 update private.loyalty_jobs set completed_on=null where gym_id=g;
 return private.run_loyalty_batch(g);
end; $$;

create function public.loyalty_engagement_backend(g uuid,actor uuid,member uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare today date; week_start date; code text; result jsonb;
begin
 if actor is distinct from member then perform private.loyalty_owner(g,actor); end if;
 perform private.loyalty_member(g,member);
 select (now() at time zone timezone)::date into today from public.gyms where id=g;
 week_start:=date_trunc('week',today)::date;
 select c.code into code from public.loyalty_referral_codes c where c.gym_id=g and c.member_user_id=member;
 return jsonb_build_object('today',today,'referral_code',code,
 'preferences',coalesce((select jsonb_build_object('email',email_enabled,'whatsapp',whatsapp_enabled) from public.loyalty_notification_preferences where gym_id=g and member_user_id=member),'{"email":false,"whatsapp":false}'::jsonb),
 'notifications',coalesce((select jsonb_agg(x order by created_at desc) from (select id,kind,title,body,created_at,read_at from public.loyalty_notifications where gym_id=g and member_user_id=member order by created_at desc limit 50)x),'[]'::jsonb),
 'unread',(select count(*) from public.loyalty_notifications where gym_id=g and member_user_id=member and read_at is null),
 'badges',coalesce((select jsonb_agg(jsonb_build_object('code',b.code,'name',b.name,'description',b.description,'earned_at',mb.earned_at,'earned',coalesce(mb.valid,false)) order by b.code) from public.loyalty_badges b left join public.member_badges mb on mb.badge_code=b.code and mb.gym_id=g and mb.member_user_id=member),'[]'::jsonb),
 'mission',(select jsonb_build_object('target',lm.target,'goal',lm.goal_type,'week',lm.week_starts_on,'progress',(select count(distinct attendance_date) from public.attendances where gym_id=g and member_user_id=member and status='valid' and source<>'extra_class' and attendance_date between week_start and today)) from public.loyalty_missions lm where lm.gym_id=g and lm.member_user_id=member and lm.week_starts_on=week_start),
 'referrals',jsonb_build_object('registered',(select count(*) from public.loyalty_referrals where gym_id=g and referrer_id=member),'qualified',(select count(*) from public.loyalty_referrals r where r.gym_id=g and r.referrer_id=member and exists(select 1 from private.valid_loyalty_referrals(g,r.promotion_id) f where f.id=r.id))),
 'received_referral',(select jsonb_build_object('promotion_id',promotion_id,'registered_at',created_at,'qualified',exists(select 1 from private.valid_loyalty_referrals(g,r.promotion_id) f where f.id=r.id)) from public.loyalty_referrals r where gym_id=g and referred_id=member));
end; $$;

create function public.loyalty_preferences_backend(g uuid,actor uuid,email boolean,whatsapp boolean) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform private.loyalty_member(g,actor);
 insert into public.loyalty_notification_preferences(gym_id,member_user_id,email_enabled,whatsapp_enabled) values(g,actor,email,whatsapp)
 on conflict(gym_id,member_user_id) do update set email_enabled=excluded.email_enabled,whatsapp_enabled=excluded.whatsapp_enabled,updated_at=now();
 insert into public.audit_logs(gym_id,actor_gym_user_id,action,entity_type,entity_id,after_data) values(g,actor,'loyalty.notification_consent','gym_user',actor,jsonb_build_object('email',email,'whatsapp',whatsapp));
end; $$;
create function public.read_loyalty_notification_backend(g uuid,actor uuid,notification uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform private.loyalty_member(g,actor);
 update public.loyalty_notifications set read_at=coalesce(read_at,now()) where gym_id=g and member_user_id=actor and id=notification;
 if not found then raise exception 'LOYALTY_NOTIFICATION_NOT_FOUND'; end if;
end; $$;

create function public.loyalty_analytics_backend(g uuid,actor uuid,selected_month date) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare month_start date:=date_trunc('month',selected_month)::date; snapshot public.loyalty_monthly_reports; today date;
begin
 perform private.loyalty_owner(g,actor);
 select (now() at time zone timezone)::date into today from public.gyms where id=g;
 if selected_month is null or month_start>today or month_start<today-interval '5 years' then raise exception 'LOYALTY_MONTH_INVALID'; end if;
 select * into snapshot from public.loyalty_monthly_reports where gym_id=g and month=month_start;
 return jsonb_build_object('current',private.loyalty_month_metrics(g,month_start),'snapshot',snapshot.metrics,'closed_at',snapshot.closed_at,
 'job',(select jsonb_build_object('last_run_at',last_run_at,'completed_on',completed_on,'pending',cursor_id is not null) from private.loyalty_jobs where gym_id=g),
 'pending_rewards',(select count(*) from public.member_rewards where gym_id=g and status='available' and expires_on>=today),
 'expiring_rewards',(select count(*) from public.member_rewards where gym_id=g and status='available' and expires_on between today and today+3));
end; $$;

-- Leased outbox. A worker can acknowledge only its own unexpired lease.
create function public.claim_loyalty_deliveries_backend() returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 update private.loyalty_deliveries d set status='skipped' from public.loyalty_notifications n
 where n.id=d.notification_id and d.status in ('pending','processing') and not exists(select 1 from public.loyalty_notification_preferences p join public.gym_users u on u.id=p.member_user_id and u.gym_id=p.gym_id and u.status='active'
 where p.gym_id=n.gym_id and p.member_user_id=n.member_user_id and case d.channel when 'email' then p.email_enabled else p.whatsapp_enabled end);
 update private.loyalty_deliveries set status='failed',last_error='RETRY_LIMIT' where status='processing' and lease_until<now() and attempts>=5;
 with candidates as (select id from private.loyalty_deliveries where attempts<5 and available_at<=now() and (status='pending' or (status='processing' and lease_until<now())) order by available_at,id for update skip locked limit 20),
 claimed as (update private.loyalty_deliveries d set status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes' from candidates c where d.id=c.id returning d.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'lease_token',d.lease_token,'channel',d.channel,'title',n.title,'body',n.body,'gym_id',n.gym_id,
 'recipient',case d.channel when 'email' then u.email else pr.phone end)),'[]') into result
 from claimed d join public.loyalty_notifications n on n.id=d.notification_id join public.gym_users gu on gu.id=n.member_user_id and gu.gym_id=n.gym_id
 left join auth.users u on u.id=gu.profile_id left join public.profiles pr on pr.id=gu.profile_id;
 return result;
end; $$;
create function public.finish_loyalty_delivery_backend(delivery uuid,token uuid,success boolean,error_code text) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update private.loyalty_deliveries set status=case when success then 'sent' when attempts>=5 then 'failed' else 'pending' end,
 sent_at=case when success then now() else null end,last_error=case when success then null else left(error_code,80) end,
 available_at=now()+make_interval(mins=>power(2,attempts)::integer),lease_until=null,lease_token=null
 where id=delivery and lease_token=token and status='processing' and lease_until>now();
end; $$;

do $$ declare f record; begin
 for f in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('private','public') and p.proname in ('evaluate_member_loyalty','reward_status_notification','loyalty_month_metrics','run_loyalty_batch','run_next_loyalty_batch_backend','evaluate_loyalty_backend','loyalty_engagement_backend','loyalty_preferences_backend','read_loyalty_notification_backend','loyalty_analytics_backend','claim_loyalty_deliveries_backend','finish_loyalty_delivery_backend') loop
 execute format('revoke all on function %I.%I(%s) from public,anon,authenticated',f.nspname,f.proname,f.args);
 if f.nspname='public' then execute format('grant execute on function %I.%I(%s) to service_role',f.nspname,f.proname,f.args); end if;
 end loop;
end; $$;
create or replace function public.member_loyalty_backend(g uuid, actor uuid, member uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare today date; campaigns jsonb; rewards jsonb;
begin
  if actor is distinct from member then perform private.loyalty_owner(g,actor); end if;
  if not exists(select 1 from public.gym_users where id=member and gym_id=g and role='member' and status='active') then
    raise exception 'LOYALTY_MEMBER_REQUIRED' using errcode='42501'; end if;
  select (now() at time zone timezone)::date into today from public.gyms where id=g;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'status',p.status,
    'starts_on',p.starts_on,'ends_on',p.ends_on,'redeem_until',p.redeem_until,'rule_type',p.rule_type,'target',p.target,'auto_award',p.auto_award,'inactive_days',p.inactive_days,'minimum_payment',p.minimum_payment,
    'reward_type',p.reward_type,'reward_value',p.reward_value,'product_name',p.product_name,'location_name',l.name,
    'progress',private.loyalty_progress(p,member),'max_rewards',p.max_rewards,
    'remaining',greatest(0,p.max_rewards-(select count(*) from public.member_rewards r where r.promotion_id=p.id))) order by p.ends_on),'[]') into campaigns
    from public.gym_promotions p join public.gym_locations l on l.id=p.location_id
    where p.gym_id=g and p.status in ('active','paused') and p.redeem_until>=today and (p.rule_type<>'recovery' or exists(select 1 from public.loyalty_recovery_invitations ri where ri.gym_id=g and ri.promotion_id=p.id and ri.member_user_id=member));
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'promotion_id',r.promotion_id,'terms',r.terms - 'created_by' - 'created_at' - 'gym_id' - 'required_dates','earned_at',r.earned_at,'expires_on',r.expires_on,
    'status',case when r.status='available' and r.expires_on<today then 'expired' else r.status end,'revoked_reason',r.revoked_reason) order by r.earned_at desc),'[]') into rewards
    from public.member_rewards r where r.gym_id=g and r.member_user_id=member;
  return jsonb_build_object('today',today,'promotions',campaigns,'rewards',rewards);
end;
$$;

commit;
