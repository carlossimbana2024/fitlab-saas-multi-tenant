begin;
set local lock_timeout = '5s';

create table public.membership_payment_settings (
  gym_id uuid not null references public.gyms(id),
  location_id uuid primary key references public.gym_locations(id),
  enabled boolean not null default false,
  instructions text not null default '' check (char_length(instructions) <= 2000),
  methods text[] not null default array['bank_transfer']::text[]
    check (cardinality(methods) between 1 and 3 and methods <@ array['bank_transfer','deposit','other']::text[]),
  updated_at timestamptz not null default now()
);

create table public.membership_payment_requests (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id),
  location_id uuid not null references public.gym_locations(id),
  member_user_id uuid not null references public.gym_users(id),
  membership_id uuid references public.memberships(id),
  plan_id uuid not null references public.plans(id),
  plan_snapshot jsonb not null,
  amount numeric(12,2) not null check (amount > 0),
  currency text not null,
  expires_at timestamptz not null default now() + interval '7 days',
  status text not null default 'draft' check (status in ('draft','pending','revision_requested','approved','rejected','cancelled')),
  channel text check (channel in ('fitlab','whatsapp')),
  method text check (method in ('bank_transfer','deposit','other')),
  paid_on date,
  reported_amount numeric(12,2),
  reference text check (char_length(reference) <= 200),
  comment text check (char_length(comment) <= 1000),
  proof_path text,
  proof_hash text check (proof_hash ~ '^[a-f0-9]{64}$'),
  review_reason text check (char_length(review_reason) <= 500),
  reviewed_by uuid references public.gym_users(id),
  reviewed_at timestamptz,
  payment_id uuid unique references public.member_payments(id),
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  check (status <> 'approved' or (payment_id is not null and reviewed_by is not null)),
  check (status not in ('pending','approved') or
    (reported_amount = amount and paid_on is not null and method is not null and
      (channel = 'whatsapp' or (channel = 'fitlab' and proof_hash is not null and proof_path is not null))))
);
create unique index membership_payment_requests_one_open on public.membership_payment_requests(gym_id,member_user_id)
  where status in ('draft','pending','revision_requested');
create unique index membership_payment_requests_unique_proof on public.membership_payment_requests(gym_id,proof_hash)
  where status in ('pending','approved') and proof_hash is not null;
create index membership_payment_requests_queue on public.membership_payment_requests(gym_id,status,created_at desc);

alter table public.membership_payment_settings enable row level security;
alter table public.membership_payment_requests enable row level security;
revoke all on public.membership_payment_settings,public.membership_payment_requests from anon,authenticated;
grant all on public.membership_payment_settings,public.membership_payment_requests to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('membership-payment-proofs','membership-payment-proofs',false,5242880,array['image/jpeg','image/png','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create function public.save_membership_payment_settings_backend(g uuid,actor uuid,l uuid,input jsonb)
returns public.membership_payment_settings language plpgsql security definer set search_path=pg_catalog,public as $$
declare result public.membership_payment_settings;
begin
  if not exists(select 1 from public.gym_users where gym_id=g and id=actor and role='owner' and status='active' and account_mode='portal') then
    raise exception 'PAYMENT_REQUEST_OWNER_REQUIRED' using errcode='42501';
  end if;
  if not exists(select 1 from public.gym_locations where gym_id=g and id=l and is_active) then raise exception 'PAYMENT_REQUEST_LOCATION_INVALID'; end if;
  if coalesce((input->>'enabled')::boolean,false) and char_length(trim(input->>'instructions'))<3 then raise exception 'PAYMENT_REQUEST_SETTINGS_REQUIRED'; end if;
  insert into public.membership_payment_settings(gym_id,location_id,enabled,instructions,methods)
  values(g,l,(input->>'enabled')::boolean,trim(input->>'instructions'),array(select jsonb_array_elements_text(input->'methods')))
  on conflict(location_id) do update set enabled=excluded.enabled,instructions=excluded.instructions,methods=excluded.methods,updated_at=now()
  where membership_payment_settings.gym_id=g returning * into result;
  insert into public.audit_logs(gym_id,actor_gym_user_id,action,entity_type,entity_id,after_data)
    values(g,actor,'membership_payment.settings_updated','gym_location',l,to_jsonb(result));
  return result;
end; $$;

create function public.prepare_membership_payment_request_backend(g uuid,actor uuid,p uuid)
returns public.membership_payment_requests language plpgsql security definer set search_path=pg_catalog,public as $$
declare m public.gym_users; membership public.memberships; plan public.plans; result public.membership_payment_requests; previous public.membership_payment_requests;
begin
  select * into m from public.gym_users where gym_id=g and id=actor and role='member' and status='active' and account_mode='portal' for update;
  if m.id is null then raise exception 'PAYMENT_REQUEST_MEMBER_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.membership_payment_settings s join public.gym_locations l on l.id=s.location_id and l.gym_id=s.gym_id
    where s.gym_id=g and s.location_id=m.default_location_id and s.enabled and l.is_active) then raise exception 'PAYMENT_REQUEST_SETTINGS_REQUIRED'; end if;
  select * into previous from public.membership_payment_requests where gym_id=g and member_user_id=actor and status in ('draft','pending','revision_requested') for update;
  if previous.status='pending' then raise exception 'PAYMENT_REQUEST_PENDING'; end if;
  select * into membership from public.memberships where gym_id=g and member_user_id=actor and status<>'cancelled'
    order by (status='active') desc,created_at desc limit 1;
  if membership.id is not null and membership.plan_id<>p then raise exception 'PAYMENT_REQUEST_CURRENT_PLAN_ONLY'; end if;
  select * into plan from public.plans where gym_id=g and id=p and is_active and price>0;
  if plan.id is null then raise exception 'PAYMENT_REQUEST_PLAN_UNAVAILABLE'; end if;
  if plan.currency is distinct from (select currency from public.gyms where id=g) then raise exception 'CURRENCY_MUST_MATCH_BUSINESS_CONTEXT'; end if;
  if previous.id is not null then
    update public.membership_payment_requests set location_id=m.default_location_id,membership_id=membership.id,plan_id=p,plan_snapshot=to_jsonb(plan),
      amount=plan.price,currency=plan.currency,expires_at=now()+interval '7 days',status='draft',
      proof_path=g::text||'/'||actor::text||'/'||previous.id::text||'/'||gen_random_uuid()::text,proof_hash=null
      where id=previous.id returning * into result;
  else
    insert into public.membership_payment_requests(gym_id,location_id,member_user_id,membership_id,plan_id,plan_snapshot,amount,currency)
      values(g,m.default_location_id,actor,membership.id,p,to_jsonb(plan),plan.price,plan.currency) returning * into result;
    update public.membership_payment_requests set proof_path=g::text||'/'||actor::text||'/'||result.id::text||'/'||gen_random_uuid()::text
      where id=result.id returning * into result;
  end if;
  return result;
end; $$;

create function public.submit_membership_payment_request_backend(g uuid,actor uuid,r uuid,input jsonb,hash text,expected_path text)
returns public.membership_payment_requests language plpgsql security definer set search_path=pg_catalog,public as $$
declare result public.membership_payment_requests; today date;
begin
  if not exists(select 1 from public.gym_users where gym_id=g and id=actor and role='member' and status='active' and account_mode='portal') then
    raise exception 'PAYMENT_REQUEST_MEMBER_REQUIRED' using errcode='42501'; end if;
  select * into result from public.membership_payment_requests where gym_id=g and member_user_id=actor and id=r for update;
  if result.id is null or result.status<>'draft' then raise exception 'PAYMENT_REQUEST_INVALID_STATE'; end if;
  if result.expires_at<now() then raise exception 'PAYMENT_REQUEST_QUOTE_EXPIRED'; end if;
  if result.proof_path is distinct from expected_path then raise exception 'PAYMENT_REQUEST_INVALID_STATE'; end if;
  if not exists(select 1 from public.membership_payment_settings where gym_id=g and location_id=result.location_id and enabled and input->>'method'=any(methods)) then raise exception 'PAYMENT_REQUEST_METHOD_UNAVAILABLE'; end if;
  select (now() at time zone timezone)::date into today from public.gyms where id=g;
  if (input->>'paidOn')::date>today or (input->>'amount')::numeric<>result.amount then raise exception 'PAYMENT_REQUEST_AMOUNT_OR_DATE_INVALID'; end if;
  if input->>'channel' not in ('fitlab','whatsapp') or (input->>'channel'='fitlab' and hash is null) then raise exception 'PAYMENT_REQUEST_PROOF_REQUIRED'; end if;
  if input->>'channel'='whatsapp' and not exists(select 1 from public.gym_locations l join public.gyms gym on gym.id=l.gym_id
    where l.gym_id=g and l.id=result.location_id and nullif(trim(coalesce(nullif(trim(l.whatsapp_phone),''),gym.whatsapp_phone)), '') is not null) then raise exception 'PAYMENT_REQUEST_WHATSAPP_UNAVAILABLE'; end if;
  update public.membership_payment_requests set status='pending',channel=input->>'channel',method=input->>'method',paid_on=(input->>'paidOn')::date,
    reported_amount=(input->>'amount')::numeric,reference=nullif(trim(input->>'reference'),''),comment=nullif(trim(input->>'comment'),''),
    proof_hash=case when input->>'channel'='fitlab' then hash else null end,
    proof_path=case when input->>'channel'='fitlab' then proof_path else null end,review_reason=null,submitted_at=now()
    where id=r returning * into result;
  insert into public.audit_logs(gym_id,actor_gym_user_id,action,entity_type,entity_id,after_data)
    values(g,actor,'membership_payment.submitted','membership_payment_request',r,jsonb_build_object('channel',result.channel,'amount',result.amount));
  return result;
end; $$;

-- The extended checkout below preserves every existing signature. A request can
-- use its frozen quote only while pending and through the service-role boundary.
create or replace function public.register_manual_membership_checkout(
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
  supplied_reward_id uuid,
  supplied_request_id uuid
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
  quote public.membership_payment_requests;
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

  -- Serialize first activation and concurrent manual renewals for this member.
  perform 1 from public.gym_users where id=target_member_user_id and gym_id=target_gym_id for update;

  select plan.id, plan.price, plan.currency, plan.duration_unit,
         plan.duration_value, plan.attendance_mode, plan.weekly_target
    into plan_record
  from public.plans plan
  where plan.id = target_plan_id
    and plan.gym_id = target_gym_id
    and plan.is_active for share;
  if plan_record.id is null then
    raise exception 'CHECKOUT_REQUIRES_ACTIVE_PLAN_IN_SAME_GYM' using errcode = '23514';
  end if;
  if plan_record.currency is distinct from gym_record.currency then
    raise exception 'CURRENCY_MUST_MATCH_BUSINESS_CONTEXT' using errcode = '23514';
  end if;
  if plan_record.price <= 0 then
    raise exception 'MANUAL_CHECKOUT_REQUIRES_POSITIVE_PRICE' using errcode = '23514';
  end if;
  if supplied_request_id is not null then
    select * into quote from public.membership_payment_requests
      where id=supplied_request_id and gym_id=target_gym_id for update;
    if quote.id is null or quote.status<>'pending' or quote.submitted_at is null or quote.submitted_at>quote.expires_at
      or quote.member_user_id is distinct from target_member_user_id
      or quote.location_id is distinct from target_location_id
      or quote.plan_id is distinct from target_plan_id
      or quote.membership_id is distinct from target_membership_id
      or supplied_reward_id is not null then raise exception 'PAYMENT_REQUEST_INVALID_STATE'; end if;
    plan_record.price:=quote.amount;
    plan_record.currency:=quote.currency;
    plan_record.duration_unit:=(quote.plan_snapshot->>'duration_unit')::public.duration_unit;
    plan_record.duration_value:=(quote.plan_snapshot->>'duration_value')::integer;
    plan_record.attendance_mode:=(quote.plan_snapshot->>'attendance_mode')::public.attendance_mode;
    plan_record.weekly_target:=(quote.plan_snapshot->>'weekly_target')::smallint;
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


revoke all on function public.register_manual_membership_checkout(uuid,uuid,uuid,uuid,uuid,public.member_payment_method,text,text,uuid,boolean,uuid,uuid) from public,anon,authenticated;
grant execute on function public.register_manual_membership_checkout(uuid,uuid,uuid,uuid,uuid,public.member_payment_method,text,text,uuid,boolean,uuid,uuid) to service_role;

create or replace function public.register_manual_membership_checkout(
 target_gym_id uuid,target_location_id uuid,target_member_user_id uuid,target_plan_id uuid,
 target_registered_by uuid,selected_payment_method public.member_payment_method,
 supplied_external_reference text,supplied_notes text,target_membership_id uuid,
 supplied_used_pin_elevation boolean,supplied_reward_id uuid
) returns table(membership_id uuid,payment_id uuid,membership_period_id uuid,coverage_starts_on date,coverage_ends_on date,charged_amount numeric,charged_currency text,receipt_number bigint)
language sql security definer set search_path=pg_catalog,public as $$
 select * from public.register_manual_membership_checkout(target_gym_id,target_location_id,target_member_user_id,target_plan_id,
 target_registered_by,selected_payment_method,supplied_external_reference,supplied_notes,target_membership_id,supplied_used_pin_elevation,supplied_reward_id,null::uuid);
$$;
revoke all on function public.register_manual_membership_checkout(uuid,uuid,uuid,uuid,uuid,public.member_payment_method,text,text,uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.register_manual_membership_checkout(uuid,uuid,uuid,uuid,uuid,public.member_payment_method,text,text,uuid,boolean,uuid) to service_role;

create function public.review_membership_payment_request_backend(g uuid,actor uuid,r uuid,decision text,reason text,elevated boolean default false)
returns public.membership_payment_requests language plpgsql security definer set search_path=pg_catalog,public as $$
declare result public.membership_payment_requests; checkout record; before_row jsonb;
begin
  perform private.authorize_financial_backend_actor(g,actor,'payments.register',coalesce(elevated,false));
  -- Same lock order as checkout: member, then request, then membership.
  perform 1 from public.gym_users where gym_id=g and id=(select member_user_id from public.membership_payment_requests where gym_id=g and id=r) for update;
  select * into result from public.membership_payment_requests where gym_id=g and id=r for update;
  if result.id is null or result.status<>'pending' then raise exception 'PAYMENT_REQUEST_INVALID_STATE'; end if;
  if decision not in ('approved','rejected','revision_requested') or char_length(trim(reason)) not between 3 and 500 then raise exception 'PAYMENT_REQUEST_REVIEW_INVALID'; end if;
  before_row:=to_jsonb(result);
  if decision='approved' then
    select * into checkout from public.register_manual_membership_checkout(g,result.location_id,result.member_user_id,result.plan_id,actor,
      case when result.method='bank_transfer' then 'bank_transfer'::public.member_payment_method else 'other'::public.member_payment_method end,
      coalesce(result.reference,'SOL-'||r::text),left(concat_ws(E'\n','Solicitud '||r::text,'Método: '||result.method,'Fecha declarada: '||result.paid_on::text,result.comment),1000),
      result.membership_id,coalesce(elevated,false),null::uuid,r);
    result.payment_id:=checkout.payment_id;
  end if;
  update public.membership_payment_requests set status=decision,review_reason=trim(reason),reviewed_by=actor,reviewed_at=now(),payment_id=result.payment_id
    where id=r returning * into result;
  insert into public.audit_logs(gym_id,actor_gym_user_id,action,entity_type,entity_id,permission_key,used_pin_elevation,before_data,after_data)
    values(g,actor,'membership_payment.'||decision,'membership_payment_request',r,'payments.register',coalesce(elevated,false),before_row,to_jsonb(result));
  insert into public.loyalty_notifications(gym_id,member_user_id,event_key,kind,title,body)
    values(g,result.member_user_id,'membership_payment.'||r::text||'.'||decision||'.'||clock_timestamp()::text,'membership_payment',
      case decision when 'approved' then 'Pago aprobado' when 'rejected' then 'Pago rechazado' else 'Revisa tu comprobante' end,trim(reason));
  return result;
end; $$;

create function public.cancel_membership_payment_request_backend(g uuid,actor uuid,r uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not exists(select 1 from public.gym_users where gym_id=g and id=actor and role='member' and status='active') then raise exception 'PAYMENT_REQUEST_MEMBER_REQUIRED' using errcode='42501'; end if;
  update public.membership_payment_requests set status='cancelled' where gym_id=g and member_user_id=actor and id=r and status in ('draft','pending','revision_requested');
  if not found then raise exception 'PAYMENT_REQUEST_INVALID_STATE'; end if;
  insert into public.audit_logs(gym_id,actor_gym_user_id,action,entity_type,entity_id) values(g,actor,'membership_payment.cancelled','membership_payment_request',r);
end; $$;

revoke all on function public.save_membership_payment_settings_backend(uuid,uuid,uuid,jsonb),
  public.prepare_membership_payment_request_backend(uuid,uuid,uuid),public.submit_membership_payment_request_backend(uuid,uuid,uuid,jsonb,text,text),
  public.review_membership_payment_request_backend(uuid,uuid,uuid,text,text,boolean),public.cancel_membership_payment_request_backend(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.save_membership_payment_settings_backend(uuid,uuid,uuid,jsonb),
  public.prepare_membership_payment_request_backend(uuid,uuid,uuid),public.submit_membership_payment_request_backend(uuid,uuid,uuid,jsonb,text,text),
  public.review_membership_payment_request_backend(uuid,uuid,uuid,text,text,boolean),public.cancel_membership_payment_request_backend(uuid,uuid,uuid)
  to service_role;
commit;
