begin;
set local lock_timeout = '5s';

alter table public.gym_subscriptions drop constraint gym_subscriptions_provider_check;
alter table public.gym_subscriptions add constraint gym_subscriptions_provider_check check (provider in ('stripe','deuna','manual'));
alter table public.saas_payment_transactions drop constraint saas_payment_transactions_provider_check;
alter table public.saas_payment_transactions add constraint saas_payment_transactions_provider_check check (provider in ('stripe','deuna','manual'));

create table public.saas_payment_requests (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id),
  subscription_id uuid not null references public.gym_subscriptions(id),
  submitted_by uuid not null references public.profiles(id),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null,
  status text not null default 'draft' check (status in ('draft','pending','approved','rejected')),
  proof_path text not null unique,
  proof_hash text,
  bank_reference text,
  payer_name text,
  paid_on date,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default now()
);
create unique index saas_request_open_idx on public.saas_payment_requests(subscription_id) where status in ('draft','pending');
create unique index saas_request_proof_idx on public.saas_payment_requests(proof_hash) where proof_hash is not null;
create unique index saas_request_reference_idx on public.saas_payment_requests(bank_reference) where bank_reference is not null;
create index saas_request_review_idx on public.saas_payment_requests(status,created_at desc);
alter table public.saas_payment_requests enable row level security;
revoke all on public.saas_payment_requests from anon, authenticated;
grant all on public.saas_payment_requests to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('saas-payment-proofs','saas-payment-proofs',false,5242880,array['image/jpeg','image/png','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('saas-billing-assets','saas-billing-assets',false,1048576,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- No authenticated storage policies: all access is authorized by the backend.

create function public.platform_billing_access() returns jsonb
language sql security definer set search_path=pg_catalog,public,private as $$
  select jsonb_build_object('authorized',exists(select 1 from private.platform_admins where profile_id=auth.uid() and status='active'),
    'verified',coalesce(auth.jwt()->>'aal'='aal2',false));
$$;
revoke all on function public.platform_billing_access() from public,anon;
grant execute on function public.platform_billing_access() to authenticated;

create function public.prepare_saas_payment_request(target_gym uuid, actor uuid) returns public.saas_payment_requests
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare sub public.gym_subscriptions; req public.saas_payment_requests; new_id uuid := gen_random_uuid();
begin
  if not exists(select 1 from public.gym_users where gym_id=target_gym and profile_id=actor and role='owner' and status='active') then raise exception 'OWNER_REQUIRED'; end if;
  select * into sub from public.gym_subscriptions where gym_id=target_gym order by created_at desc limit 1 for update;
  if sub.id is null or sub.price_snapshot<=0 then raise exception 'SUBSCRIPTION_NOT_FOUND'; end if;
  if sub.provider_subscription_id is not null then raise exception 'STRIPE_SUBSCRIPTION_ALREADY_LINKED'; end if;
  select * into req from public.saas_payment_requests where subscription_id=sub.id and status in ('draft','pending');
  if req.id is not null then return req; end if;
  insert into public.saas_payment_requests(id,gym_id,subscription_id,submitted_by,amount,currency,proof_path)
  values(new_id,target_gym,sub.id,actor,sub.price_snapshot,sub.currency_snapshot,target_gym::text||'/'||new_id::text||'/proof') returning * into req;
  return req;
end; $$;

create function public.submit_saas_payment_request(target_id uuid,target_gym uuid,actor uuid, supplied_hash text, supplied_reference text, supplied_name text,supplied_date date) returns void
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare req public.saas_payment_requests;
begin
  if not exists(select 1 from public.gym_users where gym_id=target_gym and profile_id=actor and role='owner' and status='active') then raise exception 'OWNER_REQUIRED'; end if;
  select * into req from public.saas_payment_requests where id=target_id and gym_id=target_gym for update;
  if req.id is null or req.submitted_by<>actor then raise exception 'PAYMENT_REQUEST_NOT_FOUND'; end if;
  if req.status='pending' and req.proof_hash=supplied_hash then return; end if;
  if req.status<>'draft' then raise exception 'PAYMENT_REQUEST_ALREADY_SUBMITTED'; end if;
  if supplied_hash !~ '^[a-f0-9]{64}$' or length(trim(supplied_reference)) not between 4 and 120 or length(trim(supplied_name)) not between 2 and 150 or supplied_date is null or supplied_date>current_date then raise exception 'INVALID_PAYMENT_PROOF'; end if;
  update public.saas_payment_requests set status='pending',proof_hash=supplied_hash,bank_reference=upper(trim(supplied_reference)),payer_name=trim(supplied_name),paid_on=supplied_date where id=target_id;
  insert into public.audit_logs(gym_id,actor_profile_id,action,entity_type,entity_id) values(target_gym,actor,'saas.payment_submitted','saas_payment_request',target_id);
end; $$;

create function public.review_saas_payment_request(target_id uuid,decision text,reason text) returns void
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare req public.saas_payment_requests; sub public.gym_subscriptions; period_start timestamptz; actor uuid:=auth.uid();
begin
  if not exists(select 1 from private.platform_admins where profile_id=actor and status='active') or coalesce(auth.jwt()->>'aal','')<>'aal2' then raise exception 'PLATFORM_ADMIN_MFA_REQUIRED' using errcode='42501'; end if;
  if decision not in ('approved','rejected') or reason is null or length(trim(reason)) not between 3 and 500 then raise exception 'INVALID_REVIEW'; end if;
  select * into req from public.saas_payment_requests where id=target_id for update;
  if req.id is null then raise exception 'PAYMENT_REQUEST_NOT_FOUND'; end if;
  if req.status=decision then return; end if;
  if req.status<>'pending' then raise exception 'PAYMENT_ALREADY_REVIEWED'; end if;
  select * into sub from public.gym_subscriptions where id=req.subscription_id for update;
  if decision='approved' then
    if sub.provider_subscription_id is not null then raise exception 'STRIPE_SUBSCRIPTION_ALREADY_LINKED'; end if;
    if sub.price_snapshot<>req.amount or sub.currency_snapshot<>req.currency then raise exception 'PAYMENT_AMOUNT_MISMATCH'; end if;
    period_start:=greatest(now(),case when sub.status='trialing' then sub.trial_ends_at else sub.current_period_ends_at end);
    update public.gym_subscriptions set provider='manual',status='active',current_period_starts_at=period_start,
      current_period_ends_at=period_start+case sub.billing_interval_snapshot when 'year' then interval '1 year' else interval '1 month' end,
      cancel_at_period_end=false where id=sub.id;
    update public.gyms set status='active' where id=req.gym_id;
    insert into public.saas_payment_transactions(gym_id,gym_subscription_id,provider,provider_payment_id,amount,currency,status,paid_at)
    values(req.gym_id,sub.id,'manual',req.id::text,req.amount,req.currency,'confirmed',now());
  end if;
  update public.saas_payment_requests set status=decision,reviewed_by=actor,reviewed_at=now(),review_reason=trim(reason) where id=req.id;
  insert into public.audit_logs(gym_id,actor_profile_id,action,entity_type,entity_id,before_data,after_data)
  values(req.gym_id,actor,'saas.payment_'||decision,'saas_payment_request',req.id,jsonb_build_object('status',req.status),jsonb_build_object('status',decision,'reason',trim(reason)));
end; $$;

create function public.suspend_manual_saas_subscription(target_id uuid,reason text) returns void
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare sub public.gym_subscriptions; actor uuid:=auth.uid();
begin
  if not exists(select 1 from private.platform_admins where profile_id=actor and status='active') or coalesce(auth.jwt()->>'aal','')<>'aal2' then raise exception 'PLATFORM_ADMIN_MFA_REQUIRED' using errcode='42501'; end if;
  if reason is null or length(trim(reason)) not between 3 and 500 then raise exception 'INVALID_REVIEW'; end if;
  select * into sub from public.gym_subscriptions where id=target_id for update;
  if sub.id is null or sub.provider<>'manual' then raise exception 'MANUAL_SUBSCRIPTION_REQUIRED'; end if;
  update public.gym_subscriptions set status='suspended' where id=sub.id;
  update public.gyms set status='suspended' where id=sub.gym_id;
  insert into public.audit_logs(gym_id,actor_profile_id,action,entity_type,entity_id,after_data)
  values(sub.gym_id,actor,'saas.subscription_suspended','gym_subscription',sub.id,jsonb_build_object('reason',trim(reason)));
end; $$;

revoke all on function public.prepare_saas_payment_request(uuid,uuid),public.submit_saas_payment_request(uuid,uuid,uuid,text,text,text,date) from public,anon,authenticated;
grant execute on function public.prepare_saas_payment_request(uuid,uuid),public.submit_saas_payment_request(uuid,uuid,uuid,text,text,text,date) to service_role;
revoke all on function public.review_saas_payment_request(uuid,text,text),public.suspend_manual_saas_subscription(uuid,text) from public,anon;
grant execute on function public.review_saas_payment_request(uuid,text,text),public.suspend_manual_saas_subscription(uuid,text) to authenticated;
commit;
