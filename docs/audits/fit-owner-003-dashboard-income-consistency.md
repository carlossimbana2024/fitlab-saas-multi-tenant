# FIT-OWNER-003 — Ingresos mensuales en un solo snapshot

## Causa y alcance

`GET /member-payments/dashboard-summary` consultaba `member_payments` en lotes de 1.000 con offset y orden por `paid_at DESC`, sin desempatar por ID. Cada solicitud a PostgREST podía ver un estado distinto. Cuando una fila entraba o salía del conjunto, los offsets se desplazaban; además, los empates no tenían un orden total. No había corrupción de pagos almacenados.

Se consideró un cursor por `(paid_at,id)`: evita el desplazamiento de offsets y resuelve los empates, pero no da una foto única si se insertan filas a ambos lados del cursor o si un pago cambia de estado entre páginas. Tampoco basta un total separado por cada categoría con varias solicitudes. La solución es una RPC SQL `STABLE` que agrega todas las categorías, monedas y el mes en un solo statement. Se mantiene la API y su respuesta `{ summary: { month, currencies } }`.

## Garantía y semántica

El resultado corresponde a las filas visibles en el snapshot PostgreSQL **del statement que llama a la RPC**. Una confirmación, anulación o devolución confirmada antes del snapshot se incluye o excluye según su estado; un commit concurrente posterior no afecta esa lectura, pero sí una consulta nueva. El snapshot cubre también `gyms.timezone` y la moneda de respaldo. No hay páginas, deduplicación en JavaScript ni una lectura separada para la moneda.

- Solo cuenta `confirmed`. Excluye `pending`, `failed`, `voided`, `refunded` y montos no finitos, conservando la lógica anterior. No interpreta fechas de reversión como ingresos de otro mes.
- Se usa `paid_at >= inicio` y `paid_at < inicio del mes siguiente`, con ambos límites civiles en `gyms.timezone`. La hora de referencia predeterminada es la del statement en PostgreSQL; el navegador no fija el periodo ni la zona. Esto no cambia los demás cálculos temporales del Dashboard (FIT-OWNER-005).
- Se mantiene el orden de prioridad del desglose: membresías, ventas, actividades y otros. PostgreSQL suma `numeric` y devuelve importes y cantidades por moneda, sin conversión. Si no hay pagos elegibles, devuelve la moneda del gimnasio y los cuatro desgloses en cero.
- Todas las sucursales del mismo gimnasio cuentan. No se agrega filtro de sede. **Control Owner no cambia**: sigue siendo un reporte distinto, con sus filtros y fechas de reversión.

La ruta conserva `verifyJWT`, `tenantContext` y `finances.view`. Solo pasa el `gymId` resuelto para el actor; los parámetros del navegador no tienen autoridad. La RPC se ejecuta con `service_role`, `SECURITY INVOKER` y `search_path` restringido: `PUBLIC`, `anon` y `authenticated` no tienen acceso directo. Se usan los permisos de lectura que ya tiene el backend, sin cambiar RLS.

## Volumen

Para 10, 100, 1.000, 10.000 y 100.000 pagos, se mantiene una sola llamada de agregación y solo vuelve un resumen por moneda. La base aún debe leer las filas del gimnasio/intervalo y verificar su estado: el costo en DB crece con el volumen del mes y PostgreSQL puede aprovechar el índice existente `member_payments_gym_paid_idx` para acotar el rango. No hay `OFFSET`, transferencia de miles de pagos ni acumulación de esas filas en Node. Se verificó hasta 5.001; 10.000 y 100.000 son análisis, no benchmarks de producción. El contrato JSON sigue usando números; no se rediseñó la representación del importe en navegador.

## Validación local y paso manual

- `backend/src/controllers/payment.controller.ts` y `backend/src/services/dashboardIncome.ts`: integración del resumen existente, sin ruta ni frontend nuevos.
- `backend/tests/dashboardIncome.test.ts`: contrato, una RPC, aislamiento del ID del navegador, permisos financieros y casos de error.
- `supabase/migrations/0059_owner_dashboard_income_snapshot.sql`: función y permisos; no cambia datos.
- `supabase/tests/0059_owner_dashboard_income_snapshot.sql` y `supabase/tests/run-owner-dashboard-income-local.mjs`: fixtures exclusivamente locales y prueba concurrente con un escritor y un lector real. El runner inicia una base temporal en loopback y la detiene al terminar; no usa URLs ni credenciales Supabase.
- `supabase/tests/0059_owner_dashboard_income_snapshot_verify.sql`: verificación remota solo de lectura (catálogo y permisos).

El runner reproduce la inserción con USD 1.000 antes del commit, USD 1.015 en la consulta siguiente y USD 1.001 con las páginas antiguas. En anulación y reembolso observa USD 1.015 antes del commit y USD 1.000 después; las páginas antiguas devuelven USD 1.014. Se fuerza el orden observando un bloqueo de prueba en `pg_locks`, no con un retardo supuesto. Se ejecuta desde la raíz del repositorio con `node supabase/tests/run-owner-dashboard-income-local.mjs <directorio-bin-postgresql> <ruta-al-módulo-pg>`.

En el SQL Editor del proyecto correcto, ejecutar **solo** la migración `0059_owner_dashboard_income_snapshot.sql`. Luego ejecutar el archivo `0059_owner_dashboard_income_snapshot_verify.sql`: se espera `rpc_exists = true`, `jsonb_result = true`, `gym_only_call_supported = true`, `stable_sql_invoker = true`, `restricted_search_path = true`, `no_public_execute = true`, `anon_execute = false`, `authenticated_execute = false`, `service_role_execute = true` y `service_role_can_read_sources = true`. No ejecutar los fixtures en producción. Aplicar y verificar **antes** de desplegar este backend; la función es aditiva y no cambia el comportamiento del código ya desplegado.

Referencia: [snapshot por sentencia en PostgreSQL](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED) y [visibilidad de funciones STABLE](https://www.postgresql.org/docs/current/xfunc-volatility.html).
