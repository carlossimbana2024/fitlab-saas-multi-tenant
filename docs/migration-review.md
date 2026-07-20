# Guía de revisión de migraciones

## Importante

Estas migraciones no han sido ejecutadas. Deben revisarse en orden antes de vincular el repositorio con Supabase.

## Orden

1. `0001_foundation.sql`: extensiones, esquemas, enums y utilidades.
2. `0002_tenancy_identity.sql`: perfiles, gimnasios, sucursales, usuarios e invitaciones.
3. `0003_permissions_calendar.sql`: permisos, elevación por PIN y calendario operativo.
4. `0004_memberships_payments.sql`: planes, membresías, renovaciones y pagos manuales.
5. `0005_attendance_classes_streaks.sql`: asistencias, clases, progreso y rachas.
6. `0006_commerce_shifts_saas_audit.sql`: POS, inventario, turnos, suscripción SaaS y auditoría.
7. `0007_rls.sql`: funciones privadas de autorización y políticas RLS.
8. `0008_tenant_invariants_attendance.sql`: referencias del mismo tenant y reglas estrictas de asistencia.
9. `0009_financial_membership_invariants.sql`: monedas, transiciones financieras y cancelación de cobertura.
10. `0010_streak_engine.sql`: actualización inmediata y evaluación diaria/semanal de rachas.
11. `0011_backend_private_api.sql`: RPC privadas para PIN, costos y privilegios explícitos del backend.

## Decisiones intencionales

- `profiles` no contiene `gym_id`; `gym_users` expresa la pertenencia.
- `gym_users.profile_id` es único: una persona solo pertenece a un gimnasio.
- El hash del PIN vive en `private.gym_security`.
- No existe el rol `superadmin` del tenant.
- Las administraciones internas de FitLab viven en `private.platform_admins`.
- Una asistencia anulada no se elimina físicamente.
- Los pagos automáticos de miembros a gimnasios quedan fuera del MVP.
- No se configura un cron remoto en estas migraciones. El backend deberá invocar diariamente `run_streak_evaluation` para la fecha anterior de cada gimnasio.
- El alta inicial del gimnasio y de su primer `owner` deberá ejecutarse mediante un flujo backend transaccional privilegiado; RLS no permite que un usuario se convierta en dueño por sí mismo.

## Antes de aplicar

- Sustituir cualquier política demasiado amplia detectada durante la revisión.
- Probar en un proyecto Supabase de desarrollo, nunca directamente en producción.
- Crear usuarios de prueba de dos gimnasios diferentes.
- Verificar aislamiento para `SELECT`, `INSERT`, `UPDATE` y `DELETE`.
- Probar que `run_streak_evaluation` sea idempotente antes de programar su ejecución diaria.
