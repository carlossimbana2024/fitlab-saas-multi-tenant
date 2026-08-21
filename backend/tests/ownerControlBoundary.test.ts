import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('control y auditoría exclusiva del owner', () => {
  it('protege todas las rutas mediante identidad, tenant y owner', () => {
    const routes = source('backend/src/routes/ownerControl.routes.ts');
    expect(routes).toContain('ownerControlRouter.use(verifyJWT, tenantContext, requireOwner)');
    expect(routes).toContain("ownerControlRouter.get('/report'");
    expect(routes).toContain("ownerControlRouter.get('/audit'");
  });

  it('mantiene el módulo exclusivamente de lectura', () => {
    const controller = source('backend/src/controllers/ownerControl.controller.ts');
    for (const table of ['member_payments', 'gym_users', 'memberships', 'attendances', 'audit_logs']) {
      expect(controller).toContain(`from('${table}')`);
    }
    expect(controller).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
  });

  it('filtra por gimnasio y pagina la auditoría', () => {
    const controller = source('backend/src/controllers/ownerControl.controller.ts');
    expect(controller).toContain(".eq('gym_id', request.tenant!.gymId)");
    expect(controller).toContain("{ count: 'exact' }");
    expect(controller).toContain('.range(offset, offset + pageSize - 1)');
  });

  it('la base de datos mantiene la auditoría inmutable y solo visible al owner', () => {
    const schema = source('supabase/migrations/0006_commerce_shifts_saas_audit.sql');
    const policies = source('supabase/migrations/0007_rls.sql');
    expect(schema).toContain('create trigger audit_logs_immutable before update on public.audit_logs');
    expect(policies).toContain('create policy audit_logs_owner_read on public.audit_logs');
    expect(policies).toContain('(select private.is_owner())');
  });

  it('la página no contiene controles para modificar auditoría', () => {
    const page = source('frontend/src/pages/OwnerControlPage.tsx');
    expect(page).toContain("api.get<OwnerReport>('/owner-control/report'");
    expect(page).toContain("api.get<AuditResponse>('/owner-control/audit'");
    expect(page).not.toMatch(/api\.(post|put|patch|delete)\([^)]*owner-control/);
  });

  it('presenta permisos con nombres comprensibles y conserva el JSON como detalle técnico', () => {
    const controller = source('backend/src/controllers/ownerControl.controller.ts');
    const page = source('frontend/src/pages/OwnerControlPage.tsx');
    expect(controller).toContain("from('permission_catalog')");
    expect(controller).toContain('entityName: entityUser ? actorName(entityUser) : null');
    expect(page).toContain("'staff.permissions_updated': 'Actualizó los permisos de un empleado'");
    expect(page).toContain("requires_pin: 'Requiere PIN'");
    expect(page).toContain('Ver datos técnicos (JSON)');
  });

  it('los cambios futuros de permisos guardan las matrices anterior y posterior', () => {
    const migration = source('supabase/migrations/0027_staff_permission_audit_snapshots.sql');
    expect(migration).toContain('previous_permissions jsonb');
    expect(migration).toContain('resulting_permissions jsonb');
    expect(migration).toMatch(/entity_id, permission_key, before_data, after_data/);
    expect(migration).toMatch(/'staff\.permissions_updated'[\s\S]*previous_permissions, resulting_permissions/);
    expect(migration).toMatch(/revoke all on function public\.update_staff_permissions_backend[\s\S]*from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function public\.update_staff_permissions_backend[\s\S]*to service_role/);
  });
});
