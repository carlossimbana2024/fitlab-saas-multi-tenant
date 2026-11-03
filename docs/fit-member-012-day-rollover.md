# FIT-MEMBER-012 — cambio de día con el Portal del Miembro abierto

`MemberPortalPage` calculaba `monthRange` solo al montar. Esa fecha se
usaba para el horario y los avisos de Inicio, los días restantes de cobertura,
el rango y el resaltado del calendario de Progreso, el mes inicial del
historial de clases y las fechas por defecto/máxima al registrar peso.
Las comparaciones de inicio de clases ya usaban la hora actual al renderizar:
no se cambia su regla; ahora el cambio de día provoca un render y una consulta
nueva del rango móvil de próximas clases.

El hook publica una fecha únicamente si cambia. Mantiene un timeout hasta el
siguiente cambio de fecha en `America/Guayaquil`, y vuelve a comprobar al
recuperar foco o visibilidad. Al desmontar elimina el timeout y los listeners.
El borrador del formulario de peso y un mes de historial elegido manualmente
se conservan; el mes del historial sigue al calendario si no se ha elegido uno.

- Resumen canónico (`my-progress`), progreso semanal y próximas clases se
  consultan con una clave nueva al cambiar el día. Las invalidaciones existentes
  por prefijo siguen cubriendo esas claves al guardar o reservar.
- El calendario y el historial por defecto cambian de clave solo al cambiar de
  mes. El historial de un mes fijo conserva su filtro.
- La asistencia de hoy y los acumulados diarios/semanales/mensuales siguen
  viniendo del resumen del servidor. La selección semanal sigue priorizando
  `progress.today`, con el mismo fallback de fecha del portal mientras no
  haya resumen. No se recalculan agregados a partir del historial.

## Límite de alcance

La fecha del calendario del portal sigue siendo Guayaquil. El resumen usa la
zona del gimnasio; la hora de apertura usa la zona de sucursal cuando está
disponible y algunas etiquetas de clase se formatean en la zona del navegador.
Si las medianoches no coinciden, la actualización programada del resumen puede
no coincidir con la medianoche del gimnasio. Unificar esas fuentes queda para
FIT-MEMBER-013. No se añade sondeo de hora ni se modifica Supabase.

## Incidencia separada (preexistente)

`activitiesBoundary.test.ts` busca «Pago pendiente en recepción» directamente
en `MemberPortalPage.tsx`, aunque el texto ya vive en `classBookingEconomics.ts`.
La prueba queda sin modificar; su actualización no forma parte de FIT-MEMBER-012.
