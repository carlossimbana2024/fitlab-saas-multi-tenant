# FIT-MEMBER-018 — Días restantes de membresía

## Mapa de la investigación (antes de corregir)

| Vista / endpoint | Fuente | Zona para «hoy» | Fórmula / regla anterior | Texto anterior |
| --- | --- | --- | --- | --- |
| Inicio: tarjeta y aviso | `GET /memberships`, `membership_periods` | `gyms.timezone` de sesión; la selección podía tomar `today` de `/members/me/progress`, mientras el aviso y el contador usaban el reloj civil local del portal | `fin − hoy` sobre fechas UTC normalizadas | `N días restantes` (incluido `1 días`), `Vigente hasta hoy`, `Cobertura vencida`, aviso para 1–5 días |
| Membresía y pagos | `GET /membership-payment-requests/me`, `memberships[].membership_periods` | `gym.timezone` de esa respuesta; se reevaluaba al renderizar, sin un aviso propio de medianoche | `max(0, fin − hoy + 1)` sin distinguir si el período ya comenzó | `N días de cobertura restantes` incluso para un período futuro o vencido, además del estado |
| Perfil / Configuración / Progreso / Comunidad | Perfil, objetivo semanal, actividad y estadísticas | Según la vista; no cuentan días de membresía | No aplicaba | No muestran días restantes |
| Check-in QR | Vista previa de asistencia, devuelve `membership.ends_on` | `gyms.timezone` en la RPC | Valida membresía y período activos con `today between starts_on and ends_on` | `Cobertura hasta YYYY-MM-DD`; no hay contador |
| `GET /memberships` y `GET /membership-payment-requests/me` | Fechas `date` y estados persistidos | No calculan «hoy» para la cobertura | No devuelven `daysRemaining` | No generan texto |

La diferencia de un día era determinista: el 5 de noviembre, con fecha final 26 de noviembre, Inicio mostraba 21 y Pagos 22. Facturación de la suscripción SaaS, recepción/owner, temporizadores de ofertas y otras fechas de promociones no son el contador de membresía del miembro.

## Semántica y fuente canónica

- `ends_on` es **inclusivo**. El check-in de `0032_static_attendance_qr.sql` y la validación de asistencias de `0015_attendance_opening_hours.sql` usan `BETWEEN`. `0025_membership_renewal_receipts.sql` inicia una cobertura sucesiva en `last_coverage_end + 1` y calcula el final restando un día a la duración. Por tanto, `starts_on = ends_on` representa un día completo, siempre que la cobertura esté activa.
- Inicio y Pagos usan la misma fecha civil: `gymUser.gym.timezone` (`gyms.timezone` vía `/auth/me`, FIT-MEMBER-013) y el fallback ya centralizado en `gymTimezone` si falta el dato. No usan la zona del equipo, la de sucursal, la del historial de pagos ni una respuesta de Progreso para el contador. El formulario de comprobante conserva la fecha del gimnasio que devuelve su endpoint.
- `summarizeMembershipCoverage`, en `frontend/src/utils/membershipCoverage.ts`, reutiliza la selección vigente → próxima → última. Solo para mostrar cobertura, puede incluir historial de una membresía `expired` o indicar `paused`; no cambia la selección utilizada por Clases o Progreso. No atribuye cobertura activa a períodos cancelados ni concede acceso a partir de un texto.
- Para cobertura vigente, la diferencia es `ordinalCivil(ends_on) − ordinalCivil(hoy)`: UTC se usa solo para numerar las dos fechas, no para medir 24 horas transcurridas desde el reloj local. Si faltan datos no se fabrica un cero. En DST, las medianoches pueden distar 23 o 25 horas y seguir siendo un día civil.

| Situación | Resultado en Inicio y Pagos |
| --- | --- |
| Quedan 2 o más días civiles | `N días restantes` |
| Mañana es la última fecha cubierta | `1 día restante` |
| Hoy es la última fecha cubierta | `Vence hoy`, con cobertura durante ese día |
| Pasó la última fecha cubierta, o la membresía ya está `expired` | `Cobertura vencida`, sin contador |
| Todavía no comienza | `Comienza el YYYY-MM-DD`, sin contador |
| Membresía `paused` | `Membresía pausada`, sin contador |
| Ausencia confirmada o carga inicial fallida | `Sin cobertura vigente` si la ausencia es real; si falla la API, aviso y reintento sin simular ausencia ni mostrar días |

La tarjeta de Inicio, su aviso de vencimiento y el resumen de Pagos consumen el mismo helper. En Inicio se conserva el aviso para los últimos cinco días y se incluye `Tu membresía vence hoy.` El recordatorio es visual, no envía notificaciones.

## Rollover, caché y límites

Se reutiliza `useCurrentPortalDate` (FIT-MEMBER-012): un timeout en la siguiente medianoche civil, con resincronización al recuperar foco/visibilidad. El cambio de fecha reevalúa los datos cargados sin invalidar ni recargar la página. Las consultas de cobertura se revalidan al volver a montar o enfocar la vista, incluso dentro del `staleTime` global; no se agrega polling ni invalidación global. Pagos conserva su intervalo existente y la invalidación `paymentRequest` (FIT-MEMBER-015). Si falla un refresco, FIT-MEMBER-016 mantiene los datos previos con aviso de error.

Las vistas conservan sus endpoints existentes. Si se actualiza la membresía en otro dispositivo, la vista recibe los datos nuevos al revalidar; no hay sincronización en tiempo real. Si cambia la zona del gimnasio durante una sesión ya abierta, se aplica cuando se refrescan sus metadatos de autenticación, igual que en FIT-MEMBER-013. No se modificaron backend, Supabase, contratos, pagos, reservas ni FIT-MEMBER-005. Queda pendiente la prueba visual desplegada tras una publicación autorizada.
