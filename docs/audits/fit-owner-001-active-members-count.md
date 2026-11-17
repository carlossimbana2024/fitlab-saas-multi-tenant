# FIT-OWNER-001 — Conteo exacto de miembros activos

**Regla funcional.** Son las filas de `gym_users` del gimnasio de la sesión con `role = 'member'` y `status = 'active'`. Las cuentas activas `managed` y `portal` cuentan igual. Las invitadas, suspendidas o retiradas (`inactive`), así como owner y staff, no cuentan. La sucursal, la cobertura y los pagos no intervienen.

## Causa y corrección

El Dashboard consultaba `GET /members` con la clave `['members']`. `listMembers` filtra por gimnasio, rol y los estados `invited`, `active`, `suspended`, `inactive`, ordena por `created_at` descendente y limita a 250 antes de separar los retirados. El Dashboard contaba después las filas con `status === 'active'`, por lo que podía subcontar incluso con menos de 250 activos.

Ahora `GET /members/dashboard-summary` devuelve `activeMemberCount`. PostgREST realiza un conteo exacto sobre `gym_users` con `HEAD`, sin devolver filas para el conteo ni aplicar el límite del directorio. El mismo endpoint conserva la resolución de nombres de Actividad reciente con una proyección mínima y acotada, para no añadir una segunda solicitud del navegador protegida por `members.view`. Ese resultado de nombres no se usa para contar. `GET /members` y el directorio no cambian.

- 251 activos muestran **251**, aunque solo se consulten 250 nombres para Actividad reciente.
- 230 activos más 40 cuentas recientes no activas muestran **230**, aunque algunas cuentas activas queden fuera de la consulta de nombres.
- Un conteo exitoso de cero muestra **0**. Durante la carga se muestra `…`; un error no se convierte en cero.

## Aislamiento, permisos y frescura

La ruta usa `verifyJWT`, `tenantContext` y `checkPermission('members.view')`, como el directorio. Las dos consultas con service role se restringen explícitamente a `request.tenant.gymId`; el cliente no puede elegir un gimnasio. No cambian RLS, políticas, permisos ni el flujo de PIN. La respuesta no se almacena en cachés HTTP compartidas.

La clave React Query del resumen se separa por gimnasio y actor. El refresco que ya ejecuta el directorio tras altas, suspensiones, reactivaciones, retiros y reincorporaciones también invalida ese resumen para su propio gimnasio. Aceptar una invitación cambia la cuenta a activa en el servidor y completa el flujo con navegación de página completa en esa sesión. Un Dashboard abierto en otra sesión lee el valor nuevo en su siguiente consulta (por ejemplo, al recargar); no se añade sincronización en tiempo real ni se cambia la política de frescura existente.

## Archivos y comprobación

- `backend/src/controllers/member.controller.ts`, `backend/src/routes/member.routes.ts`: resumen del Dashboard y control de acceso.
- `frontend/src/pages/DashboardPage.tsx`, `frontend/src/pages/MembersPage.tsx`: consumo del conteo e invalidación acotada.
- `backend/tests/dashboardActiveMembers.test.ts`: contrato, filtros, permisos, varios gimnasios y sucursales, estados de cuenta y lotes que superan 250.
- `backend/tests/dashboardActiveMembersUi.test.ts`: valor mostrado, carga y error, nombres de actividad e invalidación al registrar un miembro administrado.
- `backend/tests/memberLifecycleBoundary.test.ts`: regresión de separación del resumen y del directorio.

No requiere migración ni cambios en Supabase.
