# Corrección: instructores y horario de clases

- El miembro recibe únicamente ID/nombre de instructores asignados a las sesiones consultadas, filtrados por gimnasio y rol. No se carga el directorio completo ni teléfonos para miembros.
- El formulario consulta `/calendar` por sucursal y fecha, vuelve a consultar al abrir/enfocar, cada 30 segundos mientras está abierto (sin segundo plano), y antes de guardar. No utiliza una copia permanente del horario.
- `datetime-local` se interpreta en la zona de la sucursal, no en la del dispositivo. Horas inexistentes o ambiguas por DST se rechazan explícitamente.
- La migración 0053 valida en PostgreSQL el intervalo completo al crear/reprogramar/reactivar una sesión. Usa el calendario vigente, excepciones y horarios nocturnos. Apertura inclusiva; se permite terminar exactamente al cierre. Sin horario configurado, se rechaza.
- Los cambios del calendario y la programación se serializan sobre la sucursal. PostgreSQL sigue siendo autoritativo si los datos del formulario quedaron antiguos.
- No se reprograman/cancelan clases existentes, reservas, pagos ni condiciones económicas cuando cambia el calendario. Las sesiones existentes requieren revisión manual del owner si el nuevo horario las deja fuera. Esta corrección regula programación, no disponibilidad personal de cada entrenador.
- La prueba de oferta sin hora del servidor ahora fija/restaura el reloj de Vitest; no depende de la fecha del equipo.

## Aplicación

1. Ejecutar `supabase/migrations/0053_class_schedule_opening_hours.sql` una sola vez después de 0052.
2. Ejecutar `supabase/tests/0053_class_schedule_opening_hours.sql`. Crea datos aislados y termina con ROLLBACK. Esperado: `0053 OK`.
3. Publicar backend/frontend cuando se autorice commit/push.
4. Comprobar con una clase de prueba: instructor visible; horario normal; fin exactamente al cierre; rechazo fuera de horario; cambiar el calendario y volver a programar; excepción de cierre; sucursal distinta.

No activar ofertas ni cron. No requiere volver a ejecutar las migraciones anteriores.

## Validación local

- 129 pruebas relacionadas aprobadas (regresiones 001–005 y nuevas comprobaciones de instructor/horario).
- Pruebas SQL 0048–0051 y 0053 aprobadas en PostgreSQL embebido aislado. 0052 usa un stub de cron local, no prueba el scheduler real.
- Typecheck/build de frontend y backend aprobados; persisten los avisos previos de jsPDF/tamaño del bundle.
- No se ejecutaron pruebas de navegador autenticado ni carreras multiconexión reales. No se modificó producción.
