# Despliegue inicial de FitLab en Vercel

FitLab se despliega desde el mismo repositorio como dos proyectos de Vercel:

- `fitlab-frontend`, con `frontend` como **Root Directory**.
- `fitlab-backend`, con `backend` como **Root Directory**.

No copies claves reales dentro del repositorio. Todas las variables siguientes se
configuran desde **Vercel > Project Settings > Environment Variables**.

## 1. Backend

Crear primero el proyecto del backend y seleccionar `backend` como directorio raíz.
Vercel detectará Express desde `src/app.ts`.

Variables requeridas:

```text
NODE_ENV=production
FRONTEND_ORIGINS=https://URL-DEL-FRONTEND.vercel.app
SUPABASE_URL=https://ID-DEL-PROYECTO.supabase.co
SUPABASE_PUBLISHABLE_KEY=valor-del-proyecto
SUPABASE_SECRET_KEY=valor-secreto-del-proyecto
COOKIE_SECRET=secreto-aleatorio-de-al-menos-32-caracteres
CRON_SECRET=otro-secreto-aleatorio-de-al-menos-32-caracteres
```

`PORT` no es necesario en Vercel. Puede conservarse si la plataforma lo define,
pero FitLab solo lo usa al ejecutar `npm run dev` o `npm start` localmente.

Después de publicar, comprobar:

```text
https://URL-DEL-BACKEND.vercel.app/api/health
```

Debe responder con `status: ok`.

## 2. Frontend

Crear el segundo proyecto desde el mismo repositorio y seleccionar `frontend` como
directorio raíz. Vercel detectará Vite.

Variable requerida:

```text
VITE_API_URL=https://URL-DEL-BACKEND.vercel.app/api
```

La variable se incorpora durante la compilación. Si cambia, hay que volver a
desplegar el frontend.

## 3. Actualizar el origen permitido

Cuando Vercel asigne la URL definitiva del frontend, volver al proyecto backend y
confirmar que `FRONTEND_ORIGINS` contiene exactamente esa URL, sin `/` al final.
Después, volver a desplegar el backend.

## 4. Configurar Supabase Auth

En **Supabase > Authentication > URL Configuration**:

- **Site URL**: URL definitiva del frontend.
- **Redirect URLs**: agregar `https://URL-DEL-FRONTEND.vercel.app/accept-invite`.
- **Redirect URLs**: agregar también `https://URL-DEL-FRONTEND.vercel.app/reset-password`.

Para el desarrollo local se puede conservar además:

```text
http://localhost:5173/accept-invite
http://localhost:5173/reset-password
```

## 5. Base de datos de producción

No conectar el despliegue a `FitLab-database` hasta:

1. Ejecutar allí, en orden, las migraciones `0001` a `0016`.
2. Crear un owner real para el primer gimnasio.
3. Configurar su sucursal y horarios.
4. Reemplazar en Vercel las variables que actualmente apunten a desarrollo.

## 6. Prueba mínima después del despliegue

1. Abrir `/api/health` en el backend.
2. Iniciar sesión como owner desde el frontend.
3. Abrir Dashboard, Miembros, Membresías, Asistencias y Horarios.
4. Iniciar sesión como miembro y abrir `/portal`.
5. Recargar directamente `/portal` y verificar que no aparece un error 404.
6. Registrar un pago y una asistencia de prueba; luego comprobar el dashboard.

## Funciones aplazadas conscientemente

- Google Login.
- SMTP propio para invitaciones sin el límite de prueba de Supabase.
- QR físico firmado por sucursal; el botón actual es únicamente el modo MVP.
- Cobros automáticos con Stripe y DEUNA.
- Clases extra, productos/POS y gestión visual completa del personal.
