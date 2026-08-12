# Pruebas SQL y RLS

`0018_backend_only_writes.sql` comprueba dos límites después de aplicar la
migración homónima:

- `authenticated` no conserva privilegios directos de escritura.
- una identidad activa ve su gimnasio, pero no un tenant diferente.

La prueba usa dos tenants existentes, no modifica datos persistentes y termina
con `ROLLBACK`. Debe ejecutarse manualmente en el SQL Editor después de aplicar
la migración `0018`.
