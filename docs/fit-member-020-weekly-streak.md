# FIT-MEMBER-020 — Racha semanal personal

Estado: integración local completa. 0057 aplicada en producción según el verify compartido (4 miembros, 0 por revisar, 0 períodos ambiguos). 0058 aplicada manualmente según confirmación del usuario; verificación remota de solo lectura pendiente. Sin commit/push.

## Integración de Inicio, Progreso, Comunidad y perfil

- Inicio muestra la racha semanal como principal; la diaria es secundaria. Progreso usa las mismas cifras junto a la meta semanal e incluye el récord diario. El contrato de `GET /members/me/streaks` devuelve semanal actual/récord/estado y diaria actual/récord, con unidades explícitas. El backend obtiene el resultado de `get_member_personal_streaks_backend` (0057), con el gimnasio y miembro autenticados. No usa fechas enviadas por el navegador.
- La consulta `['my-personal-streaks', gymId, memberId, today, timezone]` usa la fecha civil del gimnasio para renovar caché al cambiar el día; no calcula la racha. El check-in confirmado reutiliza la invalidación de asistencia de FIT-MEMBER-015, acotada al miembro y gimnasio; no hay suma optimista ni invalidación global.
- `not_evaluable` se muestra como «No aplicable actualmente» sin presentar el valor congelado como actual; el récord histórico se conserva. `needs_review` se muestra como «No disponible», sin explicar la revisión internamente ni sustituir el resultado por cero. Un fallo de red preserva la última respuesta válida del mismo día y ofrece reintento. La consulta independiente permite que el resto del resumen siga disponible.
- Perfil social y Comunidad solo exponen la semanal con el permiso existente `show_streak`; para terceros también exigen `show_in_community`, gimnasio y cuenta de miembro elegibles. El titular conserva acceso a su propio perfil. La diaria no se agrega a las superficies sociales.
- El filtro «Mejores rachas semanales» necesita el RPC aditivo de 0058, `list_member_community_weekly_page_backend`: el RPC anterior ordenaba por un contador mixto. El nuevo ordena toda la población elegible por récord semanal antes de paginar; mantiene desempate por nombre/ID, filtros, y cursor ligado a gimnasio, lector, día civil y versión. Para los demás filtros solo calcula rachas de la página devuelta. El ranking mensual sigue llamando a `get_member_community_rankings_backend`: días calendario consecutivos dentro del mes, sin cambio.
- Inicio deja de consultar `/attendances/streaks`; Progreso y su mensaje de motivación dejan de leer contadores mixtos. Las tarjetas y perfiles sociales no consumen `currentStreak`, `longestStreak` ni los equivalentes legacy. Se mantienen las columnas, el cron anterior y los consumidores operativos: dashboard administrativo, recepción y ficha administrativa del miembro. No se reinterpretan como días o semanas nuevos.

**Antes de desplegar:** ejecutar únicamente `supabase/tests/0058_member_community_weekly_streaks_verify.sql` en el SQL Editor de producción y revisar el resultado. No reaplicar 0057/0058 ni ejecutar preflight o fixtures. El verificador abre una transacción de solo lectura, compara los cuerpos de los tres RPC con las versiones esperadas, verifica permisos efectivos y contrasta hasta dos páginas del filtro semanal con las métricas canónicas. También comprueba que el filtro general conserva su orden y lee la configuración y el cron de FIT-MEMBER-005. Solo devuelve firmas, indicadores y conteos. Si la muestra no tiene miembros elegibles o no permite una segunda página, el resultado no sustituye la prueba local de 360 miembros.

Tras verificar, desplegar backend/frontend coordinadamente. La migración solo agrega un RPC, no reescribe datos, no cambia el ranking mensual ni toca FIT-MEMBER-005. El filtro semanal evalúa el historial de toda la población que consiente en compartir, por lo que conviene medir su latencia en gimnasios de mayor tamaño. Los cursores previos a 0058 requieren iniciar desde la primera página.

La prueba de 0058 corre exclusivamente en PostgreSQL en memoria con `run-member-streaks-local.mjs <ruta a pglite/dist/index.js> --community-only`; no ejecuta el preflight ni las pruebas 0057. Comprueba el récord semanal fuera de la primera página, 360 miembros en 18 páginas, permisos, privacidad, gimnasio, cursor y ranking mensual independiente.

Validación de esta fase: 312 tests TypeScript aprobados en 20 archivos, incluyendo check-in real en el arnés React, privacidad, errores con y sin caché y cambio de fecha del gimnasio sin recarga. Typecheck/build de frontend y backend aprobados. La prueba SQL local confirmó `offers_enabled=false`; no se ejecutó el scheduler ni se consultó el estado remoto.

## Checkpoint histórico 0057 — decisiones y validación previa

La fase inicial preparó el motor canónico sin cambiar sus consumidores. A continuación se conservan las decisiones y pruebas de ese checkpoint; el estado de integración y despliegue vigente está arriba.

### Evidencia histórica y limitaciones

El modelo permite distinguir los casos **parcialmente**:

- `membership_periods`: fechas civiles, estado, `membership_id`, `payment_id`.
- `memberships`: snapshot de modalidad/meta y `cancelled_at`.
- `member_payments`: estado, `voided_at`, `refunded_at`, razones de reversión.
- `audit_logs`: `membership.cancelled`, estado anterior, `history_preserved=true`, `payments_unchanged=true` y timestamp coherente con el contrato. Se exige estado anterior activo/pausado/vencido; cancelar un contrato pendiente no demuestra cobertura legítima.
- `weekly_attendance_progress.target_attendances`: evidencia de conflicto con el snapshot actual; un conflicto no se resuelve sobrescribiendo la meta antigua.

**0025 sintetizó metadatos históricos de cancelación/reembolso. Un timestamp aislado, una razón libre, `cancelled`, `voided` o `refunded` no demuestran intención retroactiva.** Los eventos de reversión financiera existentes no distinguen devolución comercial de invalidez originaria. Por eso una reversión sin resolución explícita permanece ambigua, incluso si también hubo cancelación administrativa.

No se consultó producción: **cantidad real de períodos ambiguos desconocida**, no cero. `0057_member_streaks_preflight.sql` permite obtener cantidades e IDs sin mutar datos, antes de aplicar 0057. La verificación posterior informa miembros afectados e IDs. No incluye nombres, teléfonos ni razones financieras privadas.

### Regla semanal y cancelaciones

- Lunes–domingo, usando `gyms.timezone`; solo semanas cerradas. Meta histórica del contrato, no encuesta ni catálogo actual. Se cuentan fechas válidas elegibles del contrato, una por día.
- Semana completa con la misma meta/contrato: `met` si asistencias >= meta; `missed` si no. `missed` reinicia actual, conserva récord.
- Inicio parcial, cambio contractual/meta o cancelación durante la semana: `grace`, sin incremento ni incumplimiento parcial.
- Cancelación administrativa auditada: conserva semanas completas anteriores; la fecha civil de cancelación deja de estar cubierta para la evaluación. Las semanas posteriores no se evalúan.
- Plan diario o intervalo sin cobertura: evaluación semanal detenida. El contador previo puede mostrarse como histórico congelado, con `weeklyStatus=not_evaluable`; cuando vuelve cobertura semanal, actual empieza desde cero, récord permanece.
- Reembolso comercial: solo conserva cobertura con evidencia explícita de legitimidad y fecha efectiva de fin. Anulación retroactiva explícita excluye esa cobertura y reconstruye también el récord.
- Ambigüedad: excluye el período de la reconstrucción automática y devuelve **ambas métricas semanales null + `needs_review`**. No presenta un récord incompleto como definitivo ni cero como resultado confirmado. La métrica diaria independiente sigue disponible.

### Representación e idempotencia

Se elige **reconstrucción lazy SQL de solo lectura**, no cuatro contadores materializados que puedan quedar desactualizados. Cuatro campos explícitos de RPC: `weeklyCurrentStreak`, `weeklyBestStreak`, `dailyCurrentStreak`, `dailyBestStreak`. `user_streaks` y su cron antiguo se conservan por compatibilidad con consumidores fuera de esta fase; sus valores mixtos NO se usan como fuente del nuevo cálculo.

Nueva tabla privada `member_streak_coverage_resolutions`: `period_id`, `disposition` (`legitimate` / `retroactively_invalid`), `effective_end_on`, `evidence_reference`, `recorded_by`, `recorded_at`. Empieza vacía. No hay permisos directos para anon/authenticated/service_role ni RPC que permita inventar resoluciones. Una resolución legítima exige una fecha de fin explícita. La resolución exige revisión administrativa basada en evidencia; no se genera automáticamente ni por regex de razones.

No se agregan columnas a tablas existentes ni se copian contadores. El “backfill” es una reconstrucción en lectura desde toda la historia, no un UPDATE masivo. **Filas históricas modificadas por la migración: 0. Filas de resoluciones insertadas automáticamente: 0.** Repetir la RPC no suma nuevamente: recomputa resultados. No depende de ejecutar un cron exactamente a medianoche. No crea cron, no introduce polling ni modifica FIT-MEMBER-005.

La racha diaria deduplica `attendance_date` de registros `valid` hasta hoy: fechas civiles ya validadas en la timezone del gimnasio por las reglas de asistencia. Hoy sin asistencia no rompe hasta que el día termina; ayer válido conserva la racha. Cambios de mes/año no la reinician. Si una asistencia pasa a `voided`, deja de contar y el récord se reconstruye. La reversión financiera existente cancela cobertura, pero NO invalida por sí sola asistencias históricas: 0057 no cambia esa regla ni convierte filas anuladas en válidas.

### Alcance de seguridad y compatibilidad

La nueva RPC pública ejecutable solo por backend valida gimnasio/miembro activo/portal mediante `require_member_aggregate_reader`. Funciones internas sin EXECUTE directo de clientes ni service_role; `SECURITY DEFINER` con search_path fijo. Sin reescribir ranking mensual, filtros, orden o cursor de Comunidad. Los endpoints existentes permanecen intactos en este checkpoint, incluidos los de FIT-MEMBER-008/009/012/013/015/016/019.


### Archivos y validación local

- Migración: `supabase/migrations/0057_member_personal_streaks.sql`.
- Prueba pura SW/D/H: `supabase/tests/0057_member_personal_streaks.sql`.
- Evidencia en arnés contractual reducido: `0057_member_streak_evidence.sql`; exclusivamente mediante el runner, NO contra el esquema productivo.
- Integración esquema completo: `0057_member_streak_full_schema.sql`, incluyendo cancelación por RPC real con 3 semanas históricas preservadas. Siembra histórica sintética en entorno aislado; triggers restaurados antes de invocar RPCs.
- Verify remoto **read-only**: `0057_member_personal_streaks_verify.sql`.
- Preflight **read-only** anterior a migración: `0057_member_streaks_preflight.sql`.
- Runner local: `run-member-streaks-local.mjs <ruta absoluta a pglite/dist/index.js> [--full-schema]`. Sin URL, credenciales ni conexión externa. El modo completo aplica migraciones del repositorio en memoria; sustituye únicamente el entorno Auth/Storage de Supabase por tablas de prueba y omite 0052 porque WASM no ejecuta pg_cron. No prueba scheduler real.
- Tests TypeScript: `backend/tests/memberPersonalStreaks.test.ts`; prepara el límite RPC y el formateo de unidades, no afirma que las pantallas existentes ya consuman el motor nuevo.

Resultados: 132 pruebas TypeScript en 8 archivos aprobadas (17 nuevas); pruebas SQL pura, evidencia contractual e integración con esquema completo aprobadas. Regresión SQL 0054 aprobada (>10000 asistencias, 360 candidatos, filtros, ganadores, privacidad, tenants, cursor y ACL); 0056 y Ecuador (23 comparaciones / 9 transiciones) aprobadas. Backend y frontend typecheck/build OK. Warnings existentes de jspdf/chunks grandes, sin error de build.

### Aplicación manual / límites

0057 y su verificación ya fueron ejecutadas manualmente; 0058 también se reportó aplicada. El único SQL pendiente en producción es la consulta de verificación de solo lectura descrita arriba.

Riesgos pendientes: confirmar 0058 en producción, medir el costo de reconstrucción por historial largo y validar el despliegue coordinado. Si aparecen históricos ambiguos, el estado `needs_review` sigue vigente: no se infieren metas históricas editadas sin rastro.

## Mapa del comportamiento actual

| Campo / consumidor | Fuente | Período y condición | Unidad real | Presentación |
| --- | --- | --- | --- | --- |
| Racha actual y mejor racha — Inicio / Progreso | `user_streaks.current_streak` y `longest_streak`; Inicio usa `/attendances/streaks`, Progreso `/members/me/progress` | Histórico acumulado. El motor SQL incrementa por cada día obligatorio cubierto con asistencia elegible en modo `daily`; en modo `weekly`, al cerrar el domingo cubierto, incrementa si `goal_met` y no hay gracia. Un incumplimiento evaluado reinicia la actual; el récord conserva el máximo. | Incrementos de dos unidades en las mismas columnas, sin discriminador | «Racha actual», «Mejor racha», números sin unidad. Algunos mensajes motivacionales de Progreso hablan de días. |
| Racha actual y récord — Comunidad / Perfil | La misma tabla; `list_member_community_page_backend` (0055) aplica privacidad, ordena «Rachas más largas» por `longest_streak` antes de paginar. El perfil social lee la tabla si el permiso lo permite. | Mismo acumulado histórico | La misma mezcla | Las tarjetas y el encabezado del perfil dicen «días de racha»; la tarjeta no indica unidad en el récord. |
| Meta semanal — Progreso / aviso de Inicio | `weekly_attendance_progress` y `selectCurrentWeeklyProgress` (FIT-MEMBER-009) | Lunes a domingo; una fila por contrato y semana. `goal_met` se genera con `completed_attendances >= target_attendances`. | Asistencias elegibles dentro de una semana; no es una racha | «N de M», «Meta completada» o «Semana de gracia». |
| Mayor racha del mes — Top 3 | `get_member_community_rankings_backend` (0054) | Máximo tramo de fechas calendario consecutivas con asistencia válida dentro del mes, hasta hoy para el mes actual. No lee `user_streaks`, ni exige meta semanal ni `counts_toward_streak`. | Días consecutivos | «Mayor racha del mes», «N días consecutivos». Es una métrica distinta. |
| Asistencias válidas — Inicio / Progreso | `get_member_attendance_summary_backend` (0054) | Cuenta registros válidos; totales, mes y semana tienen sus períodos propios. No exige meta ni `counts_toward_streak`. | Asistencias | «Asistencias válidas», «Esta semana», etc. |

Por tanto, `currentStreak = 3` es **D: tres incrementos acumulados**, no necesariamente tres días calendario consecutivos ni tres semanas. Por ejemplo, la rama semanal de `run_streak_evaluation` toma el valor anterior del mismo contador y le suma 1: dos incrementos diarios más un cierre semanal que cumple producen 3. El campo `longest_streak` tiene el mismo problema. Una ausencia en día no obligatorio no rompe la racha diaria; el modo diario no exige fechas calendario consecutivas.

## Fuente canónica y cierre de semana

- FIT-MEMBER-009 toma el contrato activo con período activo que cubra la fecha civil del gimnasio. Selecciona la fila exacta por `membership_id` y semana; si no existe, representa 0 asistencias con el `weekly_target_snapshot` válido del contrato, sin escribir en la base. Un contrato diario, sin cobertura o sin meta válida no tiene objetivo semanal calculable; no se toma la frecuencia de la encuesta ni se inventa un valor.
- En SQL la meta se toma del snapshot del contrato asociado a la asistencia y se copia en `target_attendances`. La fila cuenta asistencias `valid` y `counts_toward_streak` de ese contrato. Un cambio de precio o meta del catálogo no se usa para recalcular la fila histórica. Una renovación que conserva el ID conserva su progreso semanal; un contrato nuevo tiene su propio snapshot y no hereda el progreso del anterior. La evidencia histórica por contrato existe; el contador agregado no distingue unidades.
- La semana es civil, de lunes a domingo según `gyms.timezone`, no la zona del navegador. El motor semanal no cambia la racha durante la semana abierta: se procesa el domingo una vez concluido. En una semana normal con meta 3, 3 o 4 cumplen y 2 no; dos cierres consecutivos cumplidos producen 2 si se parte de cero y no hay incrementos diarios. El siguiente cierre evaluable fallido pone la actual en 0 y deja el récord intacto. Un miércoles con 2/3 no reinicia la racha previa.
- Hoy un período que empieza de martes a domingo puede marcar la semana como gracia. El motor no suma ni reinicia esa semana, incluso si `goal_met` es verdadero. Un domingo sin un período activo que lo cubra no entra en la evaluación semanal. Sin cobertura, la lógica de estado puede congelar el contador histórico sin borrarlo. Esto no equivale a un cero semanal válido.
- FIT-MEMBER-012/013 actualiza `my-progress` y `my-weekly-progress` en la frontera civil sin polling. La consulta de racha de Inicio `my-streak` no está ligada a esa fecha. Además, el cierre persistido depende del cron actual: Express propone la fecha anterior en `America/Guayaquil` y SQL comprueba que esa fecha ya terminó para el gimnasio. No es una garantía de actualización en el primer instante del lunes de cada zona.

## Diagnóstico inicial — decisiones ya resueltas arriba

1. Un cambio de contrato de meta 2 a meta 4 a mitad de semana puede generar dos filas para la misma semana, con metas y asistencias distintas. No existe una regla general de racha semanal personal que elija una sola meta de producto para esa semana. El cron toma un contrato con cobertura el domingo y aplica la excepción de gracia; no combina ni vuelve a puntuar las semanas anteriores con la meta nueva. Confirmar si se conserva esa gracia, incluso si la meta se cumple, y se aplica la meta del nuevo contrato desde la siguiente semana completa. Las semanas anteriores conservarían su propia meta.
2. Confirmar qué pasa con la continuidad al pasar a un plan diario o quedar sin meta/cobertura: no se suma ni se asigna una meta ficticia. Falta decidir si, al volver a un plan semanal, la racha se reanuda tras el intervalo o comienza de nuevo. El récord debe representar solo semanas; los incrementos diarios no son semanas recuperables del contador.

La definición objetivo es que una semana evaluable sume una sola vez si alcanza la meta canónica de esa semana. Inicio, Progreso, tarjetas y perfil social deben mostrar la misma unidad («0 semanas», «1 semana», «2 semanas»), sin reemplazar un fallo por cero. El Top 3 diario mensual, las rachas compartidas y los retos de fidelización son reglas independientes, no se convierten cambiando su etiqueta.

No basta un ajuste de copy ni recomputar una página de Comunidad en frontend: `longest_streak` participa en el orden y en el cursor de su RPC. Para mantener privacidad, población completa y paginación de FIT-MEMBER-008, una solución que mantenga esa arquitectura necesita aprobación para ajustar el cálculo/lectura SQL y los consumidores en conjunto. No se ha determinado que haga falta una columna nueva o reescribir datos históricos. No se ha ejecutado SQL ni tocado cron, Supabase o FIT-MEMBER-005.

Referencias de código: `supabase/migrations/0005_attendance_classes_streaks.sql` (`goal_met`), `0010_streak_engine.sql` (`process_attendance_streak_change`, `run_streak_evaluation`), `0012_fix_streak_status_enum.sql` (estado de cobertura), `0054_member_aggregates_pagination.sql` (ranking) y `0055_member_weight_goal_metric.sql` (listado social), `frontend/src/utils/currentWeeklyProgress.ts` y `frontend/src/utils/currentPortalDate.ts`.
