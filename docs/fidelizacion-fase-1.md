# Fidelización — fase 1

## Alcance implementado

- Owner: `/loyalty`, enlace **Fidelización**. Crear/editar borradores, publicar, pausar, reanudar y cerrar promociones. Inspeccionar los retos de un miembro (incluidos miembros sin portal), reclamar su recompensa, entregar productos o revocar un premio disponible con motivo.
- Miembro: acceso **Retos y recompensas** desde Inicio, ruta `/portal/rewards`. Condiciones, cupos, fechas, barras de avance y premios propios. Reclama su premio al alcanzar la meta; el owner lo canjea. No hay pagos en el portal del miembro.
- Reglas: cantidad de días, mejor racha de días obligatorios o asistencia perfecta durante el período. Una asistencia general válida por día; las clases extra no cuentan otra vez. La campaña pertenece a una sucursal. Para dos meses perfectos, seleccionar el período completo de ambos meses.
- Premios: descuento de 1–99% en una renovación, 1–3 meses gratuitos o 1–10 unidades de un producto existente. Cupos de 1–10.000. Una recompensa por campaña y miembro. Una recompensa por renovación, no acumulable.
- Cobros normales mantienen su flujo y firma SQL previa. Descuentos usan el precio vigente, redondeado a centavos; el recibo muestra precio, descuento e importe cobrado. Los meses gratuitos amplían cobertura, sin pago/recibo monetario ni ingresos inventados. Los productos generan un ajuste negativo de stock, no una venta.

## Reglas y decisiones

1. Publicar congela condiciones y calendario. No se permiten fechas iniciales pasadas. Cambios posteriores del horario no modifican la meta ya prometida. Para cambiar condiciones, crear otra campaña; no borrar historial.
2. Asistencia perfecta usa todos los días `required` del período; días `bonus` o cerrados no son obligatorios. La racha usa el mejor tramo consecutivo de esos días. La regla por cantidad cuenta también asistencias generales válidas en días adicionales.
3. Los cupos se asignan al reclamar, no por orden de asistencia. Esto se muestra al miembro. No existe reserva anticipada de inventario: el owner debe mantener stock suficiente; una entrega sin stock falla sin consumir el premio.
4. Reclamar es explícito (miembro u owner), no depende de cron ni genera notificaciones externas. La campaña debe estar activa. Después de terminar el período, se puede reclamar hasta la fecha límite con las asistencias del período.
5. Pausar o cerrar impide nuevas reclamaciones, pero no invalida premios emitidos. Una revocación exige motivo. Premios vencidos/revocados no liberan el cupo ni pueden emitirse otra vez.
6. La fecha de vencimiento es inclusiva en la zona horaria del gimnasio. El canje revalida actividad del miembro, pertenencia, premio, fecha, asistencia y tipo de operación. Un miembro nuevo a mitad de un período perfecto normalmente no podrá completar los días previos: conviene ofrecer también metas alcanzables de cantidad.
7. Las renovaciones aplican a una membresía existente y a la sucursal de la promoción (en la interfaz, sucursal predeterminada del owner). Extienden desde el fin de cobertura o desde hoy si ya venció. No modifican períodos pagados anteriores.
8. Anular/reembolsar un pago no reabre el premio consumido. Las anulaciones posteriores de asistencia tampoco revierten automáticamente una entrega ya realizada: el historial permanece para revisión del owner.

## Seguridad

- Middleware existente `verifyJWT` y `tenantContext`, incluida la restricción de escritura por suscripción SaaS. Administración y canje exclusivos del owner; el personal no puede elevarse mediante PIN para canjear premios.
- Actor/gimnasio derivados exclusivamente de sesión. Las rutas de miembro no aceptan identidades de destino; SQL valida de nuevo cada referencia y rol. Nunca se aceptan importes, avance o descuentos calculados por el cliente.
- RLS y sin privilegios directos para `anon`/`authenticated` en tablas/RPC nuevas. Solo backend `service_role`; funciones con `search_path` fijo. Referencias multi-tenant, snapshots protegidos y auditoría transaccional.
- Bloqueo de campaña para asignar cupos; unicidad campaña/miembro. Bloqueo del premio y unicidad de canje para evitar duplicados. El canje bloquea las asistencias válidas mientras verifica elegibilidad; los flujos existentes bloquean membresía e inventario. No se usa un contador confiado al navegador.
- Límite de solicitudes en mutaciones, UUID y entradas validados, React escapa textos. Respuestas propias de progreso con `Cache-Control: no-store`.
- Limitación existente: un QR estático por sí solo no demuestra presencia física. Este bloque reutiliza las asistencias válidas actuales y permite revisión/revocación; no promete eliminar fraude de presencia.

## Base de datos y despliegue

Ejecutar **primero**, completo, `supabase/migrations/0039_loyalty_rewards.sql` en Supabase. Es una única transacción con `lock_timeout=5s`. Si otra operación mantiene bloqueos, esperar a que termine y reintentar; no matar sesiones indiscriminadamente.

Después ejecutar `supabase/tests/0039_loyalty_rewards.sql`: fixtures con rollback, sin desactivar RLS ni triggers. El test no conserva gimnasios, pagos, asistencias ni productos de prueba.

Tablas nuevas: `gym_promotions`, `member_rewards`, `reward_redemptions`. Índices por gimnasio y miembro, restricciones únicas y referencias tenant-scoped. `membership_periods` incorpora `original_amount`, `discount_amount`, `reward_id`, con backfill compatible para períodos existentes. No hay Firestore, buckets nuevos, secretos, dependencias de producción ni configuración de WhatsApp en esta fase.

Una vez aplicada/verificada la migración, desplegar backend y frontend. No desplegar primero el backend nuevo: el checkout utiliza la nueva sobrecarga SQL. La firma antigua sigue disponible para mantener compatibilidad durante el despliegue.

## API

Prefijo `/api/loyalty`:

- `GET /me`, `POST /me/promotions/:id/claim`: miembro autenticado.
- `GET /promotions`, `POST /promotions`, `PUT /promotions/:id`, `PATCH /promotions/:id/status`: owner.
- `GET /members/:memberId`, `POST /members/:memberId/promotions/:id/claim`: owner sobre un miembro del mismo gimnasio.
- `POST /rewards/:id/redeem-product`, `POST /rewards/:id/revoke`: owner.

Existentes modificados: `POST /api/memberships/manual-checkout` admite `rewardId` opcional (solo owner). El recibo privado de membresía incluye desglose de descuento. No se exponen esos datos adicionales en el recibo público verificable.

## Archivos de este bloque

- Nuevos: `backend/src/controllers/loyalty.controller.ts`, `backend/src/routes/loyalty.routes.ts`, `backend/src/validators/loyalty.validator.ts`.
- Backend existente: `backend/src/app.ts`, `backend/src/controllers/membership.controller.ts`, `backend/src/controllers/payment.controller.ts`, `backend/src/validators/membership.validator.ts`, `backend/src/utils/supabaseError.ts`.
- Nuevos frontend: `frontend/src/pages/LoyaltyPage.tsx`, `frontend/src/components/LoyaltyRewards.tsx`, `frontend/src/loyalty.css`.
- Frontend existente: `frontend/src/App.tsx`, `frontend/src/components/AppLayout.tsx`, `frontend/src/pages/MemberPortalPage.tsx`, `frontend/src/pages/MembershipsPage.tsx`.
- Migración/test: `supabase/migrations/0039_loyalty_rewards.sql`, `supabase/tests/0039_loyalty_rewards.sql`.
- Pruebas: `backend/tests/loyalty.test.ts`, `backend/tests/helpers/loyalty-sql-check.mjs`, `backend/tests/helpers/loyalty-ui-check.mjs`.
- Documentación: este archivo. No se modifican los cambios previos del usuario en README ni documentación de marketing.

## Validación

- Suite Vitest del backend: incluye validaciones, roles, identidades de sesión, datos manipulados y regresiones existentes.
- TypeScript de backend/frontend y compilación Vite.
- `backend/tests/helpers/loyalty-sql-check.mjs`: aplica las 39 migraciones a PostgreSQL embebido PGlite, con emulación mínima de `auth`/`storage`, y ejecuta pruebas SQL de renovaciones (0025), inventario (0028), QR (0032) y recompensas (0039). Instalar PGlite **fuera del repositorio** y pasar la ruta del paquete como argumento; no requiere credenciales ni toca producción. No sustituye una prueba de sesiones concurrentes reales en Supabase.
- `backend/tests/helpers/loyalty-ui-check.mjs`: prueba el build a 320/390/1440 px con API simulada, aislando toda llamada externa. Pasar la ruta de Playwright; usa Edge headless. Segundo argumento opcional: carpeta para capturas.

## Pendiente para fases posteriores

Referidos, medallas, recuperación de miembros inactivos, WhatsApp/correo, campañas recurrentes automáticas y analítica de retorno de promociones. No están activados ni se han añadido servicios pagos. Validar en staging las carreras de dos sesiones y hacer una prueba de aceptación con cuentas reales antes de habilitar promociones en producción.
