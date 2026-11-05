# FIT-MEMBER-014 — integración final local

PostgreSQL 0056 es la única autoridad. Se retiraron el conversor experimental y
branchOpenNow. No se modificaron 0053/0056 en esta fase. El usuario confirmó su
aplicación y verificación remotas; no se accedió a Supabase desde esta sesión.

GET /api/calendar/open-status?locationId=UUID usa verifyJWT y tenantContext.
Solo miembro; actor/gym provienen del tenant. RPC valida acceso y sucursal activa
del gimnasio. No se pasa requested_at: SQL usa su reloj. Cache-Control no-store.

Inicio monta BranchOpenStatus con clave gym/miembro/sucursal. Distingue loading,
abierto, cerrado y error con reintento. Se eliminó el aviso local de cierre
semanal que podía contradecir overnight. No calcula apertura ni DST en React.

Un timeout al mínimo de nextTransitionAt/revalidateAt/validUntil consulta solo
esta query. Sin setInterval/polling. Focus/visibility revalidan y deduplican eventos
pareados. Cambio de sucursal/desmontaje elimina timeout/listeners; Axios recibe
AbortSignal. No reutiliza datos de otra sucursal. Error no instala timer;
permite recuperación al volver o pulsar Reintentar. Respuesta vencida falla sin
bucle de reintentos, incluso con reloj del dispositivo muy adelantado.

Validación: endpoint/scheduler, React real, regresiones 008/012/013, SQL 0053/0056
y Ecuador (23 estados y 9 transiciones exactas). Fixtures exclusivamente locales.
La verificación remota separada es read-only. Datos IANA de producción mandan.

Límites: cambios de horario de otro usuario con pestaña visible se conocen en
la próxima transición/revalidación o focus; no hay realtime. Pendiente smoke
test tras despliegue autorizado. Sin commit/push ni activación FIT-MEMBER-005.
