# FIT-MEMBER-014 — checkpoint SQL autoritativo

Esta decisión sustituye el experimento de conversión frontend descrito en
fit-member-014-open-now.md. El conversor experimental y su runner se eliminaron;
no estaban integrados al runtime. El usuario confirmó la aplicación de 0056.
La integración final local está descrita en fit-member-014-open-now.md;
la implementación frontend provisional fue retirada.

## Función y seguridad

`get_member_branch_open_status_backend(gym, member, location, requested_at)`:
backend-only SECURITY DEFINER, search_path pg_catalog,public. EXECUTE revocado
a public/anon/authenticated; concedido solo a service_role. Reutiliza el guard
de 0054: actor miembro activo con account_mode=portal del gimnasio indicado.
La ubicación debe pertenecer al mismo gimnasio y estar activa. Como otras RPC
backend-only, service_role es una identidad confiable: Express debe obtener
gym/actor de tenantContext, nunca de parámetros libres del navegador. El instante
debe venir del servidor en producción; el parámetro permite pruebas deterministas.
No extiende permisos a owner/staff: esta fase sirve al portal del miembro.

## Fuente única de reglas

0053 queda intacta. `class_interval_within_opening_hours` determina el estado
para [instante, instante + 1 microsegundo), y valida cada posible transición.
Solo se enumeran fronteras candidatas (medianoches, aperturas y cierres civiles)
en PostgreSQL. Una frontera entre ventanas contiguas no es una transición real.
Las horas iguales cierran al día siguiente; excepciones cortan el tramo anterior.

Contrato JSON: isOpenNow, nextTransitionAt, nextState, timezone, evaluatedAt,
validUntil, revalidateAt. UTC serializado como timestamptz JSON (puede incluir
offset +00:00 en lugar de Z). Rango de búsqueda: ayer hasta ocho días locales.
null nextTransitionAt significa NO encontrada dentro del horizonte, no ausencia
perpetua. revalidateAt indica próxima transición o final del horizonte; el futuro
hook debe programar un timeout para esa fecha y revalidar al volver a la pestaña.
Un horario editado remotamente requiere revalidación; no se añade realtime aquí.

## Pruebas y despliegue manual

1. Ejecutar primero la consulta read-only de conversiones indicada abajo.
2. Aplicar supabase/migrations/0056_branch_open_status.sql una sola vez.
3. NO ejecutar pruebas con fixtures en producción, ni siquiera con ROLLBACK.
   0056_branch_open_status.sql y 0056_branch_open_status_ecuador_local.sql son
   exclusivamente locales. Ecuador: 23 comparaciones directas 0053/0056 y
   9 comprobaciones exactas de próxima transición, todas aprobadas.
4. Ejecutar supabase/tests/0056_branch_open_status_verify.sql.
   ACL esperado false/false/true; offers_enabled false y cron inactive.
5. Compartir resultados antes de integrar backend/frontend. No activar ofertas.

Consulta previa (no necesita la migración):

```sql
select version(),
 timestamp '2026-10-04 00:30' at time zone 'Africa/Casablanca' as casablanca,
 timestamp '2026-03-08 02:30' at time zone 'America/New_York' as spring_forward,
 timestamp '2026-11-01 01:30' at time zone 'America/New_York' as fall_back;
```

PGlite local había devuelto Casablanca 00:30Z, New York spring 07:30Z y fall
06:30Z. Supabase NO comprobado; su resultado manda en producción. Las pruebas
calculan expectativas DST usando AT TIME ZONE de la propia base y verifican
estado/frontera, sin afirmar equivalencia entre tzdata local y remota.

Runner local: portal-timezone-sql-check.mjs aplica hasta 0056 en memoria,
omite 0052 por falta de pg_cron y ejecuta 0053 + 0056. Ambas pasan. Cubre horarios
normales, bordes, overnight, cierre semanal, excepciones, horario especial,
horas iguales/ventanas contiguas, sin transición, DST, actor inactivo,
tenant/ubicación ajenos y ACL. No cambios en datos reales ni índices nuevos.

Reversión antes de integrar consumidores: DROP FUNCTION
public.get_member_branch_open_status_backend(uuid,uuid,uuid,timestamptz);
sin CASCADE. No ejecutar salvo reversión autorizada. Tras integración, retirar
primero los consumidores. Sin commit/push ni acceso remoto en este checkpoint.
