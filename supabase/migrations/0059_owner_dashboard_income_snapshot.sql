begin;

-- One statement/snapshot for gym currency, civil month and all confirmed payments.
-- Only the backend calls this, after verifying tenant and finances.view.
create or replace function public.get_owner_dashboard_income_backend(
  target_gym_id uuid,
  reference_at timestamptz default statement_timestamp()
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  with gym_month as (
    select g.id, g.currency, g.timezone,
      date_trunc('month', coalesce(reference_at, statement_timestamp()) at time zone g.timezone) as month_start
    from public.gyms g
    where g.id = target_gym_id
  ), eligible as (
    select p.currency, p.amount,
      case
        when p.membership_id is not null then 'memberships'
        when p.sale_id is not null then 'stockSales'
        when p.class_booking_id is not null then 'activities'
        else 'other'
      end as category
    from gym_month g
    join public.member_payments p on p.gym_id = g.id
      and p.paid_at >= (g.month_start at time zone g.timezone)
      and p.paid_at < ((g.month_start + interval '1 month') at time zone g.timezone)
      and p.status = 'confirmed'
      and p.amount <> 'NaN'::numeric
  ), totals as (
    select currency, sum(amount) as amount, count(*) as payment_count,
      sum(amount) filter (where category = 'memberships') as memberships_amount,
      count(*) filter (where category = 'memberships') as memberships_count,
      sum(amount) filter (where category = 'stockSales') as stock_sales_amount,
      count(*) filter (where category = 'stockSales') as stock_sales_count,
      sum(amount) filter (where category = 'activities') as activities_amount,
      count(*) filter (where category = 'activities') as activities_count,
      sum(amount) filter (where category = 'other') as other_amount,
      count(*) filter (where category = 'other') as other_count
    from eligible
    group by currency
  )
  select jsonb_build_object(
    'month', to_char(g.month_start, 'YYYY-MM'),
    'currencies', jsonb_agg(jsonb_build_object(
      'currency', coalesce(t.currency, g.currency),
      'amount', coalesce(t.amount, 0),
      'count', coalesce(t.payment_count, 0),
      'categories', jsonb_build_object(
        'memberships', jsonb_build_object('amount', coalesce(t.memberships_amount, 0), 'count', coalesce(t.memberships_count, 0)),
        'stockSales', jsonb_build_object('amount', coalesce(t.stock_sales_amount, 0), 'count', coalesce(t.stock_sales_count, 0)),
        'activities', jsonb_build_object('amount', coalesce(t.activities_amount, 0), 'count', coalesce(t.activities_count, 0)),
        'other', jsonb_build_object('amount', coalesce(t.other_amount, 0), 'count', coalesce(t.other_count, 0))
      )
    ) order by coalesce(t.currency, g.currency) collate "C")
  )
  from gym_month g
  left join totals t on true
  group by g.month_start;
$$;

revoke all on function public.get_owner_dashboard_income_backend(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.get_owner_dashboard_income_backend(uuid, timestamptz) to service_role;

comment on function public.get_owner_dashboard_income_backend(uuid, timestamptz)
  is 'Backend-only snapshot of currently confirmed payments for one gym civil month, summed by currency and category.';

commit;
