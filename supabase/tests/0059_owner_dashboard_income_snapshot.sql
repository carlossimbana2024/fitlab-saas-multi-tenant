-- Local fixtures only. Run with run-owner-dashboard-income-local.mjs, never in production.
begin;

do $test$
declare
  gym_a uuid := md5('owner003-a')::uuid;
  gym_b uuid := md5('owner003-b')::uuid;
  gym_empty uuid := md5('owner003-empty')::uuid;
  instant timestamptz := '2027-01-15 12:00Z';
  volume integer;
  previous_volume integer := 0;
  result jsonb;
begin
  if current_setting('fitlab.owner003_local', true) is distinct from 'on' then
    raise exception '0059 fixtures require an isolated local database';
  end if;

  insert into public.gyms(id, timezone, currency) values
    (gym_a, 'America/Guayaquil', 'USD'),
    (gym_b, 'America/New_York', 'USD'),
    (gym_empty, 'America/Guayaquil', 'CAD');

  foreach volume in array array[10, 100, 1000, 1001, 2500, 5000, 5001] loop
    insert into public.member_payments(gym_id, location_id, paid_at, status, currency, amount)
    select gym_a, md5('owner003-branch-' || (i % 2))::uuid, instant, 'confirmed', 'USD', 1.11
    from generate_series(previous_volume + 1, volume) i;
    previous_volume := volume;
    result := public.get_owner_dashboard_income_backend(gym_a, instant);
    if result #> '{currencies,0,count}' is distinct from to_jsonb(volume)
      or result #> '{currencies,0,amount}' is distinct from to_jsonb(volume * 1.11)
      or result #> '{currencies,0,categories,other,count}' is distinct from to_jsonb(volume) then
      raise exception '0059 volume %: %', volume, result;
    end if;
  end loop;

  -- December/January edges, cents, separate currency, reference priority, and excluded states.
  insert into public.member_payments(gym_id, location_id, paid_at, status, currency, amount, membership_id, sale_id, class_booking_id)
  values
    (gym_a, gym_a, '2027-01-01 04:59:59.999999Z', 'confirmed', 'USD', 59, null, null, null),
    (gym_a, gym_a, '2027-01-01 05:00:00Z', 'confirmed', 'USD', 2.35, gym_a, gym_b, gym_empty),
    (gym_a, gym_b, '2027-02-01 04:59:59.999999Z', 'confirmed', 'USD', 3.45, null, gym_b, gym_empty),
    (gym_a, gym_b, '2027-02-01 05:00:00Z', 'confirmed', 'USD', 99, null, null, null),
    (gym_a, gym_b, instant, 'confirmed', 'EUR', 4.56, null, null, gym_empty),
    (gym_a, gym_a, instant, 'pending', 'USD', 100, null, null, null),
    (gym_a, gym_a, instant, 'failed', 'USD', 100, null, null, null),
    (gym_a, gym_a, instant, 'voided', 'USD', 100, null, null, null),
    (gym_a, gym_a, instant, 'refunded', 'USD', 100, null, null, null),
    (gym_a, gym_a, instant, 'confirmed', 'USD', 'NaN', null, null, null),
    -- In New York, March starts in EST but April starts in EDT.
    (gym_b, gym_b, '2027-03-01 04:59:59.999999Z', 'confirmed', 'USD', 7, null, null, null),
    (gym_b, gym_b, '2027-03-01 05:00:00Z', 'confirmed', 'USD', 8, null, null, null),
    (gym_b, gym_b, '2027-04-01 03:59:59.999999Z', 'confirmed', 'USD', 9, null, null, null),
    (gym_b, gym_b, '2027-04-01 04:00:00Z', 'confirmed', 'USD', 10, null, null, null),
    (gym_b, gym_b, instant, 'confirmed', 'USD', 1000, null, null, null);

  result := public.get_owner_dashboard_income_backend(gym_a, instant);
  if result is distinct from jsonb_build_object('month', '2027-01', 'currencies', jsonb_build_array(
    '{"currency":"EUR","amount":4.56,"count":1,"categories":{"memberships":{"amount":0,"count":0},"stockSales":{"amount":0,"count":0},"activities":{"amount":4.56,"count":1},"other":{"amount":0,"count":0}}}'::jsonb,
    '{"currency":"USD","amount":5556.91,"count":5003,"categories":{"memberships":{"amount":2.35,"count":1},"stockSales":{"amount":3.45,"count":1},"activities":{"amount":0,"count":0},"other":{"amount":5551.11,"count":5001}}}'::jsonb
  )) then
    raise exception '0059 currencies, scope, categories or states: %', result;
  end if;

  result := public.get_owner_dashboard_income_backend(gym_a, '2027-01-01 04:59:59.999999Z');
  if result->>'month' is distinct from '2026-12' or result #> '{currencies,0,amount}' is distinct from '59'::jsonb then
    raise exception '0059 previous civil year: %', result;
  end if;
  result := public.get_owner_dashboard_income_backend(gym_b, '2027-04-01 03:59:59.999999Z');
  if result->>'month' is distinct from '2027-03' or result #> '{currencies,0,amount}' is distinct from '17'::jsonb then
    raise exception '0059 New York DST boundaries: %', result;
  end if;
  result := public.get_owner_dashboard_income_backend(gym_b, '2027-04-01 04:00:00Z');
  if result->>'month' is distinct from '2027-04' or result #> '{currencies,0,amount}' is distinct from '10'::jsonb then
    raise exception '0059 exclusive end: %', result;
  end if;
  result := public.get_owner_dashboard_income_backend(gym_empty, instant);
  if result is distinct from '{"month":"2027-01","currencies":[{"currency":"CAD","amount":0,"count":0,"categories":{"memberships":{"amount":0,"count":0},"stockSales":{"amount":0,"count":0},"activities":{"amount":0,"count":0},"other":{"amount":0,"count":0}}}]}'::jsonb
    or public.get_owner_dashboard_income_backend(md5('owner003-unknown')::uuid, instant) is not null then
    raise exception '0059 fallback or unknown gym: %', result;
  end if;
end
$test$;

set local role service_role;
do $test$
begin
  if public.get_owner_dashboard_income_backend(md5('owner003-a')::uuid) is null then
    raise exception '0059 default argument or service role is broken';
  end if;
end
$test$;
reset role;

rollback;
select '0059 OK: 7 volumes, civil dates, states, tenant, locations, currency, categories, empty and service role' as result;
