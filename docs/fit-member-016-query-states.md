# FIT-MEMBER-016 — errores no son vacíos ni ceros

## Auditoría localizada previa y clasificación

| Consumidor | Hallazgo | Corrección / decisión |
| --- | --- | --- |
| Inicio membresía | Error inicial acababa en Sin membresía/Sin cobertura | Separar ausencia de respuesta y respuesta vacía; mantener cobertura anterior con aviso |
| Inicio racha | undefined producía 0/Mejor racha 0 | Loader/error antes de respuesta; [] exitoso sí representa cero |
| Inicio resumen canónico | Ya diferenciaba error inicial; descartaba valor previo en error de refetch | Mantener total anterior con aviso localizado |
| Inicio meta semanal | Selector podía sintetizar completadas=0 mientras fallaba su consulta | No calcular aviso de faltantes sin respuesta semanal |
| Clases/próximas/historial | Error inicial ya era distinto del vacío; refetch fallido ocultaba filas válidas | Conservar snapshot con aviso; retry de la query afectada |
| Progreso | Calendario podía asumir días cerrados por query ausente; historial de asistencia se convertía en vacío; meta semanal asumía cero/plan diario | Ocultar solo bloque sin datos; error por dependencia, sin inventar cobertura/visitas |
| Progreso peso | Durante loading podía verse historial vacío y sin objetivo; refetch error ocultaba todo | Loading inicial sin falso vacío; mantener extremos/objetivo/histórico anteriores |
| Perfil/Configuración | Perfil ausente por error parecía encuesta sin completar y consentimientos falsos | Gating de datos deportivos, sin bloquear cuenta y demás consultas independientes |
| Comunidad/rankings | Error inicial y paginación ya estaban diferenciados (008) | Mensaje simple y retry; conservar páginas/podio; mantener cursores e invalidación 015 |
| Membresía/pagos | Error inicial ya estaba tratado; refetch ocultaba recibos válidos | Conservar recibos/solicitudes con aviso; otros pagos independiente |
| Perfil social/amistades/toques/logros/contacto | Errores iniciales existentes sin retry en algunos casos; refetch ocultaba datos | Feedback por query, conservar snapshot, no convertir fallo en unavailable/false |
| QR | Ya conserva preview ante mutación fallida, muestra error y permite reintentar | Preservado y cubierto con test adicional; no se cambió la operación |
| branch-open-status | Ya distingue error vs cerrado | Sin cambios (014) |

## Fallbacks conservados deliberadamente

- `data ?? []` en selectores/iteraciones no es por sí mismo un error: su salida
  solo se muestra cuando la dependencia ya tiene respuesta. El error/carga se
  presenta antes del bloque dependiente.
- Cero después de respuesta exitosa (incluido streaks=[]), privacidad false,
  fitnessProfile=null y ausencia real de cobertura siguen siendo datos válidos.
- Escalas de gráficas con mínimos cero/uno son geometría visual, no datos inventados.
- No se cambió el contrato canónico de peso, baseline, extremos ni métrica mensual.

## Implementación y seguridad de alcance

QueryFeedback presenta loading/error/retry por recurso. `undefined` identifica
ausencia de respuesta previa, no null/[]/0. Un refetch fallido muestra un aviso
explícito de última información disponible, sin borrar caché ni fabricar valores.
Los mensajes de lectura no muestran RPC/500 técnicos. Retry usa refetch; no reload.
Comunidad conserva su retry de página y su reinicio manual explícito existentes.
No hay nuevas invalidaciones globales ni cambios en helper/eventos de 015.

Sin backend productivo, SQL, configuración, Supabase remoto ni activación 005.
No se tocaron las incidencias previas activityReferences/activitiesBoundary.
Sin felicitación por alcanzar objetivo; sin cambios de diseño ni reglas económicas.

## Pruebas

memberQueryStates: A–N con QueryClient y render React reales, carga pendiente,
cero/vacío exitoso vs error, dependencias parciales, retry, snapshot previo, recibos,
cursores y páginas tras fallo de cargar más. authSessionLifecycle incluye mutación
QR fallida sin asistencia falsa. memberAggregatesUi adapta expectativas al mensaje
accesible conservando la regresión 008/014/015 completa.
Pendiente smoke manual tras futura publicación autorizada.

Validación final: 142 tests aprobados en 9 archivos, incluidas regresiones UI
008, 010/011, 012/013, 014, 015, clases y lifecycle Auth/QR. Frontend typecheck
y build OK. Solo advertencias previas de react-test-renderer, bundle y jsPDF.
No se ejecutaron SQL ni suites de controladores backend; el runner de tests
frontend existente reside en backend/tests. git diff --check sin errores.

Inventario de esta fase:
- frontend/src/pages/MemberPortalPage.tsx
- frontend/src/pages/MemberCommunityPage.tsx
- frontend/src/pages/MemberPaymentsPage.tsx
- frontend/src/components/QueryFeedback.tsx (nuevo)
- frontend/src/components/MemberSocialProfile.tsx
- frontend/src/components/MemberFriendships.tsx
- frontend/src/components/MemberTrainingSocial.tsx
- frontend/src/components/LoyaltyRewards.tsx
- frontend/src/components/LoyaltyEngagement.tsx
- frontend/src/components/GymContactCard.tsx
- backend/tests/memberQueryStates.test.ts (nuevo)
- backend/tests/memberAggregatesUi.test.ts
- backend/tests/authSessionLifecycle.test.ts
- docs/fit-member-016-query-states.md (nuevo)
