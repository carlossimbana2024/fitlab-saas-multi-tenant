begin;

-- El logotipo se guarda como una URL HTTPS. El archivo puede alojarse en
-- Supabase Storage u otro origen controlado por el gimnasio.
alter table public.gyms
  add column logo_url text;

alter table public.gyms
  add constraint gyms_logo_url_chk check (
    logo_url is null
    or (
      char_length(logo_url) between 8 and 2048
      and logo_url ~* '^https://[^[:space:]]+$'
    )
  );

-- El token no contiene el id del pago ni otro dato predecible. Es la única
-- credencial pública del QR y permanece estable durante toda la vida del recibo.
alter table public.member_payments
  add column receipt_verification_token uuid not null default gen_random_uuid();

create unique index member_payments_receipt_verification_token_idx
  on public.member_payments(receipt_verification_token);

create or replace function private.protect_payment_receipt_verification_token()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.receipt_verification_token is distinct from old.receipt_verification_token then
    raise exception 'PAYMENT_RECEIPT_VERIFICATION_TOKEN_IS_IMMUTABLE'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_payment_receipt_verification_token()
  from public, anon, authenticated;

create trigger member_payments_protect_receipt_verification_token
before update of receipt_verification_token
on public.member_payments
for each row execute function private.protect_payment_receipt_verification_token();

-- La marca del recibo se escribe por una RPC backend-only para conservar el
-- mismo límite de confianza y la misma autorización de settings.manage.
create or replace function public.update_gym_receipt_branding_backend(
  target_gym_id uuid,
  target_actor_gym_user_id uuid,
  supplied_logo_url text,
  supplied_used_pin_elevation boolean
)
returns table(
  id uuid,
  logo_url text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile_id uuid;
  previous_logo_url text;
  normalized_logo_url text;
begin
  normalized_logo_url := nullif(trim(supplied_logo_url), '');
  if normalized_logo_url is not null
     and (
       char_length(normalized_logo_url) not between 8 and 2048
       or normalized_logo_url !~* '^https://[^[:space:]]+$'
     ) then
    raise exception 'INVALID_GYM_RECEIPT_LOGO_URL' using errcode = '22023';
  end if;

  actor_profile_id := private.authorize_settings_backend_actor(
    target_gym_id, target_actor_gym_user_id,
    coalesce(supplied_used_pin_elevation, false)
  );

  select gym.logo_url into previous_logo_url
  from public.gyms gym
  where gym.id = target_gym_id
  for update;
  if not found then
    raise exception 'GYM_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.gyms as gym
  set logo_url = normalized_logo_url
  where gym.id = target_gym_id;

  insert into public.audit_logs(
    gym_id, actor_profile_id, actor_gym_user_id, action, entity_type,
    entity_id, permission_key, used_pin_elevation, before_data, after_data
  ) values (
    target_gym_id, actor_profile_id, target_actor_gym_user_id,
    'settings.receipt_branding_updated', 'gym', target_gym_id,
    'settings.manage', coalesce(supplied_used_pin_elevation, false),
    jsonb_build_object('logo_url', previous_logo_url),
    jsonb_build_object('logo_url', normalized_logo_url)
  );

  return query select target_gym_id, normalized_logo_url;
end;
$$;

revoke all on function public.update_gym_receipt_branding_backend(
  uuid, uuid, text, boolean
) from public, anon, authenticated;
grant execute on function public.update_gym_receipt_branding_backend(
  uuid, uuid, text, boolean
) to service_role;

commit;
