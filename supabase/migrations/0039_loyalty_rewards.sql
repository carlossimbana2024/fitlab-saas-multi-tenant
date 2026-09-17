begin;
set local lock_timeout = '5s';

-- Campaign terms are frozen on publication. Each campaign is a single period.
create table public.gym_promotions (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id),
  location_id uuid not null references public.gym_locations(id),
  name text not null check (char_length(trim(name)) between 3 and 100),
  description text not null default '' check (char_length(description) <= 500),
  status text not null default 'draft' check (status in ('draft','active','paused','closed')),
  starts_on date not null,
  ends_on date not null,
  redeem_until date not null,
  rule_type text not null check (rule_type in ('attendance_count','required_streak','perfect_attendance')),
  target integer not null check (target between 1 and 366),
  reward_type text not null check (reward_type in ('discount','free_period','product')),
  reward_value integer not null,
  product_id uuid references public.products(id),
  product_name text,
  max_rewards integer not null check (max_rewards between 1 and 10000),
  required_dates date[] not null default '{}',
  created_by uuid not null references public.gym_users(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (id,gym_id),
  check (ends_on >= starts_on and ends_on - starts_on <= 365 and redeem_until >= ends_on and redeem_until <= ends_on + 180),
  check ((reward_type = 'discount' and reward_value between 1 and 99 and product_id is null)
    or (reward_type = 'free_period' and reward_value between 1 and 3 and product_id is null)
    or (reward_type = 'product' and reward_value between 1 and 10 and product_id is not null))
);
create table public.member_rewards (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id),
  promotion_id uuid not null,
  member_user_id uuid not null references public.gym_users(id),
  status text not null default 'available' check (status in ('available','redeemed','revoked')),
  earned_at timestamptz not null default now(),
  expires_on date not null,
  terms jsonb not null,
  revoked_reason text,
  unique (promotion_id,member_user_id),
  unique (id,gym_id),
  foreign key (promotion_id,gym_id) references public.gym_promotions(id,gym_id)
);
create table public.reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id),
  reward_id uuid not null unique,
  actor_id uuid not null references public.gym_users(id),
  membership_period_id uuid references public.membership_periods(id),
  inventory_movement_id uuid references public.inventory_movements(id),
  original_amount numeric(12,2),
  discount_amount numeric(12,2),
  final_amount numeric(12,2),
  currency text,
  created_at timestamptz not null default now(),
  foreign key (reward_id,gym_id) references public.member_rewards(id,gym_id),
  check (num_nonnulls(membership_period_id,inventory_movement_id) = 1),
  check (original_amount >= 0 and discount_amount >= 0 and final_amount >= 0 and original_amount = discount_amount + final_amount)
);
create index gym_promotions_gym_idx on public.gym_promotions(gym_id,created_at desc);
create index member_rewards_member_idx on public.member_rewards(gym_id,member_user_id,earned_at desc);
alter table public.gym_promotions enable row level security;
alter table public.member_rewards enable row level security;
alter table public.reward_redemptions enable row level security;
revoke all on public.gym_promotions, public.member_rewards, public.reward_redemptions from anon, authenticated;
grant all on public.gym_promotions, public.member_rewards, public.reward_redemptions to service_role;

create trigger promotions_location_tenant before insert or update on public.gym_promotions
for each row execute function private.enforce_tenant_reference('location_id','gym_locations');
create trigger promotions_product_tenant before insert or update on public.gym_promotions
for each row execute function private.enforce_tenant_reference('product_id','products');
create trigger promotions_creator_tenant before insert or update on public.gym_promotions
for each row execute function private.enforce_tenant_reference('created_by','gym_users');
create trigger rewards_member_tenant before insert or update on public.member_rewards
for each row execute function private.enforce_tenant_reference('member_user_id','gym_users');
create trigger redemption_actor_tenant before insert or update on public.reward_redemptions
for each row execute function private.enforce_tenant_reference('actor_id','gym_users');
create trigger redemption_period_tenant before insert or update on public.reward_redemptions
for each row execute function private.enforce_tenant_reference('membership_period_id','membership_periods');
create trigger redemption_inventory_tenant before insert or update on public.reward_redemptions
for each row execute function private.enforce_tenant_reference('inventory_movement_id','inventory_movements');

create function private.loyalty_owner(g uuid, actor uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare profile uuid;
begin
  select gu.profile_id into profile from public.gym_users gu where gu.id=actor and gu.gym_id=g
    and gu.role='owner' and gu.status='active' and gu.account_mode='portal';
  if profile is null then raise exception 'LOYALTY_OWNER_REQUIRED' using errcode='42501'; end if;
  return profile;
end;
$$;

create function public.save_promotion_backend(g uuid, actor uuid, promotion uuid, input jsonb)
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
    insert into public.gym_promotions(gym_id,location_id,name,description,starts_on,ends_on,redeem_until,rule_type,target,reward_type,reward_value,product_id,max_rewards,created_by)
    values(g,(input->>'locationId')::uuid,trim(input->>'name'),coalesce(input->>'description',''),(input->>'startsOn')::date,(input->>'endsOn')::date,
      (input->>'redeemUntil')::date,input->>'ruleType',(input->>'target')::integer,input->>'rewardType',(input->>'rewardValue')::integer,
      (input->>'productId')::uuid,(input->>'maxRewards')::integer,actor) returning * into result;
  else
    update public.gym_promotions set location_id=(input->>'locationId')::uuid,name=trim(input->>'name'),description=coalesce(input->>'description',''),
      starts_on=(input->>'startsOn')::date,ends_on=(input->>'endsOn')::date,redeem_until=(input->>'redeemUntil')::date,
      rule_type=input->>'ruleType',target=(input->>'target')::integer,reward_type=input->>'rewardType',reward_value=(input->>'rewardValue')::integer,
      product_id=(input->>'productId')::uuid,max_rewards=(input->>'maxRewards')::integer where id=promotion and gym_id=g returning * into result;
  end if;
  insert into public.audit_logs(gym_id,actor_profile_id,actor_gym_user_id,action,entity_type,entity_id,before_data,after_data)
    values(g,profile,actor,'promotion.saved','promotion',result.id,to_jsonb(previous),to_jsonb(result));
  return result;
end;
$$;

create function public.set_promotion_status_backend(g uuid, actor uuid, promotion uuid, new_status text)
returns public.gym_promotions language plpgsql security definer set search_path = pg_catalog, public as $$
declare p public.gym_promotions; previous public.gym_promotions; profile uuid; today date; dates date[];
begin
  profile := private.loyalty_owner(g,actor);
  select * into p from public.gym_promotions where id=promotion and gym_id=g for update;
  if not found then raise exception 'PROMOTION_NOT_FOUND'; end if;
  previous:=p;
  if new_status is null or not ((p.status='draft' and new_status in ('active','closed')) or
    (p.status='active' and new_status in ('paused','closed')) or (p.status='paused' and new_status in ('active','closed'))) then
    raise exception 'PROMOTION_INVALID_TRANSITION'; end if;
  select (now() at time zone timezone)::date into today from public.gyms where id=g;
  if new_status='active' and p.redeem_until < today then raise exception 'REWARD_EXPIRED'; end if;
  if p.status='draft' and new_status='active' then
    if p.starts_on < today then raise exception 'PROMOTION_START_IN_PAST'; end if;
    select coalesce(array_agg(d::date order by d),'{}') into dates
    from generate_series(p.starts_on::timestamp,p.ends_on::timestamp,interval '1 day') d
    left join public.location_calendar_exceptions e on e.location_id=p.location_id and e.calendar_date=d::date
    left join public.location_opening_hours h on h.location_id=p.location_id and h.weekday=extract(isodow from d)::smallint
    where coalesce(e.day_mode,h.day_mode,'closed')='required';
    if p.rule_type='perfect_attendance' then p.target:=cardinality(dates); end if;
    if p.target<1 or (p.rule_type='required_streak' and cardinality(dates)<p.target) or (p.rule_type='attendance_count' and p.target>p.ends_on-p.starts_on+1) then
      raise exception 'PROMOTION_UNREACHABLE_TARGET'; end if;
    if p.reward_type='product' then
      select name into p.product_name from public.products where id=p.product_id and gym_id=g and is_active;
      if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    end if;
    update public.gym_promotions set target=p.target,required_dates=dates,published_at=now(),product_name=p.product_name where id=p.id;
  end if;
  update public.gym_promotions set status=new_status where id=p.id returning * into p;
  insert into public.audit_logs(gym_id,actor_profile_id,actor_gym_user_id,action,entity_type,entity_id,before_data,after_data)
    values(g,profile,actor,'promotion.status_changed','promotion',p.id,to_jsonb(previous),to_jsonb(p));
  return p;
end;
$$;

-- Reconstruct progress from valid general attendance; classes never count twice.
create function private.loyalty_progress(p public.gym_promotions, member uuid) returns integer
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare dates date[]; today date; day date; run integer:=0; best integer:=0;
begin
  select (now() at time zone timezone)::date into today from public.gyms where id=p.gym_id;
  select coalesce(array_agg(distinct attendance_date),'{}') into dates from public.attendances
    where gym_id=p.gym_id and member_user_id=member and location_id=p.location_id and status='valid'
      and source <> 'extra_class' and attendance_date between p.starts_on and least(today,p.ends_on);
  if p.rule_type='attendance_count' then return cardinality(dates); end if;
  if p.rule_type='perfect_attendance' then
    return (select count(*)::integer from unnest(p.required_dates) d where d=any(dates));
  end if;
  foreach day in array p.required_dates loop
    exit when day>least(today,p.ends_on);
    if day=any(dates) then run:=run+1; best:=greatest(best,run); else run:=0; end if;
  end loop;
  return best;
end;
$$;

create function public.member_loyalty_backend(g uuid, actor uuid, member uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare today date; campaigns jsonb; rewards jsonb;
begin
  if actor is distinct from member then perform private.loyalty_owner(g,actor); end if;
  if not exists(select 1 from public.gym_users where id=member and gym_id=g and role='member' and status='active') then
    raise exception 'LOYALTY_MEMBER_REQUIRED' using errcode='42501'; end if;
  select (now() at time zone timezone)::date into today from public.gyms where id=g;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'status',p.status,
    'starts_on',p.starts_on,'ends_on',p.ends_on,'redeem_until',p.redeem_until,'rule_type',p.rule_type,'target',p.target,
    'reward_type',p.reward_type,'reward_value',p.reward_value,'product_name',p.product_name,'location_name',l.name,
    'progress',private.loyalty_progress(p,member),'max_rewards',p.max_rewards,
    'remaining',greatest(0,p.max_rewards-(select count(*) from public.member_rewards r where r.promotion_id=p.id))) order by p.ends_on),'[]') into campaigns
    from public.gym_promotions p join public.gym_locations l on l.id=p.location_id
    where p.gym_id=g and p.status in ('active','paused') and p.redeem_until>=today;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'promotion_id',r.promotion_id,'terms',r.terms - 'created_by' - 'created_at' - 'gym_id' - 'required_dates','earned_at',r.earned_at,'expires_on',r.expires_on,
    'status',case when r.status='available' and r.expires_on<today then 'expired' else r.status end,'revoked_reason',r.revoked_reason) order by r.earned_at desc),'[]') into rewards
    from public.member_rewards r where r.gym_id=g and r.member_user_id=member;
  return jsonb_build_object('today',today,'promotions',campaigns,'rewards',rewards);
end;
$$;

create function public.claim_reward_backend(g uuid, actor uuid, member uuid, promotion uuid) returns public.member_rewards
language plpgsql security definer set search_path = pg_catalog, public as $$
declare p public.gym_promotions; r public.member_rewards; today date; profile uuid;
begin
  if actor is distinct from member then perform private.loyalty_owner(g,actor); end if;
  select profile_id into profile from public.gym_users where id=actor and gym_id=g and status='active';
  if not exists(select 1 from public.gym_users where id=member and gym_id=g and role='member' and status='active') then
    raise exception 'LOYALTY_MEMBER_REQUIRED' using errcode='42501'; end if;
  -- One lock serializes the campaign quota and duplicate claims.
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
  insert into public.audit_logs(gym_id,actor_profile_id,actor_gym_user_id,action,entity_type,entity_id,after_data)
    values(g,profile,actor,'reward.earned','reward',r.id,to_jsonb(r));
  return r;
end;
$$;

create function private.lock_loyalty_reward(g uuid, actor uuid, reward uuid, member uuid)
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
  if private.loyalty_progress(p,member)<p.target then raise exception 'REWARD_TARGET_NOT_MET'; end if;
  return r;
end;
$$;

create function public.redeem_product_reward_backend(g uuid, actor uuid, reward uuid)
returns public.reward_redemptions language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.member_rewards; result public.reward_redemptions; movement public.inventory_movements; member uuid; profile uuid;
begin
  profile:=private.loyalty_owner(g,actor);
  select member_user_id into member from public.member_rewards where id=reward and gym_id=g;
  r:=private.lock_loyalty_reward(g,actor,reward,member);
  if r.terms->>'reward_type'<>'product' then raise exception 'REWARD_WRONG_TYPE'; end if;
  if not exists(select 1 from public.products where id=(r.terms->>'product_id')::uuid and gym_id=g and is_active) then raise exception 'PRODUCT_NOT_FOUND'; end if;
  select * into movement from public.adjust_inventory_backend(g,(r.terms->>'location_id')::uuid,(r.terms->>'product_id')::uuid,actor,
    'adjustment',-(r.terms->>'reward_value')::integer,'Recompensa: ' || (r.terms->>'name'),false);
  insert into public.reward_redemptions(gym_id,reward_id,actor_id,inventory_movement_id)
    values(g,r.id,actor,movement.id) returning * into result;
  update public.member_rewards set status='redeemed' where id=r.id;
  insert into public.audit_logs(gym_id,actor_profile_id,actor_gym_user_id,action,entity_type,entity_id,after_data)
    values(g,profile,actor,'reward.redeemed','reward',r.id,to_jsonb(result));
  return result;
end;
$$;

create function public.revoke_reward_backend(g uuid, actor uuid, reward uuid, reason text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare profile uuid; r public.member_rewards;
begin
  profile:=private.loyalty_owner(g,actor);
  if reason is null or char_length(trim(reason)) not between 3 and 500 then raise exception 'REWARD_REASON_REQUIRED'; end if;
  select * into r from public.member_rewards where id=reward and gym_id=g for update;
  if not found or r.status<>'available' then raise exception 'REWARD_NOT_AVAILABLE'; end if;
  update public.member_rewards set status='revoked',revoked_reason=trim(reason) where id=r.id;
  insert into public.audit_logs(gym_id,actor_profile_id,actor_gym_user_id,action,entity_type,entity_id,before_data,after_data)
    values(g,profile,actor,'reward.revoked','reward',r.id,to_jsonb(r),jsonb_build_object('reason',trim(reason)));
end;
$$;

revoke all on function private.loyalty_owner(uuid,uuid), private.loyalty_progress(public.gym_promotions,uuid), private.lock_loyalty_reward(uuid,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.save_promotion_backend(uuid,uuid,uuid,jsonb), public.set_promotion_status_backend(uuid,uuid,uuid,text),
  public.member_loyalty_backend(uuid,uuid,uuid), public.claim_reward_backend(uuid,uuid,uuid,uuid),
  public.redeem_product_reward_backend(uuid,uuid,uuid), public.revoke_reward_backend(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.save_promotion_backend(uuid,uuid,uuid,jsonb), public.set_promotion_status_backend(uuid,uuid,uuid,text),
  public.member_loyalty_backend(uuid,uuid,uuid), public.claim_reward_backend(uuid,uuid,uuid,uuid),
  public.redeem_product_reward_backend(uuid,uuid,uuid), public.revoke_reward_backend(uuid,uuid,uuid,text) to service_role;

-- Checkout extension is appended below; deployment is atomic.

create function private.protect_promotion_terms() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='DELETE' then raise exception 'PROMOTION_HISTORY_IMMUTABLE'; end if;
  if old.published_at is not null and (to_jsonb(new)-'status') is distinct from (to_jsonb(old)-'status') then
    raise exception 'PROMOTION_TERMS_LOCKED'; end if;
  return new;
end; $$;
create trigger protect_promotion_terms before update or delete on public.gym_promotions for each row execute function private.protect_promotion_terms();
create function private.protect_reward_history() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='DELETE' then raise exception 'REWARD_HISTORY_IMMUTABLE'; end if;
  if (to_jsonb(new)-'status'-'revoked_reason') is distinct from (to_jsonb(old)-'status'-'revoked_reason')
    or old.status<>'available' or new.status not in ('redeemed','revoked') then raise exception 'REWARD_HISTORY_IMMUTABLE'; end if;
  if new.status='redeemed' and not exists(select 1 from public.reward_redemptions where reward_id=new.id and gym_id=new.gym_id) then raise exception 'REWARD_REDEMPTION_REQUIRED'; end if;
  if new.status='revoked' and char_length(trim(coalesce(new.revoked_reason,'')))<3 then raise exception 'REWARD_REASON_REQUIRED'; end if;
  return new;
end; $$;
create trigger protect_reward_history before update or delete on public.member_rewards for each row execute function private.protect_reward_history();
revoke all on function private.protect_promotion_terms(),private.protect_reward_history() from public,anon,authenticated;

alter table public.membership_periods add column original_amount numeric(12,2), add column discount_amount numeric(12,2) not null default 0,
 add column reward_id uuid unique references public.member_rewards(id);
update public.membership_periods set original_amount=charged_amount;
alter table public.membership_periods alter column original_amount set not null;
alter table public.membership_periods add constraint period_reward_amounts check(original_amount >= 0 and discount_amount >= 0 and original_amount=charged_amount+discount_amount);
-- Legacy inserts can omit the new original amount.
create function private.period_original_amount() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.original_amount is null then new.original_amount:=new.charged_amount; end if;
 return new;
end; $$;
revoke all on function private.period_original_amount() from public,anon,authenticated;
create trigger period_original_amount before insert on public.membership_periods for each row execute function private.period_original_amount();
create trigger period_reward_tenant before insert or update on public.membership_periods for each row execute function private.enforce_tenant_reference('reward_id','member_rewards');
create function public.register_manual_membership_checkout(
  target_gym_id uuid,
  target_location_id uuid,
  target_member_user_id uuid,
  target_plan_id uuid,
  target_registered_by uuid,
  selected_payment_method public.member_payment_method,
  supplied_external_reference text,
  supplied_notes text,
  target_membership_id uuid,
  supplied_used_pin_elevation boolean,
  supplied_reward_id uuid
)
returns table(
  membership_id uuid,
  payment_id uuid,
  membership_period_id uuid,
  coverage_starts_on date,
  coverage_ends_on date,
  charged_amount numeric,
  charged_currency text,
  receipt_number bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  gym_record record;
  plan_record record;
  membership_record record;
  actor_profile_id uuid;
  gym_today date;
  last_coverage_end date;
  new_membership_id uuid;
  new_payment_id uuid;
  new_period_id uuid;
  new_receipt_number bigint;
  new_starts_on date;
  new_ends_on date;
  reward public.member_rewards;
  final_price numeric;
  discount numeric := 0;
  redemption public.reward_redemptions;
begin
  actor_profile_id := private.authorize_financial_backend_actor(
    target_gym_id, target_registered_by, 'payments.register',
    coalesce(supplied_used_pin_elevation, false)
  );

  select gym.id, gym.timezone, gym.currency::text as currency
    into gym_record
  from public.gyms gym
  where gym.id = target_gym_id;
  if gym_record.id is null then
    raise exception 'GYM_NOT_FOUND' using errcode = '23503';
  end if;
  gym_today := (now() at time zone gym_record.timezone)::date;

  if not exists (
    select 1 from public.gym_locations location
    where location.id = target_location_id
      and location.gym_id = target_gym_id
      and location.is_active
  ) then
    raise exception 'CHECKOUT_REQUIRES_ACTIVE_LOCATION_IN_SAME_GYM' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.gym_users member
    where member.id = target_member_user_id
      and member.gym_id = target_gym_id
      and member.role = 'member'
      and member.status = 'active'
  ) then
    raise exception 'CHECKOUT_REQUIRES_ACTIVE_MEMBER_IN_SAME_GYM' using errcode = '23514';
  end if;

  select plan.id, plan.price, plan.currency, plan.duration_unit,
         plan.duration_value, plan.attendance_mode, plan.weekly_target
    into plan_record
  from public.plans plan
  where plan.id = target_plan_id
    and plan.gym_id = target_gym_id
    and plan.is_active;
  if plan_record.id is null then
    raise exception 'CHECKOUT_REQUIRES_ACTIVE_PLAN_IN_SAME_GYM' using errcode = '23514';
  end if;
  if plan_record.currency is distinct from gym_record.currency then
    raise exception 'CURRENCY_MUST_MATCH_BUSINESS_CONTEXT' using errcode = '23514';
  end if;
  if plan_record.price <= 0 then
    raise exception 'MANUAL_CHECKOUT_REQUIRES_POSITIVE_PRICE' using errcode = '23514';
  end if;
  final_price := plan_record.price;
  if supplied_reward_id is not null then
    reward := private.lock_loyalty_reward(target_gym_id,target_registered_by,supplied_reward_id,target_member_user_id);
    if target_membership_id is null then raise exception 'REWARD_RENEWAL_REQUIRED'; end if;
    if target_location_id is distinct from (reward.terms->>'location_id')::uuid then raise exception 'ATTENDANCE_LOCATION_MISMATCH'; end if;
    if reward.terms->>'reward_type'='discount' then
      discount := round(plan_record.price * (reward.terms->>'reward_value')::numeric / 100,2);
      final_price := plan_record.price-discount;
      if final_price<=0 then raise exception 'REWARD_DISCOUNT_TOO_SMALL_PRICE'; end if;
    elsif reward.terms->>'reward_type'='free_period' then
      discount:=plan_record.price;
      final_price:=0;
    else raise exception 'REWARD_WRONG_TYPE';
    end if;
  end if;
  if final_price>0 and selected_payment_method in ('bank_transfer', 'external_card', 'external_deuna')
     and nullif(trim(supplied_external_reference), '') is null then
    raise exception 'EXTERNAL_REFERENCE_REQUIRED_FOR_PAYMENT_METHOD' using errcode = '23514';
  end if;

  if target_membership_id is null then
    if exists (
      select 1 from public.memberships active_membership
      where active_membership.member_user_id = target_member_user_id
        and active_membership.status = 'active'
    ) then
      raise exception 'ACTIVE_MEMBERSHIP_REQUIRES_RENEWAL' using errcode = '23514';
    end if;

    insert into public.memberships(
      gym_id, member_user_id, plan_id, status, price_at_purchase, currency,
      attendance_mode_snapshot, weekly_target_snapshot, created_by
    ) values (
      target_gym_id, target_member_user_id, target_plan_id, 'pending',
      plan_record.price, plan_record.currency, plan_record.attendance_mode,
      plan_record.weekly_target, target_registered_by
    ) returning id into new_membership_id;
  else
    select membership.id, membership.gym_id, membership.member_user_id,
           membership.plan_id, membership.status
      into membership_record
    from public.memberships membership
    where membership.id = target_membership_id
    for update;

    if membership_record.id is null
       or membership_record.gym_id is distinct from target_gym_id
       or membership_record.member_user_id is distinct from target_member_user_id
       or membership_record.plan_id is distinct from target_plan_id
       or membership_record.status = 'cancelled' then
      raise exception 'INVALID_MEMBERSHIP_FOR_RENEWAL' using errcode = '23514';
    end if;
    new_membership_id := membership_record.id;
  end if;

  select max(period.ends_on) into last_coverage_end
  from public.membership_periods period
  where period.membership_id = new_membership_id
    and period.status <> 'cancelled';

  new_starts_on := greatest(gym_today, coalesce(last_coverage_end + 1, gym_today));
  new_ends_on := case plan_record.duration_unit
    when 'days' then new_starts_on + plan_record.duration_value - 1
    when 'weeks' then new_starts_on + (plan_record.duration_value * 7) - 1
    when 'months' then (new_starts_on + make_interval(months => plan_record.duration_value))::date - 1
  end;

  if reward.terms->>'reward_type'='free_period' then
    new_ends_on := (new_starts_on + make_interval(months => (reward.terms->>'reward_value')::integer))::date - 1;
    -- Free months have no fictitious price or payment.
    discount:=0;
  end if;

  if final_price>0 then
  insert into public.member_payments(
    gym_id, location_id, member_user_id, membership_id, amount, currency,
    payment_method, status, external_reference, notes, registered_by, paid_at
  ) values (
    target_gym_id, target_location_id, target_member_user_id,
    new_membership_id, final_price, plan_record.currency,
    selected_payment_method, 'confirmed',
    nullif(trim(supplied_external_reference), ''),
    nullif(trim(supplied_notes), ''), target_registered_by, now()
  ) returning id, member_payments.receipt_number
    into new_payment_id, new_receipt_number;
  end if;

  insert into public.membership_periods(
    gym_id, membership_id, starts_on, ends_on, status, payment_id,
    charged_amount, currency, original_amount, discount_amount, reward_id
  ) values (
    target_gym_id, new_membership_id, new_starts_on, new_ends_on,
    'active', new_payment_id, final_price, plan_record.currency, final_price+discount, discount, supplied_reward_id
  ) returning id into new_period_id;

  if reward.id is not null then
    insert into public.reward_redemptions(gym_id,reward_id,actor_id,membership_period_id,original_amount,discount_amount,final_amount,currency)
    values(target_gym_id,reward.id,target_registered_by,new_period_id,final_price+discount,discount,final_price,plan_record.currency)
    returning * into redemption;
    update public.member_rewards set status='redeemed' where id=reward.id;
    insert into public.audit_logs(gym_id,actor_profile_id,actor_gym_user_id,action,entity_type,entity_id,after_data)
    values(target_gym_id,actor_profile_id,target_registered_by,'reward.redeemed','reward',reward.id,to_jsonb(redemption));
  end if;
  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, after_data
  ) values (
    target_gym_id, actor_profile_id, target_registered_by,
    case when target_membership_id is null
      then 'membership.created_with_payment'
      else 'membership.renewed'
    end,
    case when new_payment_id is null then 'membership_period' else 'member_payment' end, coalesce(new_payment_id,new_period_id), 'payments.register',
    coalesce(supplied_used_pin_elevation, false),
    jsonb_build_object(
      'membership_id', new_membership_id,
      'period_id', new_period_id,
      'starts_on', new_starts_on,
      'ends_on', new_ends_on,
      'amount', final_price,
      'reward_id', supplied_reward_id,
      'discount', discount,
      'currency', plan_record.currency,
      'receipt_number', new_receipt_number
    )
  );

  return query select new_membership_id, new_payment_id, new_period_id,
    new_starts_on, new_ends_on, final_price::numeric,
    plan_record.currency::text, new_receipt_number;
end;
$$;


revoke all on function public.register_manual_membership_checkout(uuid,uuid,uuid,uuid,uuid,public.member_payment_method,text,text,uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.register_manual_membership_checkout(uuid,uuid,uuid,uuid,uuid,public.member_payment_method,text,text,uuid,boolean,uuid) to service_role;

-- Retain the existing signature for older backend deployments, using the same core.
create or replace function public.register_manual_membership_checkout(
 target_gym_id uuid,target_location_id uuid,target_member_user_id uuid,target_plan_id uuid,
 target_registered_by uuid,selected_payment_method public.member_payment_method,
 supplied_external_reference text default null,supplied_notes text default null,
 target_membership_id uuid default null,supplied_used_pin_elevation boolean default false
) returns table(membership_id uuid,payment_id uuid,membership_period_id uuid,coverage_starts_on date,coverage_ends_on date,charged_amount numeric,charged_currency text,receipt_number bigint)
language sql security definer set search_path=pg_catalog,public as $$
 select * from public.register_manual_membership_checkout(target_gym_id,target_location_id,target_member_user_id,target_plan_id,
 target_registered_by,selected_payment_method,supplied_external_reference,supplied_notes,target_membership_id,supplied_used_pin_elevation,null::uuid);
$$;
revoke all on function public.register_manual_membership_checkout(uuid,uuid,uuid,uuid,uuid,public.member_payment_method,text,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.register_manual_membership_checkout(uuid,uuid,uuid,uuid,uuid,public.member_payment_method,text,text,uuid,boolean) to service_role;
commit;
