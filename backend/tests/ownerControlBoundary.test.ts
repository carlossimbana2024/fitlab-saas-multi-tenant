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
});
