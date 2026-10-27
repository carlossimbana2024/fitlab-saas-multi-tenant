# FIT-MEMBER-005 — Ofertas temporales FIFO

Estado: el usuario confirmó la aplicación de 0051/0052 y sus pruebas/verificación en Supabase: política apagada, ventana de 30 minutos, un único cron inactivo, sin inconsistencias ni errores. Integración HTTP/frontend completada y validada localmente; pendiente de despliegue y pruebas reales de staging. No se activa el motor ni se modifica 001–004.

## Modelo y despliegue por etapas

`0051_class_waitlist_offers.sql` conserva `class_waitlists` y su enum para mantener las firmas de las RPC. Añade `outcome` y el estado generado `state` para distinguir aceptación y rechazo. El índice único parcial impide dos entradas activas del mismo miembro/sesión, pero permite nuevos episodios después de abandonar, rechazar o expirar. No se recicla la fila anterior.

`class_waitlist_offers` conserva cada oferta, sus fechas, su resultado y la reserva aceptada. Una oferta no congela condiciones económicas. El estado interno `accepting` solo existe dentro de una transacción: una comprobación diferida impide que se confirme así.

`private.class_waitlist_policy` centraliza `offer_window = 30 minutes` y `offers_enabled = false`. El motor se mantiene inactivo mientras se instala SQL y se prepara la interfaz. Se activará mediante una acción explícita después de desplegar los botones y endpoints. La prueba SQL activa el motor exclusivamente dentro de su transacción y lo revierte al terminar.

`0052_class_waitlist_cron.sql` habilita `pg_cron` y registra `fitlab-class-waitlist-offers` con frecuencia de un minuto, **INACTIVO**. `cron.schedule` y `cron.alter_job(active:=false)` están en la misma transacción: no hay un estado activo intermedio visible al scheduler. Ejecutar como `postgres`, siempre con el mismo propietario. Si existe un job homónimo de otro propietario o falta soporte de `alter_job`, la migración falla y revierte; no activar manualmente como alternativa. Repetir 0052 deja un único trabajo inactivo y no cambia otros jobs. Es SQL nativo, sin navegador, HTTP ni secretos nuevos.

Dos barreras: flag apagado y cron inactivo. Secuencia obligatoria: migraciones → backend → frontend → pruebas desplegadas → activar flag → activar cron. Incluso si se invoca accidentalmente el procesador, flag falso **o fila de política ausente** devuelve cero sin procesar sesiones, emitir/expirar ofertas ni escribir diagnósticos.

No activar ofertas entre esta migración y el despliegue de la integración: la interfaz anterior todavía no permite aceptarlas. Desactivar arbitrariamente el motor después de activarlo tampoco equivale a una reversión segura con ofertas en curso.

## Reglas del motor activo

- Orden persistente `(joined_at,id)`, sin decidir prioridad en React.
- Ocupación real: reservas `reserved`/`attended`, igual que en FIT-MEMBER-003.
- Disponibilidad: `max(0, capacidad - ocupación real - ofertas vigentes)`.
- El procesador bloquea la sesión, vuelve a comprobar actividad/sucursal y asigna como máximo los cupos libres. Si quedan tres cupos, puede crear tres ofertas FIFO.
- Una oferta vence en el menor valor entre su emisión más la ventana configurada y el inicio de la clase menos un microsegundo. `clock_timestamp()` valida el tiempo real tras adquirir bloqueos.
- La cancelación/liberación de una reserva y los cambios de sesión llaman al procesador. También se reconcilia antes de reservar/aceptar/consultar, y mediante cron. Los cambios de actividad/sucursal son revalidados por esas operaciones y por el worker; no generan nuevas reservas cuando están inactivos.
- Una reducción de capacidad revoca las ofertas más recientes y devuelve esas entradas a espera conservando su prioridad. Conserva la oferta revocada como historial. Una ampliación puede volver a ofrecerles cupo.
- Rechazo y expiración pierden el turno y avanzan la cola. Volver a entrar requiere un acto explícito y crea otro episodio.
- Miembros que pierden elegibilidad no bloquean la cola al llegar su turno; ofertas de miembros que dejan de cumplirla se cancelan.
- Las reservas directas, incluso en recepción, pasan por un trigger que protege los cupos ofrecidos. Quien ya tiene una oferta debe aceptarla por la RPC, no reservar por un camino alternativo.
- La aceptación utiliza `reserve_member_class_backend`; los triggers de 0050 capturan modalidad/importe/moneda vigentes al contratar. No se genera pago automático. Recepción cobra luego desde ese snapshot.

Las ofertas antiguas que solo tenían la etiqueta `offered` carecen de vencimiento verificable. Se cierran como `expired`/`legacy_expired`, conservando la fecha anterior y la transición en auditoría. No se inventa una vigencia nueva ni se cambia una reserva, un pago o un snapshot existente.

## RPC e integración posterior

- `join_class_waitlist_backend`: firma compatible, ahora admite actividades adicionales, devuelve posición SQL y crea episodios nuevos.
- `leave_class_waitlist_backend`: abandonar una oferta equivale a rechazarla; avanza al siguiente. Repetir la salida de un episodio terminado conserva su resultado.
- `accept_class_waitlist_offer_backend`: solo para el miembro dueño de la oferta. Aceptar dos veces devuelve la misma reserva. Errores funcionales después de reconciliar devuelven `{accepted:false,code:...}` para **conservar** la expiración y la oferta siguiente. La API debe convertir ese resultado en un conflicto HTTP y refrescar la consulta, no tratarlo como éxito ni lanzar un rollback SQL.
- `get_class_waitlist_state_backend`: devuelve `server_time`, capacidad, ocupación, cupos ofrecidos, disponibilidad y `myWaitlist.position`/`offer_id`/`expires_at` desde SQL. El miembro solo recibe sus propias entradas; personal con permisos de reservas puede recibir la cola; coaches quedan restringidos a sus sesiones y no reciben la cola de participantes.
- `process_class_waitlists_backend`: worker exclusivo del backend/cron, por lotes y con `SKIP LOCKED`. Prioriza ofertas vencidas y rota las demás sesiones para evitar que una cola llena bloquee las otras. Registra el último error de procesamiento en `private.class_waitlist_runs`.

No se concede acceso de miembros a las tablas de ofertas ni ejecución directa de estas RPC. Las mutaciones se realizan por RPC privilegiada después de la autenticación del backend. La fecha de expiración del servidor es la autoridad del contador visual.

### Integración HTTP y portal (sin activar ofertas)

`GET /activities` consulta `get_class_waitlist_state_backend` con gimnasio, actor y las sesiones autorizadas, antes de cargar reservas/condiciones. Sustituye los conteos HEAD por COUNT(*) dentro de la RPC, igualmente exactos e independientes del límite de filas de PostgREST. No vuelve a calcular posición/disponibilidad en Express. Un resultado ausente, incompleto o malformado produce error explícito, nunca cola vacía o cupos inventados. Devuelve `serverTime`, `offersEnabled`, `offeredCount` por sesión y la entrada propia con posición y oferta. Los miembros conservan el filtro de sus propias reservas y no reciben participantes ajenos.

Entrar/salir usan las RPC existentes. `POST /activities/waitlist/offers/:id/accept-self` usa exclusivamente `accept_class_waitlist_offer_backend`; la identidad procede del tenant autenticado. Rechazar usa `PATCH /activities/waitlist/:id/cancel-self`: SQL diferencia una salida de una oferta rechazada y conserva el historial. Los resultados funcionales `accepted=false` se convierten a error HTTP después de que la RPC haya confirmado su reconciliación; no se deshace la expiración ni se crea una reserva alternativa. Los conflictos de transacción `40P01`/`40001` piden refrescar/reintentar explícitamente; no hay repetición automática de mutaciones.

El portal conserva ClassCard y añade la oferta dentro del diseño existente. Distingue cupos, espera/posición, oferta y acciones aceptar/rechazar. Las clases adicionales llenas también permiten espera: ninguna espera congela el precio; la contratación solo se crea al aceptar. Tras toda acción, incluso conflicto, se invalidan `my-activities` (Inicio/Clases/historial), `activities` y `activity-summary`. El propietario utiliza el mismo refresco. La hora del servidor y tiempo monotónico transcurrido alimentan un contador aproximado: no decide la expiración ni altera estados. Se consulta otra vez al llegar visualmente a cero. Ofertas activas consultan cada 30 segundos y espera cada 60, solo con motor habilitado y en Inicio/Clases visibles, sin polling en segundo plano. Errores de consulta se muestran separados de una lista realmente vacía.

## Validación preparada

`supabase/tests/0051_class_waitlist_offers.sql` usa gimnasios y miembros aislados, activa el motor dentro de la transacción y termina con ROLLBACK. Cubre entrada, duplicados, desempate por ID, posiciones, salida, oferta FIFO, rechazo, reentrada, expiración, aceptación repetida, protección contra reservas directas, varias plazas, reducción/ampliación de capacidad, referencias inactivas, sesión iniciada/cancelada, pérdida de elegibilidad, privacidad y snapshot de clase adicional.

El helper `backend/tests/helpers/class-waitlist-sql-check.mjs` aplica 0001–0050, crea una cola real anterior a 0051 y verifica preservación de reservas/pagos/condiciones e importación de ofertas antiguas. Aplica 0051 dos veces, ejecuta también 0048–0050 con el motor activo y comprueba el registro idempotente del cron usando un stub local. Ese stub **no prueba la ejecución real de pg_cron**.

Las pruebas locales usan una conexión PostgreSQL embebida. Las carreras de dos conexiones independientes deben comprobarse en una base aislada en la siguiente fase; no se presentan como ya ejecutadas. Casos concretos:

1. Dos sesiones llaman simultáneamente a aceptación de la misma oferta. A mantiene abierta su transacción tras aceptar; B debe esperar y devolver `already_accepted=true` al confirmar A. Una reserva y una contratación.
2. A acepta la última oferta y mantiene la transacción abierta; B intenta una reserva directa con otro miembro. Tras confirmar A, B debe fallar por cupo/cupo ofrecido. Nunca exceder capacidad.
3. Dos ofertas, luego capacidad reducida a uno. La oferta posterior debe quedar revocada y solo la prioritaria puede aceptarse.
4. Dos workers simultáneos: el segundo omite las sesiones bloqueadas y no crea otra oferta para una entrada ya ofrecida.

5. Dos cancelaciones simultáneas de reservas distintas de la misma sesión: liberar como máximo dos plazas y ofrecerlas en orden FIFO sin duplicados. Ante `40P01`/`40001`, verificar rollback y reintento explícito después de actualizar el estado, nunca repetir automáticamente una petición cuyo resultado sea incierto.

### Resultado de validación de la integración

- `npm test -- tests/memberPrivacy.test.ts tests/activityReferences.test.ts tests/activityCapacity.test.ts tests/activityEconomics.test.ts tests/activityWaitlist.test.ts tests/classWaitlistRendering.test.ts` (en backend): **120/120**. Incluye 25 pruebas nuevas de frontera API y 22 de componentes/utilidades. Regresiones anteriores conservan sus comprobaciones de privacidad, referencias, 1501 participantes/row cap y precios históricos; sus mocks reflejan ahora la RPC instalada.
- `node backend/tests/helpers/class-waitlist-sql-check.mjs <instalación-local-pglite>`: pasan 0048, 0049, 0050 y 0051, idempotencia, importación no destructiva y fallo/recuperación del procesador. Solo base embebida aislada, sin credenciales ni conexión remota.
- Backend `npm run typecheck` / `npm run build`: OK. Frontend `npm run typecheck` / `npm run build`: OK; advertencias ya existentes de importación jsPDF y tamaño de bundle, sin nuevos errores.
- No hay `psql`, `pg_ctl`, `initdb` ni Docker de pruebas disponibles en este entorno. No se instalaron ni se usaron credenciales remotas. Las pruebas multiconexión indicadas arriba y las pruebas de navegador/dispositivos sobre despliegue integrado quedan pendientes.
- No se cambiaron las migraciones ya aplicadas en esta fase. No se activó política/cron, no se hizo commit/push, no se inició FIT-MEMBER-006 y README/documentación ajena permanece intacta. No considerar lista la activación hasta validar staging, retención de cron y operación con volumen representativo.

## Verificación remota y reversión

Aplicar 0051, luego 0052, ejecutar la prueba 0051 completa y el archivo de solo lectura `0051_class_waitlist_offers_verify.sql`. Antes de integrar la aplicación debe seguir apareciendo `offers_enabled=false`, con ventana de 30 minutos y un único cron **inactivo**. Un trabajo nuevo no debe registrar ejecuciones. La prueba activa la política solo dentro de su transacción, sobre fixtures aislados, y termina con ROLLBACK; el único llamado global usa la política apagada.

Si una migración falla antes de COMMIT, revierte su transacción. Tras aplicarla no hay rollback destructivo preparado: conservar ofertas/episodios y retirar el trabajo o reemplazar funciones requiere un cambio controlado, especialmente cuando ya existen ofertas aceptadas. El usuario confirmó su ejecución remota; el agente no ejecutó consultas ni activaciones remotas. La activación del motor queda para después de integrar, desplegar y validar la aplicación.

## Revisión previa de seguridad y operación

- Inventario comprobado: 5 RPC públicas y 14 auxiliares privadas. Todas SECURITY DEFINER con `search_path=pg_catalog,public` y referencias de tablas calificadas. PUBLIC/anon/authenticated no ejecutan ninguna; service_role ejecuta solo las 5 RPC, no auxiliares. El propietario PostgreSQL ejecuta triggers y el cron. La identidad del actor debe proceder del backend autenticado, no del cuerpo de la petición. El worker global es deliberadamente administrativo.
- ACL verificadas contra `pg_proc`/`aclexplode`/`has_function_privilege`, incluyendo PUBLIC. Pruebas de propiedad de oferta/miembro y gimnasio cruzado permanecen activas. 0052 no añade funciones privilegiadas propias permanentes.
- Fallo de una sesión: el bloque EXCEPTION revierte sus escrituras, continúa las otras sesiones y registra solamente SQLSTATE, ID de sesión y fecha; nunca SQLERRM potencialmente sensible. Prueba local con fallo inyectado después de insertar una oferta confirma rollback, avance de otra cola, recuperación posterior y ausencia de `accepting` persistido. Un timeout/cancelación del job revierte toda su transacción; no deja ofertas parciales.
- Índices revisados: índice existente sesión/estado/joined_at; índice parcial FIFO sesión/joined_at/id; unicidad parcial sesión/miembro; ofertas activas por entrada y sesión/miembro; ofertas por sesión/estado y por expires_at/sesión. No se agregaron índices en esta revisión. El worker ordena las sesiones con colas activas para rotarlas: el límite del lote no hace constante el coste de selección. Se requiere EXPLAIN/medición con volumen representativo antes de activar a escala.
- Concurrencia revisada en SQL: mutex de sesión, lecturas de capacidad tras bloqueo, claims internos y unicidad; segunda aceptación devuelve la misma reserva; workers usan SKIP LOCKED. Reservas de recepción pasan por el mismo guard. Cancelaciones simultáneas serializan la promoción; rollback de una transacción no consume cupos. Las RPC anteriores pueden tomar primero bloqueo de reserva: ante un deadlock PostgreSQL aborta una transacción, por lo que no hay escritura parcial, pero debe verificarse/reintentarse de forma controlada en integración. Todavía no se ejecutaron carreras de conexiones independientes. Mantener las dos barreras hasta validarlas.

### Retención propuesta (no instalada ni activada)

Conservar 14 días de `cron.job_run_details`: unas 20.160 filas de este job por ejecución cada minuto, más el día entre limpiezas. Añadir al activar producción un único mantenimiento diario que elimine **solo registros terminados** de los job IDs de este procesador y del propio mantenimiento, con `end_time < now() - interval '14 days'`. No borrar logs de otros jobs ni ejecuciones aún activas. Un mantenimiento separado merece la pena: limpia incluso si el procesador falla y no acopla la retención a su transacción. No se crea ahora para mantener cron completamente inactivo. Activar el motor requiere dejar instalada esta retención y supervisar ejecuciones sin `end_time` tras reinicios.

Referencia oficial: [pg_cron: alter_job y monitorización/retención](https://github.com/citusdata/pg_cron). El historial no se limpia automáticamente. El stub local valida el SQL de registro, no la versión remota de la extensión ni el scheduler.
