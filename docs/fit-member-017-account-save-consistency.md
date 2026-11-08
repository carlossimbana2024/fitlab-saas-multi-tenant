# FIT-MEMBER-017 — mapa previo del flujo real

| Campo | Destino | Operación | Dependencias |
| --- | --- | --- | --- |
| Nombre/teléfono | public.profiles del authUser | PUT /members/me/profile | Sesión/cabecera, perfil social, Comunidad y ranking |
| Email | Supabase Auth (solo lectura en este portal) | No hay formulario ni endpoint de cambio de email del miembro | No aplicaba; no se crea flujo nuevo |
| Contraseña | Supabase Auth | PUT /auth/change-password: comprueba actual con signInWithPassword y actualiza con admin.updateUserById | No escribe perfiles ni retorna nuevas cookies; no cierre de sesión forzado |
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
