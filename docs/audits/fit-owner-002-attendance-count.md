# FIT-OWNER-002 — Conteo exacto de asistencias del Dashboard

**Regla funcional.** «Asistencias hoy» cuenta las filas de `attendances` con `status = 'valid'` para el día civil solicitado y el gimnasio de la sesión, incluidas todas sus sucursales. No consulta membresías, reservas ni rachas, y excluye registros anulados. La restricción de una asistencia válida por miembro y fecha sigue en el índice existente `attendances_one_valid_per_day_idx`.

## Causa y corrección

`GET /attendances?from=…&to=…` ordena por `checked_in_at` descendente y devuelve hasta 200 filas, incluidas válidas y anuladas. El Dashboard aplicaba el filtro de válidas sobre esa respuesta ya truncada. Con 201 válidas solo podía presentar 200; con 200 válidas y cinco anuladas recientes podía mostrar 195.

El KPI ahora consume `GET /attendances/dashboard-summary?date=YYYY-MM-DD` y lee `validTodayCount`. El backend filtra por `gym_id`, `attendance_date` y `status`, y usa un conteo exacto mediante `HEAD`, sin descargar filas ni limitar el total. Por ejemplo, 201, 500 y 501 válidas producen esos valores exactos; 200 válidas más cinco anuladas producen 200, y 50 anuladas sin válidas producen 0.

El historial de 200 filas conserva su contrato y se usa únicamente para la actividad reciente del Dashboard. Recepción y sus reglas de registro/anulación, QR, otros KPIs y rachas no cambian. El Dashboard envía al agregado la misma fecha civil que ya calculaba en `America/Guayaquil` para el historial; el backend usa esa fecha sin convertirla desde o hacia UTC. La unificación temporal del Dashboard queda para FIT-OWNER-005.

## Aislamiento y caché

La nueva ruta conserva `verifyJWT` y `tenantContext`. El conteo usa el cliente autenticado por el JWT (RLS), con filtro explícito por el gimnasio resuelto para el actor. No toma el gimnasio ni la sucursal del navegador. Conforme a la política existente `attendances_select`, el owner y el staff con `members.view = allowed` tienen visibilidad sobre todo el gimnasio. Si el actor solo puede leer filas propias, no se devuelve ese subconjunto como si fuera el total: se rechaza el agregado sin abrir una nueva solicitud de PIN. La respuesta no se almacena en cachés HTTP compartidas.

La consulta del KPI usa una clave específica por gimnasio, actor y fecha. Una operación de registro manual o anulación exitosa desde Recepción invalida los resúmenes del gimnasio actual, sin invalidación global. Un QR registrado en otra sesión se refleja en la siguiente consulta del Dashboard; no se añadió sincronización en tiempo real. El KPI muestra `…` mientras carga y «No disponible» ante un fallo, sin sustituirlo por cero ni por el historial.

## Archivos

- `backend/src/controllers/attendance.controller.ts`, `backend/src/routes/attendance.routes.ts`, `backend/src/validators/attendance.validator.ts`: conteo, acceso y validación del día.
- `frontend/src/pages/DashboardPage.tsx`, `frontend/src/pages/AttendancesPage.tsx`: consumo e invalidación acotada.
- `backend/tests/dashboardAttendanceSummary.test.ts`: conteo, fecha, permisos, varias sedes, tenants y preservación de la regla de asistencia válida única.
- `backend/tests/dashboardActiveMembersUi.test.ts`: regresión del Dashboard, nueva lectura, carga/error e invalidación tras registrar y anular.

No requiere migraciones, cambios de políticas ni índices nuevos.
