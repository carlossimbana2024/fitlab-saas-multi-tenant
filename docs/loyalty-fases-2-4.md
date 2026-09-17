# Fidelización: fases 2, 3 y 4

## Alcance entregado

- Evaluación diaria por lotes de 100 miembros, reanudable por gimnasio.
- Avisos privados dentro de FitLab, sin exponerlos a Comunidad.
- Cola de correo/WhatsApp con consentimiento desactivado por defecto, leases, reintentos e idempotencia.
- Meta semanal personal, medallas automáticas y retos de recuperación por inactividad.
- Referidos mediante código: debe registrarse antes del primer pago efectivo, exige primera mensualidad confirmada de un mes y premia a ambas personas de forma atómica.
- Análisis mensual por campaña y copias históricas de meses cerrados.

## Migraciones

Ejecutar en este orden en Supabase SQL Editor:

1. `supabase/migrations/0040_loyalty_automation_engagement.sql`
2. `supabase/migrations/0041_loyalty_jobs_notifications.sql`
3. Opcional para comprobar y revertir fixtures: `supabase/tests/0041_loyalty_engagement.sql`

No se crean buckets ni índices manuales fuera de estas migraciones.

## Automatización y configuración

El backend expone `GET /api/cron/loyalty-evaluation`, protegido por `CRON_SECRET`. `backend/vercel.json` lo programa diariamente a las 10:30 UTC (05:30 en Ecuador). También existe el botón owner **Evaluar ahora**, que procesa un bloque y permite continuar si quedan miembros.

Los avisos dentro de FitLab funcionan sin proveedor externo. Correo y WhatsApp permanecen inactivos salvo que el miembro dé consentimiento y se configuren ambas variables:

```env
LOYALTY_DELIVERY_URL=https://adaptador-propio.example/loyalty
LOYALTY_DELIVERY_TOKEN=secreto-de-al-menos-32-caracteres
```

El adaptador recibe `id`, `channel`, `recipient`, `title`, `body` y `gymId`, debe aceptar `Authorization: Bearer ...` y deduplicar `Idempotency-Key`. FitLab no considera entregado un aviso hasta que el adaptador responde con HTTP 2xx. Nunca se deben registrar destinatarios ni cuerpos en logs.

## Definiciones de métricas

- **Participantes:** miembros cuyo primer progreso fue detectado en ese mes.
- **Premios y canjes:** se atribuyen al mes en que ocurrieron; no forman una tasa entre sí.
- **Retorno 30–59 días:** miembros con al menos 60 días de seguimiento que volvieron a registrar una asistencia válida entre los días 30 y 59. Es una señal observacional, no causal.
- **Costo de producto:** costo privado congelado al entregar el regalo. Los registros sin costo histórico se señalan y no se interpretan como costo cero.
- **Referido calificado:** primera mensualidad efectiva confirmada, en moneda del gimnasio, por el mínimo fijado, registrada durante la campaña y con exactamente un mes de cobertura. Si se reembolsa, deja de ser elegible para un canje posterior.

Los snapshots conservan lo conocido al cerrar cada mes; la vista recalculada muestra correcciones posteriores como reembolsos.
