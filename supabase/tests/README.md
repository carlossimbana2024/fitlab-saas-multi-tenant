# Pruebas SQL y RLS

`0018_backend_only_writes.sql` comprueba dos límites después de aplicar la
migración homónima:

- `authenticated` no conserva privilegios directos de escritura.
- una identidad activa ve su gimnasio, pero no un tenant diferente.

La prueba usa dos tenants existentes, no modifica datos persistentes y termina
con `ROLLBACK`. Debe ejecutarse manualmente en el SQL Editor después de aplicar
la migración `0018`.

`0019_identity_abuse_audit_managed_members.sql` comprueba, también dentro de una
transacción que termina con `ROLLBACK`:

- que un miembro administrado se crea activo, sin perfil Auth y con auditoría;
- que las RPC nuevas no son ejecutables por `authenticated`;
- que el rate limiting compartido permite el primer intento y bloquea el segundo.

Necesita al menos un owner activo y una sucursal activa existentes. Debe
ejecutarse manualmente después de aplicar la migración `0019`.
