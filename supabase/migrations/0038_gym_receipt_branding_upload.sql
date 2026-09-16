begin;
set local lock_timeout = '5s';

-- Los logotipos aparecen en recibos verificables públicamente, por lo que su
-- lectura es pública. La escritura sigue limitada a URLs firmadas emitidas por
-- el backend después de validar tenant y permiso settings.manage.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'gym-receipt-branding',
  'gym-receipt-branding',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
