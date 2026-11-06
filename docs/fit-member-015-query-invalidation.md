# FIT-MEMBER-015 — mapa previo de dependencias

Alcance: mutaciones del miembro y sus consumidores React Query; sin backend/SQL.
Mapa obtenido de las queries, controladores y contratos existentes antes de editar.

| Mutación confirmada | Datos que cambia | Consumidores a reconciliar |
| --- | --- | --- |
| Registrar peso (upsert por fecha; no DELETE del miembro) | Histórico, extremos, métrica histórica/mensual | my-progress (Inicio/Progreso/actividad Perfil), member-social-profile, member-community, member-community-rankings |
| Guardar encuesta/objetivo | Objetivo vigente, preferencias deportivas, mensaje; consentimiento solo al crear | my-fitness-profile, my-progress, perfil social, Comunidad (incluido filtro similar_goal), rankings |
| PATCH de una preferencia | Visibilidad/elegibilidad de métricas | my-fitness-profile, perfil social, Comunidad, rankings, amistad y entrenamiento social |
| Nombre/contacto o avatar | profiles y representaciones públicas | auth refresh (cabecera), perfil social, Comunidad, rankings (nombre/foto) |
| Bio/galería/showGallery/showBadges | Perfil social; no métrica de ranking | perfil social, Comunidad |
| Me encanta | Reacción propia/contador | Comunidad y perfil social; no rankings (reacción no es criterio SQL) |
| QR confirmado (cámara externa e interna comparten flujo) | Asistencia válida, rachas y metas | my-attendances, my-streak, my-weekly-progress, my-progress, perfil social, Comunidad, rankings, loyalty-engagement, member-training-social |
| Reservar/cancelar/esperar/salir/aceptar oferta | Sesión/cupos/reserva/oferta propia | my-activities upcoming (Inicio y Clases) e history; no asistencias generales ni ranking |
| Solicitud de pago submit/cancel | Solicitud; no activa cobertura ni confirma ingreso | my-membership-payments; preparar/subir fallido solo puede dejar borrador de solicitud |
| Preferencias/acciones amistad o toques | Relación, disponibilidad, avisos | member-friends/member-friendship/member-training-social/loyalty-engagement según acción |

## Contratos que condicionan la solución

- Comunidad: InfiniteQuery con clave [member-community,gym,actor,filtro]. Cambios de
  población/orden/visibilidad reinician cursor y páginas del contexto actual;
  no se mezclan páginas antiguas con una nueva primera página.
- Reacción devuelve targetMemberUserId/reactionType/reacted, NO un contador total.
  Se prioriza reconciliación autoritativa frente a sumar/restar sobre caché obsoleta.
  InfiniteQuery reconsulta secuencialmente usando cursores nuevos, sin reload del sitio.
- Ranking: clave [member-community-rankings,gym,actor,mes]; invalidar únicamente
  ese contexto mantiene separados meses y devuelve cálculo SQL (sin calcular en React).
- Progreso: [my-progress,gym,actor,día,timezone]; clases: gym en posición 4.
- Keys personales legacy sin tenant explícito están aisladas por AuthProvider:
  login/logout/expiración cancelan queries y limpian caché. No se rediseña Auth.
- Estado branch-open-status NO depende de ninguna mutación de esta tabla.
- Conflictos de clase/oferta pueden indicar estado desactualizado: reconciliación
  limitada en onError para códigos concretos; no aviso ni caché de éxito fingido.
- El guardado de cuenta puede guardar nombre antes de que falle cambio de contraseña:
  reconciliar tras PUT de perfil confirmado, no esperar el éxito de ambos PUT.

Sin optimistic updates nuevos, sin invalidación global, sin activación 005.

## Implementación

`memberQueryInvalidation.ts` concentra dependencias de writes confirmados y filtros
de contexto. No se renombraron keys por estética. Progreso conserva sus extremos
exactos y métrica SQL; los consentimientos siguen siendo PATCH individuales.
Cuenta/avatar ahora invalidan también las representaciones de nombre/foto en
Comunidad y ranking. Privacidad ahora alcanza rankings. Las mutaciones sociales
ya no refrescan por errores genéricos. Clases solo refresca recursos del miembro,
sin tocar consultas administrativas ni branch-open-status.

Pagos: tras prepare confirmado puede quedar borrador aunque falle upload/submit;
ese caso reconcilia únicamente la bandeja personal de solicitudes. Fallar antes
de prepare no invalida nada; submit/cancel no invalidan cobertura, ingresos o
rachas pues todavía no son pagos aprobados. Proof es solo lectura.

## Validaciones y límites

Tests usan QueryClient/InfiniteQueryObserver reales y mutaciones de componentes
React: keys incluidas/excluidas, otros tenants, meses/filtros, peso/objetivo,
PATCH privacidad, reacción, reserva/cancelación/espera/oferta, error genérico vs
conflicto concreto, reinicio de cursor y descarte de página tardía.
Las métricas siguen viniendo del servidor, sin optimistic updates nuevos.

Incidencias previas fuera del alcance:
- activitiesBoundary.test.ts: ubicación del texto de pago (ya registrada).
- activityReferences.test.ts: 9 casos del arnés de render fallan porque no
  inyecta formatBranchInstant. El bloque extraído de componentes es idéntico
  al de HEAD; no se cambió ese arnés ni los componentes dentro de 015.

Validación desplegada/manual pendiente después de autorización de publicación.
No se accedió a Supabase, no hubo SQL, commit/push ni avance a 016.

Validación final local: 275 pruebas aprobadas en 16 archivos (015, Progreso,
Comunidad/008, peso/010–011, privacidad, clases/economía/waitlist, QR, amistades,
pagos y ciclo Auth). Frontend typecheck/build OK. Advertencias previas de jsPDF,
tamaño del bundle y deprecación react-test-renderer; sin cambios backend productivo.
Los nueve casos preexistentes de render de activityReferences no forman parte de
esa ejecución final aprobada; su bloque de componentes se comparó con HEAD sin diferencias.
