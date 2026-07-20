# FitLab

Base arquitectónica de FitLab, un SaaS multi-tenant para gimnasios.

## Estado actual

Esta revisión contiene únicamente la estructura del repositorio y migraciones SQL pendientes de aprobación. No se han aplicado cambios a ningún proyecto Supabase.

## Estructura

```text
fitlab/
├── backend/                 # API Express + TypeScript (fase posterior)
├── frontend/                # React + TypeScript (fase posterior)
├── docs/                    # Decisiones y guía de revisión
└── supabase/
    ├── migrations/          # Migraciones versionadas; no ejecutadas
    └── tests/               # Pruebas SQL/RLS (fase posterior)
```

## Regla de seguridad

La API deberá usar un cliente de Supabase limitado por el JWT del usuario para las operaciones normales. Un cliente con clave secreta se reservará para webhooks y procesos internos expresamente autorizados.

## Revisión

Lee `docs/migration-review.md` antes de aplicar cualquier migración.
