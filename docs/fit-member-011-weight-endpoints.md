# FIT-MEMBER-011 — extremos históricos de peso

## Causa y contrato

`getMyProgress` consultaba las primeras 500 mediciones por `measured_on ASC`
y tomaba el último elemento como peso actual. Progreso y Perfil recibían una
métrica potencialmente obsoleta; el formulario de registro también usaba ese array.

Ahora el endpoint consulta por separado primera y última medición con `LIMIT 1`,
siempre filtrando `gym_id` y `member_user_id` del contexto autenticado. Expone
`initialWeightKg` y `currentWeightKg` (null sin historial) y calcula `goal`
exclusivamente con esos extremos y el objetivo vigente. No usa el peso de encuesta.

`weights` contiene las 500 mediciones más recientes, devueltas en orden cronológico
para conservar el contrato visual. La gráfica usa las últimas 8 y la lista 6.
Ni las métricas ni el valor inicial del formulario dependen de esa ventana.

## Base de datos y consumidores intactos

0034 garantiza peso entre 20 y 500 y unicidad `(gym_id, member_user_id, measured_on)`.
Su índice `member_weight_entries_member_date_idx` cubre ambos extremos; no hacen
falta desempates, índices ni migraciones nuevos. La fecha medida, no `created_at`,
determina los extremos. Comunidad/Perfil social ya consultan extremos directamente;
0055 y ranking mensual no cambian. Se preserva la fórmula canónica y mantenimiento.

## Caché y errores

El upsert existente permite crear o reemplazar por fecha; al guardar invalida
`my-progress`, `member-social-profile`, `member-community` y
`member-community-rankings`. No existe acción de borrado en este flujo.
Fallos de cualquiera de las consultas de extremos se propagan como error de API,
no como ausencia de mediciones. Progreso conserva su aviso y reintento existentes.

## Validación local

Pruebas de controlador con consultas simuladas que aplican orden y límite real:
0, 1, 3, 501 y 1201 mediciones; inserción retroactiva, nueva fecha y reemplazo;
pérdida, ganancia, mantenimiento, límites de consulta y filtros tenant; fallo de
cada extremo. Regresiones de 010 y 008 y componentes Progreso/Perfil/Comunidad.
Prueba de contrato de invalidación y prellenado, sin sustituir un smoke test real.

No se modifica Supabase remoto ni se activa FIT-MEMBER-005. Las tres lecturas
independientes no constituyen un snapshot transaccional: una escritura concurrente
puede producir diferencias momentáneas entre gráfica y resumen; la invalidación
posterior al guardado vuelve a consultar ambos. No se descarga todo el historial.
