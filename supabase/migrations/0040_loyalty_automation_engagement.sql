begin;
set local lock_timeout='5s';

alter table public.gym_promotions add column auto_award boolean not null default false,
  add column inactive_days integer not null default 14 check(inactive_days between 7 and 180),
  add column minimum_payment numeric(12,2) not null default 1 check(minimum_payment between 0.01 and 999999);
alter table public.gym_promotions drop constraint gym_promotions_rule_type_check;
alter table public.gym_promotions add constraint gym_promotions_rule_type_check check(rule_type in ('attendance_count','required_streak','perfect_attendance','recovery','referral'));
alter table public.gym_promotions add constraint referral_rule_target check(rule_type<>'referral' or (target=1 and max_rewards>=2));
alter table public.gym_promotions add constraint recovery_rule_target check(rule_type<>'recovery' or target<=ends_on-starts_on+1);

create table public.loyalty_notifications (
 id uuid primary key default gen_random_uuid(), gym_id uuid not null references public.gyms(id),
 member_user_id uuid not null references public.gym_users(id), event_key text not null,
 kind text not null, title text not null, body text not null, created_at timestamptz not null default now(), read_at timestamptz,
 unique(gym_id,member_user_id,event_key)
);
create index loyalty_notifications_member_idx on public.loyalty_notifications(gym_id,member_user_id,created_at desc);
create table public.loyalty_notification_preferences (
 gym_id uuid not null references public.gyms(id), member_user_id uuid not null references public.gym_users(id),
 email_enabled boolean not null default false, whatsapp_enabled boolean not null default false, updated_at timestamptz not null default now(),
 primary key(gym_id,member_user_id)
);
create table private.loyalty_deliveries (
 id uuid primary key default gen_random_uuid(), notification_id uuid not null references public.loyalty_notifications(id),
 channel text not null check(channel in ('email','whatsapp')), status text not null default 'pending' check(status in ('pending','processing','sent','failed','skipped')),
 attempts integer not null default 0, available_at timestamptz not null default now(), lease_until timestamptz, lease_token uuid,
 last_error text, sent_at timestamptz, unique(notification_id,channel)
);
create index loyalty_deliveries_pending_idx on private.loyalty_deliveries(status,available_at);
create table public.loyalty_badges (
 code text primary key, name text not null, description text not null
);
insert into public.loyalty_badges values
 ('first_visit','Primer paso','Una asistencia general válida.'),
 ('visits_10','En movimiento','Diez días de asistencia general válida.'),
 ('visits_50','Constancia','Cincuenta días de asistencia general válida.'),
 ('early_bird','Madrugador','Cinco días con entrada antes de las 07:00, en la zona horaria del gimnasio.'),
 ('weekly_goal','A tu ritmo','Completar una meta semanal personal.'),
 ('comeback','De vuelta','Volver y completar un reto de recuperación.');
create table public.member_badges (
 gym_id uuid not null references public.gyms(id), member_user_id uuid not null references public.gym_users(id),
 badge_code text not null references public.loyalty_badges(code), earned_at timestamptz not null default now(), valid boolean not null default true,
 primary key(gym_id,member_user_id,badge_code)
);
create table public.loyalty_missions (
 gym_id uuid not null references public.gyms(id), member_user_id uuid not null references public.gym_users(id),
 week_starts_on date not null, target integer not null check(target between 1 and 7), goal_type text not null,
 created_at timestamptz not null default now(), primary key(gym_id,member_user_id,week_starts_on)
);
create table public.loyalty_recovery_invitations (
 gym_id uuid not null references public.gyms(id), promotion_id uuid not null, member_user_id uuid not null references public.gym_users(id),
 invited_on date not null, last_visit_on date not null, created_at timestamptz not null default now(),
 primary key(gym_id,promotion_id,member_user_id), foreign key(promotion_id,gym_id) references public.gym_promotions(id,gym_id)
);
create table public.loyalty_referral_codes (
 gym_id uuid not null references public.gyms(id), member_user_id uuid not null references public.gym_users(id),
 code text not null default upper(encode(extensions.gen_random_bytes(8),'hex')), primary key(gym_id,member_user_id), unique(gym_id,code)
);
create table public.loyalty_referrals (
 id uuid primary key default gen_random_uuid(), gym_id uuid not null references public.gyms(id), promotion_id uuid not null,
 referrer_id uuid not null references public.gym_users(id), referred_id uuid not null references public.gym_users(id),
 created_at timestamptz not null default now(), unique(gym_id,referred_id), check(referrer_id<>referred_id),
 foreign key(promotion_id,gym_id) references public.gym_promotions(id,gym_id)
);
create index loyalty_referrals_campaign_idx on public.loyalty_referrals(gym_id,promotion_id,referrer_id);
create table public.loyalty_participation (
 gym_id uuid not null references public.gyms(id), promotion_id uuid not null, member_user_id uuid not null references public.gym_users(id),
 first_progress_on date not null, progress integer not null, evaluated_at timestamptz not null default now(),
 primary key(gym_id,promotion_id,member_user_id), foreign key(promotion_id,gym_id) references public.gym_promotions(id,gym_id)
);
create table public.loyalty_monthly_reports (
 gym_id uuid not null references public.gyms(id), month date not null, metrics jsonb not null, closed_at timestamptz not null default now(),
 primary key(gym_id,month)
);
create table private.loyalty_jobs (
 gym_id uuid primary key references public.gyms(id), cursor_id uuid, completed_on date, last_run_at timestamptz, last_error text
);

do $$ declare t text; begin
 foreach t in array array['loyalty_notifications','loyalty_notification_preferences','member_badges','loyalty_missions','loyalty_recovery_invitations','loyalty_referral_codes','loyalty_participation'] loop
   execute format('create trigger loyalty_member_tenant before insert or update on public.%I for each row execute function private.enforce_tenant_reference(''member_user_id'',''gym_users'')',t);
 end loop;
 foreach t in array array['loyalty_notifications','loyalty_notification_preferences','loyalty_badges','member_badges','loyalty_missions','loyalty_recovery_invitations','loyalty_referral_codes','loyalty_referrals','loyalty_participation','loyalty_monthly_reports'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from public,anon,authenticated',t);
   execute format('grant all on public.%I to service_role',t);
 end loop;
end; $$;
create trigger referral_referrer_tenant before insert or update on public.loyalty_referrals for each row execute function private.enforce_tenant_reference('referrer_id','gym_users');
create trigger referral_referred_tenant before insert or update on public.loyalty_referrals for each row execute function private.enforce_tenant_reference('referred_id','gym_users');
revoke all on private.loyalty_jobs, private.loyalty_deliveries from public,anon,authenticated;

create function private.loyalty_member(g uuid,m uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not exists(select 1 from public.gym_users where id=m and gym_id=g and role='member' and status='active') then raise exception 'LOYALTY_MEMBER_REQUIRED' using errcode='42501'; end if;
end; $$;

create function private.loyalty_notify(g uuid,m uuid,k text,kind text,title text,body text) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare n uuid;
begin
 insert into public.loyalty_notifications(gym_id,member_user_id,event_key,kind,title,body) values(g,m,k,kind,title,body)
 on conflict(gym_id,member_user_id,event_key) do nothing returning id into n;
 if n is null then return; end if;
 insert into private.loyalty_deliveries(notification_id,channel)
 select n,c.channel from public.loyalty_notification_preferences p cross join (values('email'),('whatsapp'))c(channel)
 where p.gym_id=g and p.member_user_id=m and case c.channel when 'email' then p.email_enabled else p.whatsapp_enabled end;
end; $$;

-- Count only the first effective membership payment (failed/pending attempts do not disqualify it).
create function private.valid_loyalty_referrals(g uuid,p uuid) returns table(id uuid,referrer_id uuid,referred_id uuid,payment_id uuid)
language sql stable security definer set search_path=pg_catalog,public as $$
 select r.id,r.referrer_id,r.referred_id,pay.id from public.loyalty_referrals r
 join public.gym_promotions promo on promo.id=r.promotion_id and promo.gym_id=r.gym_id
 join public.gyms gym on gym.id=r.gym_id
 join lateral (select mp.* from public.member_payments mp where mp.gym_id=g and mp.member_user_id=r.referred_id and mp.membership_id is not null and mp.status in ('confirmed','refunded') order by mp.created_at,mp.id limit 1)pay on true
 join public.memberships ms on ms.id=pay.membership_id and ms.gym_id=g
 join public.plans plan on plan.id=ms.plan_id and plan.gym_id=g
 join public.membership_periods period on period.payment_id=pay.id and period.gym_id=g and period.status<>'cancelled'
 where r.gym_id=g and r.promotion_id=p and pay.status='confirmed' and pay.amount>=promo.minimum_payment and pay.currency=gym.currency
 and pay.paid_at>=r.created_at and (pay.paid_at at time zone gym.timezone)::date between promo.starts_on and promo.ends_on
 and period.ends_on=(period.starts_on+interval '1 month')::date-1;
$$;

alter function private.loyalty_progress(public.gym_promotions,uuid) rename to loyalty_attendance_progress;
create function private.loyalty_progress(p public.gym_promotions,member uuid) returns integer
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare invited date; today date;
begin
 if p.rule_type='referral' then
   return case when exists(select 1 from private.valid_loyalty_referrals(p.gym_id,p.id) r where r.referrer_id=member or r.referred_id=member) then 1 else 0 end;
 elsif p.rule_type='recovery' then
   select invited_on into invited from public.loyalty_recovery_invitations where gym_id=p.gym_id and promotion_id=p.id and member_user_id=member;
   if invited is null then return 0; end if;
   select (now() at time zone timezone)::date into today from public.gyms where id=p.gym_id;
   return (select count(distinct attendance_date)::integer from public.attendances where gym_id=p.gym_id and member_user_id=member and location_id=p.location_id
     and status='valid' and source<>'extra_class' and attendance_date between greatest(invited,p.starts_on) and least(today,p.ends_on));
 end if;
 return private.loyalty_attendance_progress(p,member);
end; $$;

create function public.attach_loyalty_referral_backend(g uuid,actor uuid,member uuid,promotion uuid,supplied_code text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare referrer uuid; p public.gym_promotions; today date; result uuid;
begin
 if actor is distinct from member then perform private.loyalty_owner(g,actor); end if;
 perform private.loyalty_member(g,member);
 -- Same lock as checkout's member FK validation; serializes attribution against a concurrent first payment.
 perform 1 from public.gym_users where id=member and gym_id=g for update;
 select * into p from public.gym_promotions where id=promotion and gym_id=g;
 select (now() at time zone timezone)::date into today from public.gyms where id=g;
 if p.id is null or p.rule_type<>'referral' or p.status<>'active' or today not between p.starts_on and p.ends_on then raise exception 'PROMOTION_UNAVAILABLE'; end if;
 select c.member_user_id into referrer from public.loyalty_referral_codes c join public.gym_users u on u.id=c.member_user_id and u.gym_id=g and u.status='active' and u.role='member'
 where c.gym_id=g and c.code=upper(trim(supplied_code));
 if referrer is null or referrer=member then raise exception 'REFERRAL_CODE_INVALID'; end if;
 if exists(select 1 from public.member_payments where gym_id=g and member_user_id=member and membership_id is not null and status in ('confirmed','refunded')) then raise exception 'REFERRAL_BEFORE_FIRST_PAYMENT'; end if;
 insert into public.loyalty_referrals(gym_id,promotion_id,referrer_id,referred_id) values(g,promotion,referrer,member) returning id into result;
 insert into public.audit_logs(gym_id,actor_gym_user_id,action,entity_type,entity_id,after_data)
 values(g,actor,'loyalty.referral_registered','loyalty_referral',result,jsonb_build_object('promotion_id',promotion,'referred_id',member));
 return result;
end; $$;

create function public.ensure_loyalty_code_backend(g uuid,actor uuid) returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare result text;
begin
 perform private.loyalty_member(g,actor);
 insert into public.loyalty_referral_codes(gym_id,member_user_id) values(g,actor) on conflict do nothing;
 select code into result from public.loyalty_referral_codes where gym_id=g and member_user_id=actor;
 return result;
end; $$;

-- Shared award primitive; all callers validate identity or run as the scheduled system job.
create function private.issue_loyalty_reward(g uuid,member uuid,promotion uuid,actor uuid default null) returns public.member_rewards
language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.gym_promotions; r public.member_rewards; today date;
begin
 perform private.loyalty_member(g,member);
 select * into p from public.gym_promotions where id=promotion and gym_id=g for update;
 if not found then raise exception 'PROMOTION_NOT_FOUND'; end if;
 select * into r from public.member_rewards where promotion_id=p.id and member_user_id=member;
 if found then return r; end if;
 select (now() at time zone timezone)::date into today from public.gyms where id=g;
 if p.status<>'active' or today<p.starts_on or today>p.redeem_until then raise exception 'PROMOTION_UNAVAILABLE'; end if;
 if private.loyalty_progress(p,member)<p.target then raise exception 'REWARD_TARGET_NOT_MET'; end if;
 if (select count(*) from public.member_rewards where promotion_id=p.id)>=p.max_rewards then raise exception 'REWARD_QUOTA_REACHED'; end if;
 insert into public.member_rewards(gym_id,promotion_id,member_user_id,expires_on,terms)
 values(g,p.id,member,p.redeem_until,to_jsonb(p)||jsonb_build_object('location_name',(select name from public.gym_locations where id=p.location_id and gym_id=g))) returning * into r;
 insert into public.audit_logs(gym_id,actor_gym_user_id,action,entity_type,entity_id,after_data)
 values(g,actor,case when actor is null then 'reward.automatically_earned' else 'reward.earned' end,'reward',r.id,jsonb_build_object('promotion_id',p.id,'member_user_id',member));
 perform private.loyalty_notify(g,member,'earned:'||r.id,'reward','¡Tienes una recompensa!',p.name||'. Solicita el canje antes del '||r.expires_on||'.');
 return r;
end; $$;

create function private.issue_referral_pair(g uuid,referral uuid,actor uuid default null) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.loyalty_referrals; p public.gym_promotions; needed integer;
begin
 select * into r from public.loyalty_referrals where id=referral and gym_id=g;
 select * into p from public.gym_promotions where id=r.promotion_id and gym_id=g for update;
 if p.id is null or not exists(select 1 from private.valid_loyalty_referrals(g,p.id) where id=referral) then raise exception 'REFERRAL_PAYMENT_REQUIRED'; end if;
 perform private.loyalty_member(g,r.referrer_id); perform private.loyalty_member(g,r.referred_id);
 select count(*) into needed from (values(r.referrer_id),(r.referred_id))m(id)
 where not exists(select 1 from public.member_rewards w where w.promotion_id=p.id and w.member_user_id=m.id);
 if (select count(*) from public.member_rewards where promotion_id=p.id)+needed>p.max_rewards then raise exception 'REWARD_QUOTA_REACHED'; end if;
 perform private.issue_loyalty_reward(g,r.referrer_id,p.id,actor);
 perform private.issue_loyalty_reward(g,r.referred_id,p.id,actor);
end; $$;

create or replace function public.claim_reward_backend(g uuid,actor uuid,member uuid,promotion uuid) returns public.member_rewards
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.member_rewards; ref uuid; kind text;
begin
 if actor is distinct from member then perform private.loyalty_owner(g,actor); end if;
 perform private.loyalty_member(g,member);
 select rule_type into kind from public.gym_promotions where id=promotion and gym_id=g;
 if kind='referral' then
   select id into ref from private.valid_loyalty_referrals(g,promotion) where referrer_id=member or referred_id=member order by id limit 1;
   if ref is null then raise exception 'REFERRAL_PAYMENT_REQUIRED'; end if;
   perform private.issue_referral_pair(g,ref,actor);
   select * into r from public.member_rewards where gym_id=g and promotion_id=promotion and member_user_id=member;
   return r;
 end if;
 return private.issue_loyalty_reward(g,member,promotion,actor);
end; $$;

-- Private cost snapshots, never returned by member endpoints.
alter table public.reward_redemptions add column product_cost numeric(12,2), add column cost_currency text;
create function private.snapshot_reward_cost() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.inventory_movement_id is not null then
   select abs(i.quantity_delta)*c.cost_price,p.currency into new.product_cost,new.cost_currency
   from public.inventory_movements i join private.product_costs c on c.product_id=i.product_id and c.gym_id=new.gym_id
   join public.products p on p.id=i.product_id and p.gym_id=new.gym_id where i.id=new.inventory_movement_id and i.gym_id=new.gym_id;
 end if;
 return new;
end; $$;
create trigger snapshot_reward_cost before insert on public.reward_redemptions for each row execute function private.snapshot_reward_cost();

create or replace function public.save_promotion_backend(g uuid, actor uuid, promotion uuid, input jsonb)
returns public.gym_promotions language plpgsql security definer set search_path = pg_catalog, public as $$
declare result public.gym_promotions; profile uuid; previous public.gym_promotions;
begin
  profile := private.loyalty_owner(g,actor);
  if promotion is not null then
    select * into previous from public.gym_promotions where id=promotion and gym_id=g for update;
    if not found or previous.status <> 'draft' then raise exception 'PROMOTION_TERMS_LOCKED'; end if;
  end if;
  if not exists(select 1 from public.gym_locations where id=(input->>'locationId')::uuid and gym_id=g and is_active) then
    raise exception 'ATTENDANCE_LOCATION_MISMATCH'; end if;
  if input->>'rewardType'='product' and not exists(select 1 from public.products where id=(input->>'productId')::uuid and gym_id=g and is_active) then
    raise exception 'PRODUCT_NOT_FOUND'; end if;
  if promotion is null then
    insert into public.gym_promotions(gym_id,location_id,name,description,starts_on,ends_on,redeem_until,rule_type,target,reward_type,reward_value,product_id,max_rewards,created_by,auto_award,inactive_days,minimum_payment)
    values(g,(input->>'locationId')::uuid,trim(input->>'name'),coalesce(input->>'description',''),(input->>'startsOn')::date,(input->>'endsOn')::date,
      (input->>'redeemUntil')::date,input->>'ruleType',(input->>'target')::integer,input->>'rewardType',(input->>'rewardValue')::integer,
      (input->>'productId')::uuid,(input->>'maxRewards')::integer,actor,coalesce((input->>'autoAward')::boolean,false),coalesce((input->>'inactiveDays')::integer,14),coalesce((input->>'minimumPayment')::numeric,1)) returning * into result;
  else
    update public.gym_promotions set location_id=(input->>'locationId')::uuid,name=trim(input->>'name'),description=coalesce(input->>'description',''),
      starts_on=(input->>'startsOn')::date,ends_on=(input->>'endsOn')::date,redeem_until=(input->>'redeemUntil')::date,
      rule_type=input->>'ruleType',target=(input->>'target')::integer,reward_type=input->>'rewardType',reward_value=(input->>'rewardValue')::integer,
      product_id=(input->>'productId')::uuid,max_rewards=(input->>'maxRewards')::integer,auto_award=coalesce((input->>'autoAward')::boolean,false),inactive_days=coalesce((input->>'inactiveDays')::integer,14),minimum_payment=coalesce((input->>'minimumPayment')::numeric,1) where id=promotion and gym_id=g returning * into result;
  end if;
  insert into public.audit_logs(gym_id,actor_profile_id,actor_gym_user_id,action,entity_type,entity_id,before_data,after_data)
    values(g,profile,actor,'promotion.saved','promotion',result.id,to_jsonb(previous),to_jsonb(result));
  return result;
end;
$$;

create or replace function private.lock_loyalty_reward(g uuid, actor uuid, reward uuid, member uuid)
returns public.member_rewards language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.member_rewards; p public.gym_promotions; today date;
begin
  perform private.loyalty_owner(g,actor);
  select * into r from public.member_rewards where id=reward and gym_id=g and member_user_id=member for update;
  if not found or r.status<>'available' then raise exception 'REWARD_NOT_AVAILABLE'; end if;
  if not exists(select 1 from public.gym_users where id=member and gym_id=g and role='member' and status='active') then raise exception 'LOYALTY_MEMBER_REQUIRED'; end if;
  select (now() at time zone timezone)::date into today from public.gyms where id=g;
  if r.expires_on<today then raise exception 'REWARD_EXPIRED'; end if;
  select * into p from public.gym_promotions where id=r.promotion_id and gym_id=g;
  -- Serialize with concurrent voids of qualifying attendance before validating eligibility.
  perform 1 from public.attendances where gym_id=g and member_user_id=member and location_id=p.location_id
    and status='valid' and source<>'extra_class' and attendance_date between p.starts_on and least(today,p.ends_on) for share;
  if p.rule_type='referral' then
    perform 1 from public.member_payments mp where mp.id in (select payment_id from private.valid_loyalty_referrals(g,p.id) f where f.referrer_id=member or f.referred_id=member) for share;
  end if;
  if private.loyalty_progress(p,member)<p.target then raise exception 'REWARD_TARGET_NOT_MET'; end if;
  return r;
end;
$$;

do $$ declare f record; begin
 for f in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('private','public') and p.proname in (
 'loyalty_member','loyalty_notify','valid_loyalty_referrals','loyalty_progress','attach_loyalty_referral_backend','ensure_loyalty_code_backend',
 'issue_loyalty_reward','issue_referral_pair','snapshot_reward_cost') loop
 execute format('revoke all on function %I.%I(%s) from public,anon,authenticated',f.nspname,f.proname,f.args);
 if f.nspname='public' then execute format('grant execute on function %I.%I(%s) to service_role',f.nspname,f.proname,f.args); end if;
 end loop;
end; $$;

commit;
