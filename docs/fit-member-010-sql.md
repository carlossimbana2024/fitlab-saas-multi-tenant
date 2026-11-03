# FIT-MEMBER-010 — integración local, pendiente de aplicación y despliegue

## Estado y alcance

Preparada `0055_member_weight_goal_metric.sql`. No aplicada remotamente ni cambiada
durante esta fase de integración. Backend/frontend integrados localmente por
autorización del usuario; no se modificó 0054, datos reales, RLS, cron ni ofertas.
Sin commit/push ni despliegue.
FIT-MEMBER-011 y la lectura personal limitada a 500 mediciones permanecen intactos.

## Definición aprobada

- Inicial histórico: primera medición por `measured_on`; actual: última medición.
  Los registros tienen rango 20–500 y unicidad gimnasio/miembro/fecha. La encuesta
  editable no se usa como fallback cuando falta historial.
- El trigger 0034 crea la primera medición al INSERT del perfil; editar la encuesta
  no actualiza el historial. El seed antiguo importó el peso disponible al migrar;
  no se afirma conocer un peso anterior que no fue registrado.
- Registrar otro peso en la misma fecha reemplaza esa medición por el contrato
  existente; insertar una fecha anterior puede cambiar el primer punto histórico.
  No se transforma esa base en un snapshot inmutable ni se cambia la escritura.
- Pérdida: `(inicial-actual)/(inicial-objetivo)*100`, solo objetivo menor al inicial.
- Ganancia/build_muscle: `(actual-inicial)/(objetivo-inicial)*100`, solo objetivo
  mayor al inicial. Porcentaje acotado a 0–100, redondeado a un decimal.
- Sin historial, objetivo válido o dirección válida: porcentaje null. Una sola
  medición produce 0 para una dirección válida. Inicial=objetivo no divide por cero
  ni implica cumplimiento. Valores inválidos/no finitos no generan porcentaje.
- Mantenimiento: siempre porcentaje null; con actual/objetivo válidos devuelve
  actual, objetivo y diferencia firmada `actual-objetivo`, sin tolerancia implícita.
  La futura UI mostrará por encima/por debajo/en tu peso objetivo, sin barra porcentual.
- Cambiar meta o tipo de objetivo recalcula frente al objetivo vigente, sin ciclos
  ni modificación del historial. Esto también se conserva en rankings históricos.

## Funciones y contrato

Nuevo helper privado `member_weight_goal_metric(text,numeric,numeric,numeric)`:
`{progressPercent: number|null, maintenance: null|{currentWeightKg,targetWeightKg,differenceKg}}`.
Es la única fórmula SQL. Las funciones existentes `member_community_goal_percent`
y `member_monthly_goal_percent` delegan en él, conservando sus firmas. El wrapper
mensual devuelve null para avances no positivos, como antes.

Nuevo `member_historical_weight_goal(uuid,uuid)` consulta el perfil y extremos del
historial con gimnasio/miembro en cada consulta. No devuelve el peso de encuesta.
Es un helper privado, no un endpoint accesible al navegador ni a service_role.

`list_member_community_page_backend` usa ese histórico para ordenar por progreso
y presentar el porcentaje. Añade `weightMaintenance`, null salvo mantenimiento con
`show_weight_progress=true` Y `show_goal=true`: divulgar el peso objetivo también
divulga información del objetivo. No se publican pesos absolutos de otros objetivos.
Se mantienen privacidad global, actores activos, aislamiento, siete filtros,
keyset, máximo 50 y población completa. La categoría/filtro de Comunidad sigue
incluyendo mantenimiento; solo carece de puntuación porcentual.

`get_member_community_rankings_backend` NO se redefine. Su helper mensual cambia,
pero se conservan la última medida previa al mes (o primera del mes), la última
medida dentro del período y la exigencia de dos fechas distintas. Mantenimiento
queda excluido únicamente de progreso; asistencia y racha siguen independientes.
Top3 admite 0, 1 o 2 participantes sin rellenar. Puntuaciones no positivas no entran.

Ejemplo: histórico 90 (1 dic), 88 (31 dic), 85 (31 ene), objetivo 80.
Comunidad/histórico = 50%; ranking enero = 37,5%. La diferencia temporal es intencional.

Progreso y perfil social usan la misma función TypeScript en
`memberWeightGoal.service.ts`, equivalente al helper SQL y comprobada mediante
360 comparaciones ejecutadas contra SQL real local. Se eliminaron las fórmulas
duplicadas de los controladores. El helper mensual TS conservado para pruebas
también delega en esa función; producción sigue delegando rankings a SQL.
La consulta personal mantiene exactamente el orden ascendente y limit(500).
Perfil social conserva su consulta del último peso y añade la primera medición
con aislamiento por gimnasio/miembro; sin fallback a encuesta.

Progreso, resumen de Perfil, Comunidad y actividad del perfil social muestran
mantenimiento mediante WeightMaintenanceSummary, sin porcentaje ni barra. Los
pesos/diferencia llegan del backend: el frontend solo formatea el resultado.
El contrato SQL weightMaintenance se valida y se transmite por Express; null no
se convierte en cero. Registro de peso y edición de encuesta invalidan Progreso,
Comunidad, perfil social y rankings. La etiqueta del peso editable se aclara como
«Peso declarado en encuesta». No se cambia diseño ni escritura de mediciones.

## Seguridad y riesgo de aplicación

Helpers con search_path fijo, sin EXECUTE para PUBLIC/anon/authenticated/service_role.
RPC pública conserva SECURITY DEFINER, lector validado y EXECUTE solo service_role
(además del propietario). Ningún cambio en privilegios de tablas o políticas RLS.
Sin UPDATE/DELETE/INSERT de datos ni backfill. Índices existentes cubren extremos.
El filtro de progreso calcula sobre todos los elegibles, nunca sobre una página
truncada; las otras vistas enriquecen la página. Las búsquedas históricas añaden
coste de lectura; validar rendimiento real en staging si el volumen lo requiere.

Al aplicar, Comunidad y ranking que ya llaman estas RPC cambian de cálculo de
inmediato. La versión local ya incluye Progreso/Perfil y la presentación nueva,
pero hay que desplegarla a continuación. SQL y deployments no son una operación
atómica: preparar el release antes y coordinar la aplicación reduce, pero no
elimina por sí solo, una ventana transitoria (incluidas pestañas con JS antiguo).
Si se exige cero ventana visible, hace falta una ventana de mantenimiento o una
estrategia de release coordinado, no realizada en esta tarea.
Reiniciar/recargar Comunidad para no reutilizar cursores de la ordenación anterior.

## Pruebas locales

`node backend/tests/helpers/member-weight-goal-sql-check.mjs <directorio-@electric-sql/pglite>`

El runner solo crea PGlite en memoria, sin conexión, URL ni credenciales. Aplica
migraciones hasta 0054 excepto cron 0052, ejecuta SQL0048 y SQL0054 original; aplica
0055 dos veces y verifica que las definiciones de rankings/asistencias no cambien.
Ejecuta `0055_member_weight_goal_metric.sql` con fixtures aislados y rollback.
Su guardia impide uso accidental fuera del runner. Durante el seed heredado de
0054 se omiten triggers para datos sintéticos; antes de las RPC se restauran.
NO ejecutar ese archivo de fixtures en Supabase, ni quitar su guardia.

Incluye regresión de 201/2001 asistencias, >10000 filas, 360 candidatos, ganador
fuera de 250, siete filtros/paginación, privacidad, tenants, ACL; nuevos casos de
historial/encuesta, cambio de objetivo sin reescritura, una/sin medición,
mantenimiento exacto/arriba/abajo, consentimiento, período mensual y Top0/1/2.
La verificación de solo lectura cubre 25 casos de porcentaje (también mensuales),
diferencias decimales, NaN/Infinity, división por cero, límites y permisos.

Resultado local de integración: todos los bloques SQL aprobados, doble aplicación
idempotente, 360 comparaciones SQL/backend, offers_enabled=false y ventana 30min.
Cron no reproducible en PGlite y NO comprobado remotamente. Pruebas funcionales:
memberWeightGoal, memberWeightGoalUi; regresiones memberAggregatesIntegration,
memberAggregatesUi, memberSocialProfile, memberProgressBoundary,
memberCommunityBoundary, memberCommunityRankingBoundary, communityRanking,
memberPrivacy y currentWeeklyProgress: 109 tests aprobados en 11 archivos.
Backend y frontend typecheck/build OK.
Advertencias de build existentes: bundle grande e importación mixta de jsPDF;
el renderer React usado por las pruebas avisa de obsolescencia.
No se hizo smoke test remoto ni prueba de concurrencia entre despliegues.

## Pasos exactos en Supabase

1. Preferir staging y revisar el checkpoint/impacto transitorio anterior.
2. SQL Editor: pegar y ejecutar COMPLETO
   `supabase/migrations/0055_member_weight_goal_metric.sql`.
   Esperar Success (la transacción conserva los cambios solo si todo termina bien).
3. En otra consulta ejecutar COMPLETO
   `supabase/tests/0055_member_weight_goal_verify.sql`.
   Es de solo lectura, no crea fixtures ni activa ofertas/cron.
4. Esperar `0055 OK: canonical metric, maintenance without percentage, monthly exclusion, ACL`.
   El editor puede mostrar solo el último resultado: ejecutar por separado los dos
   SELECT finales para comprobar offers_enabled=false, offer_window=00:30:00 y una
   fila fitlab-class-waitlist-offers con active=false. No cambiar esos valores.
5. Confirmar los resultados y desplegar la versión integrada preparada mediante
   un release autorizado; en esta tarea no se hace commit/push ni deploy.
6. Recargar la aplicación y comprobar Progreso/Comunidad con historial menor o
   igual a 500 medidas. Por encima sigue pendiente FIT-MEMBER-011 y puede diferir.

## Reversión

Reversible sin tocar mediciones mediante una migración compensatoria revisada:
restaurar las definiciones de member_community_goal_percent,
member_monthly_goal_percent y list_member_community_page_backend de 0054,
conservar sus ACL, y después retirar los dos helpers nuevos solo si ya no tienen
consumidores. Sin CASCADE y sin borrar el historial de migraciones. Esa reversión
restauraría también el bug anterior; no ejecutarla como parte de este procedimiento.

## Archivos de la integración local

- backend/src/controllers/member.controller.ts
- backend/src/controllers/memberCommunity.controller.ts
- backend/src/controllers/memberSocialProfile.controller.ts
- backend/src/services/memberWeightGoal.service.ts (nuevo)
- backend/src/services/memberAggregates.service.ts
- backend/src/services/communityRanking.service.ts
- frontend/src/pages/MemberPortalPage.tsx
- frontend/src/pages/MemberCommunityPage.tsx
- frontend/src/components/MemberSocialProfile.tsx
- frontend/src/components/WeightMaintenanceSummary.tsx (nuevo)
- backend/tests/memberWeightGoal.test.ts (nuevo)
- backend/tests/memberWeightGoalUi.test.ts (nuevo)
- backend/tests/helpers/member-weight-goal-sql-check.mjs (ampliado con paridad)
- docs/fit-member-010-sql.md

Preparados en la fase anterior y sin cambios durante esta integración:
supabase/migrations/0055_member_weight_goal_metric.sql,
supabase/tests/0055_member_weight_goal_metric.sql y
supabase/tests/0055_member_weight_goal_verify.sql.
README.md, docs/analisis-competencia.md y docs/marketing/ son cambios ajenos
preexistentes que no fueron modificados.
