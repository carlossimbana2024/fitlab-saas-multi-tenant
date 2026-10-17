# Escáner interno de asistencia

Es una entrada adicional al mismo flujo de `/check-in`: no reemplaza los carteles,
el acceso desde la cámara externa, la confirmación ni el registro manual en recepción.
No requiere migración, QR nuevo ni cambio en Supabase. Tampoco instala una PWA.

## Uso

1. Entrar como miembro y pulsar Registrar asistencia en Inicio o Progreso.
2. Pulsar Abrir escáner de FitLab y conceder permiso de cámara.
3. Apuntar al cartel. El lector se detiene al reconocer un QR permitido.
4. Comprobar gimnasio, sucursal y cobertura, y confirmar explícitamente.

La API recibe solo el token: el gimnasio y miembro salen de la sesión; la sucursal,
fecha, zona horaria, membresía y origen `qr` se resuelven en el backend existente.
La asistencia ya registrada conserva su sucursal original, incluso al escanear otra.

## Compatibilidad y privacidad

- HTTPS obligatorio en producción; localhost permitido para desarrollo.
- Cámara trasera preferida, cambio a frontal disponible; no solicita micrófono.
- `playsInline` y reproducción silenciada para navegadores móviles.
- jsQR 1.4.0 se carga al activar el lector. Usa un worker local; si el navegador
  bloquea/no soporta workers de módulo, recurre a lectura local en el hilo principal.
- Resolución de análisis limitada a 640 px por lado mayor, una lectura en vuelo,
  con 250 ms entre lecturas. No se cargan recursos de lectura en el inicio normal.
- Ninguna imagen ni vídeo se sube, graba o almacena. El lienzo se descarta al cerrar.
- Cámara detenida al leer, cancelar, salir, ocultar la página, perder conexión o
  desmontar el componente. Un permiso que llega tarde se descarta y detiene también.
- La reanudación requiere un nuevo toque; no se reabre sola al volver a la página.
- Confirmación online, sin colas offline ni reintentos automáticos de escritura.
- El QR estático no demuestra presencia física; los rotativos siguen fuera del alcance.

## Carteles de dominios anteriores

Por defecto solo se aceptan enlaces absolutos del origen actual con formato exacto
`/check-in#token=…`. No se abren ni consultan las URLs leídas. Si se conserva un
cartel emitido en otro dominio legítimo, se puede configurar en el frontend:

`VITE_ATTENDANCE_QR_ALLOWED_ORIGINS=https://dominio-anterior.example`

Permite varios orígenes separados por comas. Deben ser HTTPS, exactos, sin rutas,
credenciales ni comodines. Requiere un build/despliegue nuevo. No es necesario
configurarlo cuando el cartel pertenece al mismo dominio. La API sigue comprobando
que el token sea válido y corresponda al gimnasio autenticado.

## Prueba física antes de producción

Probar Chrome Android y Safari iPhone con el cartel real de cada sucursal:

- Entrada interna y enlace desde cámara externa, con/sin sesión previa.
- Permitir/denegar cámara, volver de segundo plano, cambiar cámara y cerrar.
- QR de otra web/gimnasio, revocado, vencido y sucursal inactiva.
- Cobertura vencida y horario cerrado: la confirmación debe ser rechazada.
- Escanear Sur con un miembro cuyo perfil tiene Norte: comprobar Sur en la vista
  previa, confirmación y registro del owner; no asumir su sucursal por defecto.
- Registrar dos veces, incluida la segunda vez desde otra sucursal: debe conservar
  la primera asistencia, su sucursal, fecha y rachas, sin una segunda entrada.
- Perder red antes/durante confirmación y reintentar explícitamente: sin duplicados.
- Revisar Inicio, Progreso y el listado del owner tras actualizar sus consultas.

La futura PWA podrá reutilizar este componente; todavía requiere pruebas reales
en modo instalado. Su caché no debe almacenar respuestas de asistencia ni autenticar
operaciones offline.
