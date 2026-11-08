# FIT-MEMBER-017 — mapa previo del flujo real

| Campo | Destino | Operación | Dependencias |
| --- | --- | --- | --- |
| Nombre/teléfono | public.profiles del authUser | PUT /members/me/profile | Sesión/cabecera, perfil social, Comunidad y ranking |
| Email | Supabase Auth (solo lectura en este portal) | No hay formulario ni endpoint de cambio de email del miembro | No aplicaba; no se crea flujo nuevo |
| Contraseña | Supabase Auth | PUT /auth/change-password: comprueba actual y actualiza mediante PUT Auth /user con el bearer verificado del solicitante | No escribe perfiles ni retorna nuevas cookies; conserva sesión actual si Auth lo permite |
| Avatar | Bucket privado member-avatars + profiles.avatar_url | Preparar signed URL, PUT archivo, PUT /members/me/avatar | Solo al confirmar referencia se refrescan sesión y vistas identity |
| Bio/momentos/consentimientos | Perfil social/galería/fitness | Operaciones independientes ya existentes | No se agrupan con nombre/contraseña; se preserva 001/015 |

## Problema confirmado antes de editar

Un botón ejecutaba PUT perfil, refresh de sesión/caché y luego PUT contraseña.
Sin transacción entre perfil y Auth. Si falla contraseña, el nombre ya cambió
pero el formulario solo da error genérico; reintentar vuelve a guardar perfil.
Además refresh pone loading=true en AuthProvider; ProtectedRoute desmonta sus
hijos durante la revalidación. Eso puede perder el modal y su resultado parcial.

El orden inverso (contraseña primero, perfil después) no ocurre y se mantendrá
así: un fallo de perfil impide intentar contraseña. La confirmación/validación
local debe ocurrir antes de cualquiera de las escrituras.

No existe cambio de email en el portal. Avatar tiene su propia operación y no
debe compartir mensaje genérico de éxito con cuenta/contraseña.

## Solución local

- MemberAccountDialog conserva el checkpoint de nombre/teléfono únicamente tras
  confirmación del PUT. Mensajes independientes: datos guardados, contraseña
  actualizada o fallo explícito. Validación de confirmación, campos completos,
  longitud 8–128 y diferencia respecto de actual antes de cualquier escritura.
- Si perfil falla, contraseña no se intenta. Si contraseña falla tras perfil,
  no se repite el PUT de perfil al reintentar (salvo que el usuario lo edite).
- Campos de contraseña se limpian tras éxito y tras fallos remotos; tras error
  de validación local se permite corregir los campos. No se persisten secretos.
- Lock síncrono por formulario, fieldset desactivado y bloqueo de cierre pendiente.
  El modal queda abierto tras guardar para mostrar resultados concretos.
- Solo perfil/avatar confirmados invocan reconciliación identity de 015. Un fallo
  de lectura/caché posterior se muestra como advertencia separada, con reintento
  de lectura que no repite escrituras. La contraseña sola no invalida perfil.
- AuthProvider incorpora refresh({background:true}) opt-in: no pone loading global,
  conserva el formulario y propaga fallos al llamador. Startup, refresh normal,
  login/logout y recuperación 006 siguen con su comportamiento anterior; una
  sesión realmente inválida conserva la limpieza/redirección ya existente.
- El PUT de perfil confirmado aplica nombre/teléfono a la sesión local antes de
  revalidar. Así cerrar/reabrir el formulario tras un fallo de lectura no recupera
  el nombre viejo ni lo revierte al editar el teléfono. El merge comprueba auth user
  id, conserva avatar/permisos y nunca reconstruye una sesión cerrada.
- Avatar: upload confirmado guarda path solo en memoria hasta finalizar. Si falla
  asociación, se ofrece reintentar el mismo path sin duplicar subida; la foto
  anterior/caché no se marca exitosa. Si finalize tuvo éxito pero refetch falla,
  se informa foto guardada y problema de actualización visual. No había estrategia
  de limpieza de objetos huérfanos; no se agregó borrado ni rediseño de Storage.
- Backend changePassword usa authCall/checkAuthAvailability ya existentes: 429,
  5xx o error de transporte no se confunden con contraseña actual incorrecta.
  Se preservan códigos normales, validaciones, cookies y sesión.

## Límites y riesgos explícitos

No se simula transacción entre perfil/Auth/Storage. Si se pierde respuesta de
una escritura puede ser imposible confirmar si se aplicó: se informa esa
incertidumbre, no éxito falso. El path de retry de avatar se pierde al recargar
o salir; no hay limpieza automática nueva. Si no se puede refrescar la sesión,
las demás vistas pueden conservar datos anteriores hasta revalidar; el modal lo
advierte, sin perder el nombre/teléfono confirmado en la sesión local.
No se forzó logout ni se construyó cambio de email/nonce de reautenticación.
Sin Supabase remoto, migraciones, commit/push ni avance a 018.

## Validación local

- 180 pruebas aprobadas en 11 archivos: memberAccountSaveUi (16), accountPassword
  (14), authRecoveryBackend (16), authSessionLifecycle (12), sessionRecovery
  (25), memberPrivacy (10), memberProfileBoundary (4), memberSocialProfile (7),
  memberQueryStates (19), memberAggregatesUi (32), memberQueryInvalidation (25).
- Cobertura nueva: resultados por operación, perfil confirmado/contraseña fallida,
  retry sin repetir perfil, fallo de perfil que impide contraseña, validación
  local sin escrituras, doble submit, limpieza de inputs, fallo de reconciliación,
  refresh de Auth sin desmontar hijos, reapertura desde datos confirmados tras
  fallo de lectura, aislamiento ante confirmación tardía y retry de asociación de
  avatar sin subirlo otra vez. Backend distingue indisponibilidad de Auth de
  credenciales incorrectas.
- Typecheck/build de frontend y backend aprobados. Sin SQL ni comprobaciones
  contra producción; no se han usado credenciales reales en pruebas.
- Avisos no bloqueantes del arnés React deprecated y de Vite (tamaño de bundle e
  importación estática/dinámica de jsPDF); no se modifican dentro de este hallazgo.

### Smoke manual sugerido tras desplegar (no ejecutado en producción)

1. Cambiar nombre/teléfono: comprobar mensaje de datos guardados y cabecera.
2. Con un cambio de nombre pendiente, introducir confirmación de contraseña
   distinta: no debe guardarse nada hasta corregirla.
3. Cambiar nombre + contraseña actual incorrecta: datos guardados + error de
   contraseña; reintroducirla y reintentar sin repetir la escritura del nombre.
4. Cambiar contraseña correctamente: inputs vacíos y sesión conservada.
5. Subir foto: mensaje propio y avatar actualizado. Los fallos parciales y de
   transporte se simulan en los tests locales, no mediante mutaciones en producción.

## Subcaso reabierto — logout tras perfil + contraseña

### Causa y comparación de caminos

La implementación anterior de changePassword usaba admin.updateUserById. En el
código oficial de Auth, adminUserUpdate llama a UpdatePassword con sessionID=nil,
que revoca todas las sesiones. No modificaba las cookies de FitLab; quedaban
credenciales de una sesión revocada en el navegador.

- Password-only: el diálogo mostraba éxito pero no ejecutaba onIdentitySaved.
  La sesión seguía en el estado React hasta una nueva comprobación protegida.
  Permanecer visualmente en el portal no demostraba que la sesión siguiera vigente
  en Auth. El test nuevo comprueba también una petición protegida posterior.
- Perfil + contraseña: finalmente ejecutaba reconcileIdentity, con /auth/me y las
  invalidaciones identity de 015. verifyJWT verificaba la sesión revocada, devolvía
  INVALID_SESSION; el recuperador de 006 intentaba /auth/refresh, recibía el rechazo
  definitivo y notificaba clear() en AuthProvider. setSession(null) hacía que
  ProtectedRoute navegara a /login. No se llamaba explícitamente a logout/signOut
  en el frontend. Era una invalidación provocada por nuestro endpoint de cambio
  de contraseña, no un error de red que debamos silenciar.

Fuentes primarias inspeccionadas (comportamiento del proveedor, sin tocar remoto):

- https://github.com/supabase/auth/blob/master/internal/api/admin.go — adminUserUpdate.
- https://github.com/supabase/auth/blob/master/internal/models/user.go — UpdatePassword.
- https://github.com/supabase/auth/blob/master/internal/api/user.go — UserUpdate usa
  la sesión autenticada y conserva esa sesión al cambiar contraseña.

### Reproducción antes de corregir

memberAccountSession.test.ts usa el diálogo, AuthProvider, ProtectedRoute,
interceptores Axios de 006, QueryClient/invalidation de 015 y changePassword y
verifyJWT reales de FitLab. Solo Auth externo y el almacenamiento de perfil se
simulan: reset administrativo revoca sesiones; /user conserva la sesión llamante.
No es una prueba contra Supabase de producción.

Con el backend anterior: A (password-only + petición protegida), C (combinado) y E
(combinado + fallo de relectura) fallaron; B, D y F pasaron. C reprodujo sesión
nula/redirección después de guardar ambos cambios. No se necesitó modificar
AuthContext ni desactivar la validación de sesiones para reproducirlo.

### Corrección

- Sustituido el reset administrativo por PUT /auth/v1/user, con accessToken ya
  verificado por middleware, clave pública y solo password/current_password.
  Sin clave administrativa ni tokens de otro usuario ni login automático.
- Petición HTTP directa porque el cliente SDK de servidor no conserva la sesión
  del navegador; auth.updateUser requiere una sesión SDK en memoria. Se evita
  inventar tokens, persistirlos o crear/rotar cookies para hacer esa llamada.
- Se mantienen la comprobación actual, longitud, confirmación y contrato de éxito.
  Se comprueba identidad del resultado, timeout y clasificación de indisponibilidad.
- Si Auth exige reautenticación/AAL, el error PASSWORD_REAUTHENTICATION_REQUIRED
  se muestra explícitamente, conservando los resultados parciales. No se cambian
  policies, MFA ni configuración Auth y no se fuerza logout.
- No se suprime /auth/me ni su refetch: 401 realmente inválido continúa siguiendo
  006; una relectura fallida por 503 mantiene sesión/datos y muestra advertencia.
- Se conservan intactos avatar retry, bloqueo de doble submit, checkpoint de
  perfil, limpieza de contraseñas e invalidación selectiva 015/016.

Validación de este subcaso: 194 pruebas aprobadas en 12 archivos, con seis
escenarios A–F de sesión (incluye redirección por Auth realmente inválido), 21
pruebas del endpoint de contraseña y 17 del diálogo. Regresiones de 006, 015,
016, privacidad/perfil/avatar aprobadas. Typecheck/build backend y frontend OK;
sin ejecutar SQL ni pruebas contra producción. Avisos previos no bloqueantes de
React test renderer y Vite conservados. Smoke remoto pendiente después del futuro
despliegue; no se cambiaron Supabase, FIT-MEMBER-005 ni la configuración. No se
hizo commit/push y no se avanzó a 018.
