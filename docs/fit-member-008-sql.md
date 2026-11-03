# FIT-MEMBER-008 — SQL aplicado por el usuario, consumidores integrados localmente

## Alcance y despliegue

Migración aditiva `0054_member_aggregates_pagination.sql`, aplicada y verificada por
el usuario. El 2026-11-02 se integraron sus consumidores localmente, sin cambiar
el SQL aplicado ni las barreras de FIT-MEMBER-005. Sin commit, push o despliegue.

## Integración de consumidores (2026-11-02)

- `/members/me/progress` consulta el resumen SQL y conserva los datos de peso y
  rachas existentes. Inicio y Progreso consumen sus mismos totales; el listado
  `/attendances` permanece para historial/calendario, nunca para calcular totales.
- `/members/me/community` devuelve `{items,nextCursor,hasMore}` y firma únicamente
  las fotos de la página consentidas por SQL. Página20/máximo50, filtros validados,
  cursor JSON limitado a4096 caracteres, identidad exclusivamente de tenantContext.
- React usa infinite query y botón Cargar más. Claves con gimnasio, miembro y
  filtro; al cambiar filtro elimina sus páginas previas. Los miembros se deduplican
  por ID para evitar tarjetas repetidas si cambian datos durante el recorrido.
- Rankings delegados completamente a la RPC; Express solo añade etiquetas,
  selector de periodos y URLs firmadas. Query key incluye contexto y mes, sin
  placeholder de resultados del mes anterior.
- RPC nula/malformada provoca502, no ceros ni listas vacías. Fallos de página
  permiten reintentar o reiniciar lista; fallos de resumen tienen estado explícito.
- Se conserva goalProgress porque memberSocialProfile.controller todavía lo usa.
  Se eliminaron los conteos y rankings truncados sustituidos, no reglas de peso.
- Verificación de llamadas con componentes React reales y API interceptada:
  Comunidad solicita páginas20/cursor; ranking un endpoint por periodo. Pruebas
  de controladores comprueban que no se descargan tablas completas para esas RPC.
  No se ejecutó smoke test contra la aplicación desplegada: estos cambios son locales.

Validación: 220 pruebas relacionadas aprobadas en16 archivos, más3 casos nuevos
de error/reinicio de UI; typecheck/build backend y frontend correctos. Advertencias
de build: tamaño de bundle e importación mixta de jsPDF; tests usan el renderer
React existente, que emite aviso de obsolescencia. Sin repetir volumen SQL.

En Supabase SQL Editor ejecutar **solo**:

1. `supabase/migrations/0054_member_aggregates_pagination.sql` completo.
2. `supabase/tests/0054_member_aggregates_verify.sql` completo.

Esperar el resultado `0054 OK`, `offers_enabled=false`, ventana `00:30:00` y
el cron `fitlab-class-waitlist-offers` con `active=false`. Las consultas no
activan nada. El editor puede mostrar solamente el último resultado: ejecutar
por separado los SELECT si se necesitan capturas de cada resultado.

**No ejecutar en Supabase** `supabase/tests/0054_member_aggregates_pagination.sql`:
es una prueba de estrés exclusivamente local. Su guardia rechaza la ejecución
fuera del runner. No eliminar la guardia ni establecer su bandera remotamente.
El runner crea una base PGlite efímera, sin URL ni credenciales, y omite 0052
porque pg_cron no está disponible. Para sembrar historia sintética deshabilita
temporalmente triggers mediante session_replication_role, restaurándolo antes
de probar las RPC. No es una prueba del proceso de escritura de asistencias.
Todos los fixtures se revierten.

## Contratos backend-only

Las tres RPC reciben `target_gym_id` y `actor_member_user_id`. El futuro backend
los obtiene de tenantContext/sesión autenticada, nunca confía en IDs enviados
libremente por el cliente. SQL exige que el actor sea miembro activo, portal y del
gimnasio indicado. service_role es una credencial confiable del backend, no del
navegador. Se reutilizan los endpoints existentes.

### get_member_attendance_summary_backend(uuid, uuid)

JSON: today, currentWeekStart, currentMonthStart, totalAttendances,
currentMonthAttendances, currentWeekAttendances, latestAttendanceDate,
hasAttendanceToday, attendanceByMonth[{period,count}],
attendanceByWeek[{period,count}], averageWeeklyAttendances.

Fuente canónica para Inicio y Progreso. Solo status=valid, todas las sucursales y
membresías del propio miembro/gimnasio, sin exigir vigencia actual de la membresía.
Se conserva total histórico sin corte de fecha, mes completo, semana lunes-hoy,
seis meses y ocho semanas de gráficas (intervalos completos), promedio semanal
redondeado a una cifra. Fecha local del gimnasio. No sustituye el historial ni el
calendario; no devuelve filas históricas. Etiquetas traducidas quedan al consumidor.

### list_member_community_page_backend(uuid, uuid, text='all', integer=20, jsonb=null)

Retorna `{items,nextCursor,hasMore}`. Máximo50, mínimo1; rechaza tamaño inválido.
Filtros: all, similar_goal, consistent, new, longest_streak, featured, progress.
Similar_goal filtra antes de paginar; los demás conservan su criterio de orden.
Excluye al lector, inactivos, cuentas no portal y show_in_community=false.

Items: id, name, avatarPath, goalType, publicMessage, joinedAt, currentStreak,
longestStreak, monthlyAttendances, progressPercent, reactions{like,love,mine}.
Campos sujetos a consentimiento se devuelven null cuando están ocultos.
avatarPath no es una URL firmada: el backend debe firmar solo las fotos consentidas
de esa página. No se devuelven peso, altura, email o teléfono.

Cursor keyset JSON opaco para el cliente, ligado a gimnasio, lector, filtro y
fecha local. Orden: puntuación descendente, nombre COLLATE "C" ascendente y UUID
ascendente. Se sustituyen empates ambiguos por ese orden reproducible; la colación
de nombres acentuados puede diferir del localeCompare('es') anterior. Reacciones y
métricas de presentación se agregan solo para los integrantes de la página; cuando
una métrica ordena, necesariamente se calcula sobre todos los elegibles.

Cursor no firmado: no concede acceso ni cambia la población elegible. Alterarlo
puede saltar posiciones de la propia lista, no obtener otro tenant. No se mantienen
snapshots entre peticiones: si cambia puntuación, nombre o consentimiento durante
el recorrido, reiniciar desde la primera página para obtener la vista actual.
Sin cambios de datos, las pruebas garantizan un recorrido sin omisiones/duplicados.
En la integración futura filtros y cursores deben formar parte de query keys;
reiniciar páginas al cambiar filtro/fecha o refrescar datos.

### get_member_community_rankings_backend(uuid, uuid, date=null)

Fecha opcional: primer día del mes, no futuro. Devuelve
`{from,to,categories:{attendance:[],streak:[],progress:[]}}`.
Cada entrada: memberUserId,name,value,position,avatarPath,goalType.
Incluye al lector si es elegible. Filtra población/consentimientos en SQL antes
de calcular sobre todos los candidatos. Solo puntuaciones positivas, Top3 por
categoría. Empates: valor desc, nombre C asc, UUID asc. Mes actual hasta hoy.
Asistencia: válidas del mes; racha: días consecutivos distintos dentro del mes,
no el user_streaks histórico. Peso mensual: última medida anterior al mes o primera
del mes como base; última medida del mes como final. Conserva fórmula mensual
existente, distinta de progreso all-time de Comunidad. FIT-MEMBER-010 pendiente.

## Seguridad, índices, rendimiento

3 RPC públicas SECURITY DEFINER STABLE con search_path=pg_catalog,public;
EXECUTE solo service_role (además del propietario). 3 helpers privados sin EXECUTE
para anon/authenticated/service_role. Sin cambios a RLS o privilegios de tablas.

Índices revisados en migraciones locales (no se inspeccionó el catálogo remoto):
- attendances_one_valid_per_day_idx: miembro/fecha valid, agregados personales.
- attendances_community_ranking_idx y attendances_gym_date_idx: gimnasio/periodo.
- member_weight_entries_member_date_idx y unique(gym_id,member_user_id,measured_on): endpoints de peso.
- member_weight_entries_community_ranking_idx: periodos.
- únicos fitness/social/streak y PK profiles/gym_users: joins.
- índice de reacciones por gimnasio/destinatario/tipo: agregados de página.

No se añade índice redundante. Las lecturas SQL exactas sí crecen con el volumen
real: se evita truncar resultados, no se promete coste constante. Ranking agrega
el periodo; peso usa búsquedas de extremos indexables; páginas ordenadas por métrica
calculan la puntuación de todos los elegibles. Sin N+1 de red. Validar EXPLAIN ANALYZE
en staging con distribución real antes de integrar consumidores a gran escala.

## Validación local

Comando (ruta de dependencia externa, no incorporada al proyecto):
`node backend/tests/helpers/member-aggregates-sql-check.mjs <directorio-@electric-sql/pglite>`

Aplica migraciones hasta0054 excepto0052; repite0054. Ejecuta regresión SQL0048,
estrés0054 y verificación de permisos0054 (omite SELECT de cron en PGlite).
Casos: 201 y2001 válidas, anulada excluida, mes/semana/gráficas/hoy, más de10000
asistencias, 360 miembros y siete filtros, nombres/puntuaciones empatados,
ganador fuera de250 en las tres categorías, privacidad global y por métrica,
inactivo/otro gimnasio, cursor incompatible, máximo de página y ACL.
No representa concurrencia multi-conexión ni benchmark de Supabase remoto.

Resultado local 2026-10-30: doble aplicación0054 OK; SQL0048 OK; SQL0054 OK;
verificación de seguridad OK y offers_enabled=false. Prueba de estrés completa
~1.7s después de ANALYZE de fixtures (solo referencia local). Además 16 pruebas
Vitest aprobadas: communityRanking, memberCommunityRankingBoundary y memberPrivacy.
No se ejecutó toda la suite ni builds: no hay cambios en código de aplicación.

FIT-MEMBER-011 queda expresamente pendiente: Progreso sigue leyendo hasta500
mediciones de peso; esta fase no modifica ese consumidor ni corrige su bug.

## Reversión y riesgo

No hay backfill, UPDATE, DELETE ni ALTER TABLE. Los contratos anteriores quedan
intactos. Riesgo principal: coste de consultas y futura integración incorrecta,
no modificación de datos. Reversible mediante otra migración controlada que quite
primero las tres RPC y después los tres helpers, sin CASCADE; únicamente si ningún
consumidor nuevo depende de ellos. No revertir ni borrar historial de migraciones.
