begin;

-- El JWT del usuario conserva acceso de lectura sujeto a RLS, pero ninguna
-- mutación operativa puede ejecutarse directamente mediante PostgREST.
-- Las escrituras pasan por Express y usan service_role después de validar
-- sesión, tenant, suscripción, permiso y (cuando aplica) elevación por PIN.
revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public
  from authenticated;

-- Sin INSERT directo, el rol del usuario tampoco necesita consumir secuencias.
revoke usage, select
  on all sequences in schema public
  from authenticated;

-- Evita que una RPC pública creada en el futuro quede ejecutable por los roles
-- de la Data API debido a los privilegios predeterminados de PostgreSQL.
revoke execute
  on all functions in schema public
  from public, anon, authenticated;

alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger
  on tables
  from authenticated;

alter default privileges in schema public
  revoke usage, select
  on sequences
  from authenticated;

alter default privileges in schema public
  revoke execute
  on functions
  from public, anon, authenticated;

commit;
