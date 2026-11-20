# FIT-OWNER-004 — Elevación de PIN concurrente sin solicitudes huérfanas

El Dashboard dispara en paralelo `GET /member-payments` y `GET /member-payments/dashboard-summary`. Con `finances.view = requires_pin`, ambas respuestas pueden ser `403 REQUIRES_ADMIN_PIN`. El interceptor anterior creaba una promesa por respuesta, pero el diálogo sobrescribía su único `pending` y perdía los callbacks de la primera.

## Qué autoriza un PIN

`POST /permissions/elevate` emite un token de cinco minutos ligado al gimnasio, al usuario staff y a la clave de permiso. El backend consume el token válidamente **una sola vez**, antes de procesar la operación, y vuelve a validar el permiso. Owner y staff con acceso directo no necesitan token; `denied` no es elevable. Los límites y eventos de auditoría siguen bajo control del backend.

Se eligió una **cola FIFO**, no single-flight de tokens. Compartir un token entre dos GET no funciona: el primero lo consume. Tampoco se conserva el PIN ni se repite su envío internamente para emitir más tokens. Cada solicitud, incluso con el mismo permiso, requiere una autorización explícita independiente. Hay un único modal visible y se limpia el formulario al pasar al siguiente turno. `Cancelar` o cerrar el modal rechaza todos los turnos pendientes de esa pantalla.

## Ciclo de vida y reintentos

- PIN incorrecto: el turno sigue en el mismo formulario para corregirlo o cancelar; no hay reenvío automático. El backend puede responder con el mismo error mientras está bloqueado. Ante HTTP 429, se cierra la cola y se propaga el error. Otros fallos de validación (incluido timeout) rechazan ese turno.
- Código válido: se comprueba `expiresAt` y se reenvía la solicitud original una sola vez con su propio token. Enviarla una segunda vez desde el interceptor de Auth o React Query podría duplicar una mutación, así que el error del retry —incluidos 401, 403, 500, timeout y un segundo `REQUIRES_ADMIN_PIN`— se propaga sin otro retry automático. El retry habitual de consultas no relacionadas no cambia.
- Cancelar también funciona durante «Validando…». Se aborta la llamada de validación y se ignora cualquier token tardío. No deshace una escritura ya despachada, ni revoca un token que el servidor alcanzó a emitir: ese token no se usa y vence normalmente.
- El diálogo se desmonta al cambiar de ubicación de ruta o actor. Los GET protegidos del Dashboard pasan su `AbortSignal`; una solicitud abortada no bloquea a las otras. Las respuestas tardías de la ruta anterior no pueden abrir otro diálogo. La frontera de Auth, la sesión expirada y un cambio de identidad verificado cancelan las elevaciones antiguas sin cambiar el mecanismo de refresh de solicitudes ordinarias.

## Archivos y validación

- `frontend/src/services/adminPinQueue.ts`: cola, resolución/rechazo y liberación de listeners.
- `frontend/src/services/adminPinElevation.ts` y `frontend/src/services/api.ts`: `REQUIRES_ADMIN_PIN`, alcance por diálogo, expiración y retry único.
- `frontend/src/components/AdminPinDialog.tsx` y `frontend/src/components/AppLayout.tsx`: formulario, cancelación y ciclo de vida.
- `frontend/src/services/sessionRecovery.ts` y `frontend/src/context/AuthContext.tsx`: invalidación por identidad y protección de un intento elevado contra reenvíos de Auth.
- `frontend/src/main.tsx` y `frontend/src/pages/DashboardPage.tsx`: un error de elevación no se reintenta automáticamente; los GET protegidos del Dashboard se pueden abortar.
- `backend/tests/adminPinConcurrency.test.ts` y `backend/tests/staffBoundary.test.ts`: tests locales con React Query, diálogo real e interceptores Axios; transporte simulado sin PIN, token ni cuenta reales. No se modifican rutas de backend, RLS, permisos, migraciones ni auditoría.
