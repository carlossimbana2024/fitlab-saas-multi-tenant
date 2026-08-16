-- Ejecutar despues de 0025_membership_renewal_receipts.sql.
-- Renueva, emite recibo, reembolsa y cancela dentro de ROLLBACK.
begin;

do $$
declare
  owner_record record;
  renewal_target record;
  checkout_record record;
  reversal_record record;
  cancellation_record record;
  audit_count bigint;
begin
  if has_function_privilege(
    'authenticated',
    'public.register_manual_membership_checkout(uuid,uuid,uuid,uuid,uuid,member_payment_method,text,text,uuid,boolean)',
    'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_CHECKOUT_MEMBERSHIP';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.cancel_membership_backend(uuid,uuid,uuid,text,boolean)',
    'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_CANCEL_MEMBERSHIP';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.reverse_member_payment_backend(uuid,uuid,uuid,payment_status,text,boolean)',
    'EXECUTE'
  ) then
    raise exception 'AUTHENTICATED_CAN_REVERSE_PAYMENT';
  end if;

  select owner.id as owner_user_id, owner.gym_id,
         coalesce(owner.default_location_id, location.id) as location_id
    into owner_record
  from public.gym_users owner
  join lateral (
    select candidate.id
    from public.gym_locations candidate
    where candidate.gym_id = owner.gym_id and candidate.is_active
    order by candidate.is_main desc, candidate.created_at
    limit 1
  ) location on true
  where owner.role = 'owner' and owner.status = 'active'
  order by owner.created_at
  limit 1;

  if owner_record.owner_user_id is null then
    raise exception 'TEST_REQUIRES_ACTIVE_OWNER_AND_LOCATION';
  end if;

  select membership.id as membership_id, membership.member_user_id,
         membership.plan_id
    into renewal_target
  from public.memberships membership
  join public.gym_users member on member.id = membership.member_user_id
  join public.plans plan on plan.id = membership.plan_id and plan.is_active
  where membership.gym_id = owner_record.gym_id
    and membership.status <> 'cancelled'
    and member.status = 'active'
    and plan.price > 0
  order by membership.created_at
  limit 1;

  if renewal_target.membership_id is not null then
    select * into checkout_record
    from public.register_manual_membership_checkout(
      owner_record.gym_id, owner_record.location_id,
      renewal_target.member_user_id, renewal_target.plan_id,
      owner_record.owner_user_id, 'cash', null,
      'Prueba transaccional 0025', renewal_target.membership_id, false
    );

    if checkout_record.receipt_number is null then
      raise exception 'CHECKOUT_DID_NOT_CREATE_RECEIPT';
    end if;
    if not exists (
      select 1 from public.membership_periods period
      where period.id = checkout_record.membership_period_id
        and period.charged_amount = checkout_record.charged_amount
        and period.currency = checkout_record.charged_currency
    ) then
      raise exception 'RENEWAL_PRICE_SNAPSHOT_MISSING';
    end if;

    select * into reversal_record
    from public.reverse_member_payment_backend(
      owner_record.gym_id, checkout_record.payment_id,
      owner_record.owner_user_id, 'refunded',
      'Reembolso de prueba 0025', false
    );
    if reversal_record.payment_status <> 'refunded'
       or reversal_record.receipt_number is distinct from checkout_record.receipt_number then
      raise exception 'PAYMENT_REFUND_DID_NOT_PRESERVE_RECEIPT';
    end if;

    select * into cancellation_record
    from public.cancel_membership_backend(
      owner_record.gym_id, renewal_target.membership_id,
      owner_record.owner_user_id, 'Cancelacion de prueba 0025', false
    );
    if cancellation_record.membership_status <> 'cancelled' then
      raise exception 'MEMBERSHIP_WAS_NOT_CANCELLED';
    end if;

    select count(*) into audit_count
    from public.audit_logs log
    where log.gym_id = owner_record.gym_id
      and log.action in (
        'membership.renewed', 'payment.refunded', 'membership.cancelled'
      )
      and log.created_at >= transaction_timestamp();
    if audit_count < 3 then
      raise exception 'FINANCIAL_LIFECYCLE_WAS_NOT_AUDITED';
    end if;
  end if;

  if exists (
    select 1 from public.member_payments payment
    where payment.status in ('confirmed', 'voided', 'refunded')
      and (payment.receipt_number is null or payment.receipt_issued_at is null)
  ) then
    raise exception 'HISTORICAL_PAYMENT_WITHOUT_RECEIPT';
  end if;

  raise notice '0025 OK: renovacion, recibo inmutable, reembolso, cancelacion y auditoria.';
end;
$$;

rollback;
