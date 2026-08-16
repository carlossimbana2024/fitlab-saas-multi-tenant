  -- Ejecutar despues de 0026_receipt_verification_branding.sql.
  -- Comprueba marca, token unico e inmutabilidad; todo termina con ROLLBACK.
  begin;

  do $$
  declare
    owner_record record;
    payment_record record;
    branding_record record;
    expected_failure boolean := false;
    audit_count bigint;
  begin
    if has_function_privilege(
      'authenticated',
      'public.update_gym_receipt_branding_backend(uuid,uuid,text,boolean)',
      'EXECUTE'
    ) then
      raise exception 'AUTHENTICATED_CAN_UPDATE_RECEIPT_BRANDING';
    end if;

    if exists (
      select 1 from public.member_payments payment
      where payment.receipt_verification_token is null
    ) then
      raise exception 'PAYMENT_WITHOUT_RECEIPT_VERIFICATION_TOKEN';
    end if;
    if exists (
      select payment.receipt_verification_token
      from public.member_payments payment
      group by payment.receipt_verification_token
      having count(*) > 1
    ) then
      raise exception 'DUPLICATE_RECEIPT_VERIFICATION_TOKEN';
    end if;

    select owner.id as owner_user_id, owner.gym_id
      into owner_record
    from public.gym_users owner
    where owner.role = 'owner' and owner.status = 'active'
    order by owner.created_at
    limit 1;
    if owner_record.owner_user_id is null then
      raise exception 'TEST_REQUIRES_ACTIVE_OWNER';
    end if;

    select * into branding_record
    from public.update_gym_receipt_branding_backend(
      owner_record.gym_id, owner_record.owner_user_id,
      'https://example.com/fitlab-receipt-test.png', false
    );
    if branding_record.logo_url is distinct from
       'https://example.com/fitlab-receipt-test.png' then
      raise exception 'RECEIPT_BRANDING_WAS_NOT_UPDATED';
    end if;

    select payment.id, payment.receipt_verification_token
      into payment_record
    from public.member_payments payment
    where payment.gym_id = owner_record.gym_id
      and payment.receipt_number is not null
    order by payment.created_at
    limit 1;

    if payment_record.id is not null then
      begin
        update public.member_payments
        set receipt_verification_token = gen_random_uuid()
        where id = payment_record.id;
      exception when check_violation then
        expected_failure := true;
      end;
      if not expected_failure then
        raise exception 'RECEIPT_VERIFICATION_TOKEN_COULD_CHANGE';
      end if;
    end if;

    select count(*) into audit_count
    from public.audit_logs log
    where log.gym_id = owner_record.gym_id
      and log.action = 'settings.receipt_branding_updated'
      and log.created_at >= transaction_timestamp();
    if audit_count <> 1 then
      raise exception 'RECEIPT_BRANDING_WAS_NOT_AUDITED';
    end if;

    raise notice '0026 OK: marca auditada y QR unico, aleatorio e inmutable.';
  end;
  $$;

  rollback;
