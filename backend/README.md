# FitLab Backend

API Express + TypeScript para el MVP multi-tenant de FitLab. Las operaciones
normales usan el JWT del usuario y respetan RLS; `SUPABASE_SECRET_KEY` queda
reservada para operaciones internas expresamente autorizadas.

## Comandos

```powershell
npm install
npm run typecheck
npm run build
npm run dev
```

## Rutas disponibles

- `GET /api/health`: proceso HTTP activo.
- `GET /api/health/ready`: conexión administrativa real con Supabase.
- `POST /api/auth/login`: sesión por correo y contraseña.
- `POST /api/auth/refresh`: renovación de cookies de sesión.
- `GET /api/auth/me`: usuario y pertenencia al gimnasio.
- `POST /api/auth/logout`: elimina las cookies locales.
- `POST /api/permissions/elevate`: valida PIN y entrega un token de un solo uso.
- `GET /api/members`: listado protegido por `members.view`.
- `GET /api/members/:id`: detalle protegido por `members.view`.
- `POST /api/members/invite`: invita una cuenta protegida por `members.manage`.
- `GET /api/attendances`: listado filtrado por RLS.
- `POST /api/attendances/qr`: auto-registro del miembro.
- `POST /api/attendances/staff`: requiere `attendance.register`.
- `PATCH /api/attendances/:id/void`: requiere `attendance.void`.
- `GET /api/plans`: planes activos visibles para el usuario autenticado.
- `GET /api/memberships`: membresías filtradas por RLS.
- `POST /api/memberships/manual-checkout`: cobro y cobertura atómicos; requiere `payments.register`.
- `GET /api/member-payments`: pagos filtrados por RLS.
- `PATCH /api/member-payments/:id/void`: requiere `payments.void`.

## Seguridad

- No enviar `gym_id` como autoridad desde el navegador; se obtiene de la sesión.
- No exponer `SUPABASE_SECRET_KEY` en el frontend ni en GitHub.
- Para una operación `requires_pin`, llamar primero a `/api/permissions/elevate`
  y enviar el token resultante una sola vez en `x-admin-elevation-token`.
- `dist/` es código generado; editar únicamente `src/`.
