-- FIT-MEMBER-020. READ ONLY. Run before any 0057 rollout.
-- No fixtures, no mutation, no member names, no payment notes/reasons exposed.
-- A timestamp alone is not proof: 0025 synthesized timestamps for legacy rows.
with evidence as (
  select p.id period_id, p.gym_id, m.member_user_id, p.membership_id,
    p.starts_on, p.ends_on, p.status::text period_status,m.status::text membership_status,
    p.payment_id,pay.id matched_payment_id,m.attendance_mode_snapshot,
    pay.status::text payment_status,
    m.cancelled_at,
    exists (
      select 1 from public.audit_logs a
      where a.gym_id=p.gym_id and a.entity_id=m.id
        and a.entity_type='membership' and a.action='membership.cancelled'
        and a.before_data->>'status' in ('active','paused','expired')
        and a.after_data->>'history_preserved'='true'
        and a.after_data->>'payments_unchanged'='true'
        and a.after_data->>'cancelled_at'=(to_jsonb(m.cancelled_at)#>>'{}')
    ) audited_normal_cancellation,
    exists (
      select 1 from public.weekly_attendance_progress w
      where w.gym_id=p.gym_id and w.membership_id=m.id
        and w.target_attendances is distinct from m.weekly_target_snapshot
    ) conflicting_goal_snapshot
  from public.membership_periods p
  join public.memberships m on m.id=p.membership_id and m.gym_id=p.gym_id
  left join public.member_payments pay on pay.id=p.payment_id and pay.gym_id=p.gym_id
), classified as (
  select *, case
    when conflicting_goal_snapshot then 'ambiguous_goal_snapshot'
    when payment_status in ('voided','refunded') then 'ambiguous_payment_reversal'
    when payment_id is not null and (matched_payment_id is null or payment_status<>'confirmed') then 'ambiguous_payment_link'
    when period_status='active' and membership_status<>'cancelled' then 'active_coverage'
    when period_status in ('active','cancelled') and audited_normal_cancellation
      and (payment_status is null or payment_status='confirmed') then 'audited_normal_cancellation'
    else 'ambiguous_coverage_state'
  end evidence_class
  from evidence
)
select evidence_class, count(*) period_count,
  count(*) filter(where attendance_mode_snapshot='weekly') weekly_period_count,
  count(distinct (gym_id,member_user_id)) affected_members,
  min(starts_on) earliest_start, max(ends_on) latest_end,
  coalesce(jsonb_agg(jsonb_build_object(
    'gymId',gym_id,'memberId',member_user_id,'membershipId',membership_id,
    'periodId',period_id,'startsOn',starts_on,'endsOn',ends_on
  ) order by gym_id,member_user_id,starts_on,period_id)
    filter(where evidence_class like 'ambiguous%'), '[]'::jsonb) review_periods
from classified group by evidence_class order by evidence_class;
