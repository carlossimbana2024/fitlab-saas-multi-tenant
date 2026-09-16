-- Ejecutar después de 0038_gym_receipt_branding_upload.sql.
begin;
set local lock_timeout = '5s';

do $$
declare
  branding_bucket storage.buckets;
begin
  select * into branding_bucket
  from storage.buckets
  where id = 'gym-receipt-branding';

  if branding_bucket.id is null
     or branding_bucket.public is distinct from true
     or branding_bucket.file_size_limit is distinct from 5242880
     or branding_bucket.allowed_mime_types is distinct from array['image/jpeg', 'image/png', 'image/webp']::text[] then
    raise exception 'GYM_RECEIPT_BRANDING_BUCKET_INVALID';
  end if;

  raise notice '0038 OK: bucket público de marca, límite y formatos comprobados.';
end;
$$;

rollback;
