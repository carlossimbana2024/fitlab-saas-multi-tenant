# FIT-OWNER-005 — Reloj civil del Dashboard

Antes, las dos consultas de asistencia tomaban una fecha fija de Guayaquil, el resumen financiero calculaba su mes en la base pero se guardaba con una clave sin período y el navegador elegía la zona al mostrar actividad y avisos. Un gimnasio en Nueva York podía ver, a las `2026-11-01T04:30Z`, ingresos de noviembre y asistencias del 31 de octubre. Además, sin volver a renderizar o refetchear, un Dashboard abierto podía quedarse en el día o mes anterior.

## Autoridad y compatibilidad

- El Owner y el Staff usan `gymUser.gym.timezone` desde `/auth/me` (`gyms.timezone`). AuthContext conserva el objeto de sesión y lo reemplaza al recibir una actualización válida. La zona del dispositivo o del empleado no interviene.
- `gymTimezone` mantiene el fallback histórico `America/Guayaquil` solo si falta ese metadato o llega `null`, conforme a FIT-MEMBER-013. El alta del gimnasio valida las zonas que se configuran; no se introduce una sustitución silenciosa para una zona suministrada pero inválida. No se usa el fallback para zonas físicas de sucursal.
- Se reutiliza `useCurrentPortalDate` sin modificar el helper ni el Portal del Miembro. Calcula la próxima frontera civil IANA y programa un solo timeout, no un intervalo de 24 h. Se resincroniza en `focus` y en `visibilitychange` al volver a estar visible, incluso tras suspensión. Un cambio de zona cancela y reprograma el efecto; el desmontaje retira timer y listeners. Los días de 23 y 25 horas siguen teniendo su medianoche real.

## Consultas y presentación

| Función | Reloj y caché |
| --- | --- |
| Asistencias hoy | `/attendances/dashboard-summary?date=YYYY-MM-DD` usa el día civil vigente. Su clave distingue gimnasio, actor, fecha y zona. No cambia el `validTodayCount` exacto (FIT-OWNER-002). |
| Actividad reciente | `/attendances?from=…&to=…` recibe esa misma fecha en ambos filtros y tiene una clave propia por fecha, gimnasio, actor y zona. Los pagos existentes del feed no se vuelven a filtrar por día. |
| Ingresos del mes | La clave del resumen distingue gimnasio, actor, `YYYY-MM` y zona. No se envía un mes a la API: 0059 sigue siendo la autoridad para el período y los importes. No se muestra la respuesta de otro mes como actual. Si la respuesta no coincide, el KPI queda no disponible hasta una revalidación, que puede dispararse por foco/visibilidad sin esperar el `staleTime`. |
| Fechas visibles | Las horas de asistencia y pago del feed, y la fecha de publicación de los avisos, se formatean con la zona global del gimnasio. Los avisos mantienen sus destinatarios, límite, publicación y archivo. |

Las consultas temporales dejan de revalidar por foco la clave anterior mientras el reloj está cambiando de período. Las claves nuevas no reutilizan filas del día o mes anterior. Se mantiene el `staleTime` general (30 s), la cancelación de peticiones, el prefijo de invalidación ya existente y el manejo de PIN. No se agregó polling.

## Alcance deliberadamente excluido

Sin cambios en backend, Supabase, zonas de sucursal, horarios, clases, estado de apertura, racha legacy, conteo/historial de asistencia, RPC de ingresos, alcance del feed, rediseño de estados ni invalidaciones tras mutaciones. Un cambio remoto de zona solo se refleja en una pestaña cuando esta recibe la nueva sesión; no se añadió vigilancia de metadatos. Si el reloj del dispositivo difiere del del servidor al cruzar de mes, la verificación de período evita mostrar el total equivocado, pero no corrige ese desfase. Prueba desplegada pendiente; esta fase es local.
