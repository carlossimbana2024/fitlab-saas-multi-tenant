begin;

alter table public.gyms
  add column if not exists whatsapp_phone text;

alter table public.gym_locations
  add column if not exists email text,
  add column if not exists whatsapp_phone text;

alter table public.gyms
  add constraint gyms_contact_email_format_chk
  check (email is null or email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') not valid;

alter table public.gym_locations
  add constraint gym_locations_contact_email_format_chk
  check (email is null or email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') not valid;

alter table public.gyms validate constraint gyms_contact_email_format_chk;
alter table public.gym_locations validate constraint gym_locations_contact_email_format_chk;

comment on column public.gyms.whatsapp_phone is
  'Número internacional de WhatsApp del gimnasio, separado del teléfono convencional.';
comment on column public.gym_locations.email is
  'Correo de contacto específico de la sucursal.';
comment on column public.gym_locations.whatsapp_phone is
  'Número internacional de WhatsApp específico de la sucursal.';

commit;
