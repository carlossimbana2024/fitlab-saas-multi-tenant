begin;

alter table public.profiles
  add column terms_accepted_at timestamptz,
  add column privacy_accepted_at timestamptz,
  add column legal_version text;

alter table public.saas_plans
  add column stripe_price_id text;

create unique index saas_plans_stripe_price_id_idx
  on public.saas_plans(stripe_price_id)
  where stripe_price_id is not null;

create or replace function public.complete_owner_onboarding(
  target_profile_id uuid,
  target_email text,
  target_full_name text,
  target_gym_name text,
  target_gym_slug text,
  target_location_name text,
  target_location_address text,
  target_city text,
  target_timezone text,
  target_plan_name text,
  target_plan_price numeric,
  target_plan_currency text,
  target_stripe_price_id text,
  target_trial_days integer,
  target_legal_version text
)
returns table(gym_id uuid, location_id uuid, gym_user_id uuid, subscription_id uuid, trial_ends_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  auth_record record;
  created_gym_id uuid;
  created_location_id uuid;
  created_gym_user_id uuid;
  selected_plan_id uuid;
  created_subscription_id uuid;
  calculated_trial_end timestamptz;
begin
  if target_trial_days < 1 or target_trial_days > 90 then
    raise exception 'INVALID_TRIAL_DURATION' using errcode = '22023';
  end if;

  select u.id, u.email, u.email_confirmed_at
    into auth_record
  from auth.users u
  where u.id = target_profile_id;

  if auth_record.id is null then
    raise exception 'AUTH_USER_NOT_FOUND' using errcode = '23503';
  end if;
  if auth_record.email_confirmed_at is null then
    raise exception 'OWNER_EMAIL_MUST_BE_VERIFIED' using errcode = '42501';
  end if;
  if lower(auth_record.email) <> lower(trim(target_email)) then
    raise exception 'OWNER_EMAIL_MISMATCH' using errcode = '42501';
  end if;
  if exists (select 1 from public.gym_users gu where gu.profile_id = target_profile_id) then
    raise exception 'OWNER_ALREADY_HAS_GYM' using errcode = '23505';
  end if;

  insert into public.profiles(
    id, full_name, terms_accepted_at, privacy_accepted_at, legal_version
  ) values (
    target_profile_id, trim(target_full_name), now(), now(), target_legal_version
  )
  on conflict (id) do update
    set full_name = excluded.full_name,
        terms_accepted_at = coalesce(public.profiles.terms_accepted_at, excluded.terms_accepted_at),
        privacy_accepted_at = coalesce(public.profiles.privacy_accepted_at, excluded.privacy_accepted_at),
        legal_version = coalesce(public.profiles.legal_version, excluded.legal_version);

  insert into public.gyms(name, slug, email, timezone, currency, status)
  values (trim(target_gym_name), target_gym_slug, lower(trim(target_email)), target_timezone, 'USD', 'trial')
  returning id into created_gym_id;

  insert into public.gym_locations(gym_id, name, address, city, timezone, is_main)
  values (
    created_gym_id,
    trim(target_location_name),
    nullif(trim(target_location_address), ''),
    trim(target_city),
    target_timezone,
    true
  )
  returning id into created_location_id;

  insert into public.gym_users(
    gym_id, profile_id, role, status, default_location_id, joined_at
  ) values (
    created_gym_id, target_profile_id, 'owner', 'active', created_location_id, now()
  )
  returning id into created_gym_user_id;

  select sp.id into selected_plan_id
  from public.saas_plans sp
  where sp.stripe_price_id = target_stripe_price_id
  limit 1;

  if selected_plan_id is null then
    insert into public.saas_plans(
      name, price, currency, billing_interval, trial_days, features, is_active, stripe_price_id
    ) values (
      trim(target_plan_name), target_plan_price, upper(target_plan_currency), 'month',
      target_trial_days, '{"mvp": true}'::jsonb, true, target_stripe_price_id
    )
    returning id into selected_plan_id;
  end if;

  calculated_trial_end := now() + make_interval(days => target_trial_days);

  insert into public.gym_subscriptions(
    gym_id, saas_plan_id, provider, status, trial_ends_at
  ) values (
    created_gym_id, selected_plan_id, 'stripe', 'trialing', calculated_trial_end
  )
  returning id into created_subscription_id;

  return query select
    created_gym_id,
    created_location_id,
    created_gym_user_id,
    created_subscription_id,
    calculated_trial_end;
end;
$$;

revoke all on function public.complete_owner_onboarding(
  uuid, text, text, text, text, text, text, text, text, text, numeric, text, text, integer, text
) from public, anon, authenticated;
grant execute on function public.complete_owner_onboarding(
  uuid, text, text, text, text, text, text, text, text, text, numeric, text, text, integer, text
) to service_role;

create or replace function public.apply_stripe_subscription_event(
  target_event_id text,
  target_event_type text,
  target_payload jsonb,
  target_gym_id uuid,
  target_customer_id text,
  target_subscription_id text,
  target_status public.subscription_status,
  target_trial_end timestamptz,
  target_period_start timestamptz,
  target_period_end timestamptz,
  target_cancel_at_period_end boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  inserted_event_id uuid;
begin
  insert into private.payment_webhook_events(
    provider, provider_event_id, event_type, payload, signature_verified,
    processing_status, attempt_count, last_attempt_at
  ) values (
    'stripe', target_event_id, target_event_type, target_payload, true,
    'received', 1, now()
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into inserted_event_id;

  if inserted_event_id is null then
    return false;
  end if;

  update public.gym_subscriptions gs
  set provider_customer_id = coalesce(target_customer_id, gs.provider_customer_id),
      provider_subscription_id = coalesce(target_subscription_id, gs.provider_subscription_id),
      status = target_status,
      trial_ends_at = case when target_status = 'trialing' then target_trial_end else gs.trial_ends_at end,
      current_period_starts_at = target_period_start,
      current_period_ends_at = target_period_end,
      cancel_at_period_end = target_cancel_at_period_end
  where gs.gym_id = target_gym_id
    and gs.provider = 'stripe'
    and (
      gs.provider_subscription_id = target_subscription_id
      or (gs.provider_subscription_id is null and gs.status = 'trialing')
    );

  if not found then
    raise exception 'GYM_STRIPE_SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.gyms
  set status = case target_status
    when 'trialing' then 'trial'::public.gym_status
    when 'active' then 'active'::public.gym_status
    when 'past_due' then 'past_due'::public.gym_status
    when 'cancelled' then 'cancelled'::public.gym_status
    else 'suspended'::public.gym_status
  end
  where id = target_gym_id;

  update private.payment_webhook_events
  set processing_status = 'processed', processed_at = now()
  where id = inserted_event_id;

  return true;
exception when others then
  if inserted_event_id is not null then
    update private.payment_webhook_events
    set processing_status = 'failed', error_message = sqlerrm
    where id = inserted_event_id;
  end if;
  raise;
end;
$$;

revoke all on function public.apply_stripe_subscription_event(
  text, text, jsonb, uuid, text, text, public.subscription_status,
  timestamptz, timestamptz, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription_event(
  text, text, jsonb, uuid, text, text, public.subscription_status,
  timestamptz, timestamptz, timestamptz, boolean
) to service_role;

commit;
