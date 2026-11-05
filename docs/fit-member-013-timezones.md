# FIT-MEMBER-013 — Contextos temporales explícitos

## Contrato

- Portal general: `gyms.timezone`, expuesto adicionalmente por `/auth/me`
  como `gymUser.gym.timezone`. Es la misma columna que entrega `/calendar`;
  no se deduce del navegador ni de la ubicación seleccionada.
- La sesión autenticada permite resolver la fecha desde el primer render,
  sin esperar a `/calendar` ni confundir su `location.timezone` con la global.
- `/calendar` conserva su contrato. Su fecha inicial predeterminada usa
  el tenant, no UTC; sus horarios y excepciones siguen siendo de sucursal.
- `/activities` ya incluía `location.timezone`: se conserva y utiliza en
  el tipo y las tarjetas frontend, sin cambiar el contrato backend de clases.
- Próximas/pasadas compara instantes absolutos `starts_at` con ahora.
  No existían grupos Hoy/Mañana: no se redefine esa semántica.
- El selector mensual de historial es global al miembro y multisucursal:
  sus límites son instantes del mes civil del gimnasio. Cada fila conserva
  fecha/hora de sucursal, con la zona visible para explicar posibles diferencias.

## Fallbacks y seguridad

`portalTime.ts` centraliza el default histórico `America/Guayaquil` para
metadatos de gimnasio ausentes (compatibilidad con sesiones antiguas).
0053 rechaza una zona de ubicación ausente: no se sustituye por la del gym.
La interfaz muestra explícitamente la falta de zona de sucursal.
No se cambian columnas, RLS, permisos, reservas ni timestamps históricos.

## Actualización

`useCurrentPortalDate` usa un único timeout en la siguiente frontera civil:
medianoche del gimnasio, o antes la de la sucursal para refrescar su horario.
La medianoche de sucursal no cambia el día global. La búsqueda de la frontera
es por fecha IANA, no suma fija de 24 horas (días DST de 23/25 horas).
Focus/visibility resincronizan; cleanup cancela timer y listeners.
Tenant/zona/sucursal reprograman sin polling ni reload. Las queries temporales
incluyen tenant y zona global; calendario incluye la ubicación.

El calendario solicita también los días adyacentes al mes para poder consultar
la fecha local de una sucursal situada al otro lado de la medianoche.
Semana, mes, membresía, fecha de peso y avisos no dependen de la zona del equipo.
Los cálculos sobre fechas civiles usan UTC solo como aritmética de calendario,
no como fuente de la fecha actual.

## Validación local

- Tests de zonas adelantadas/atrasadas, navegador diferente, año/mes/semana,
  medianoche gym/sucursal, cambios de tenant/sucursal, timers y DST.
- Componentes reales: membresía, fecha/max de peso y tarjetas de clase.
- Regresiones 008, 009, 010/011, 012, autenticación 006 y estados de espera.
- SQL 0053 ejecutado sin cambios en PostgreSQL embebido efímero:
  `node backend/tests/helpers/portal-timezone-sql-check.mjs <directorio-PGlite>`.
  Aplica migraciones locales hasta 0055, omite 0052 (pg_cron no disponible),
  ejecuta la prueba original 0053 y verifica ofertas desactivadas localmente.
- No hubo conexión ni escritura a Supabase remoto. No se activa FIT-MEMBER-005.

## Límites

Pendiente smoke test desplegado tras un futuro commit/despliegue autorizado.
No se valida aquí un cambio remoto de zona mientras una sesión ya abierta
conserva metadatos antiguos: `/auth/me` los renueva al refrescar la sesión.
El aviso preexistente de `activitiesBoundary.test.ts` sobre la ubicación del
texto de pago queda separado e intacto. Advertencias existentes de Vite sobre
chunks grandes/importación de jsPDF y de react-test-renderer no son fallos.
Sin commit ni push en esta fase.
