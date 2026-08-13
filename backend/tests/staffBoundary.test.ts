import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('limite de seguridad del modulo de personal', () => {
  it('reserva todas las rutas de personal para el owner', () => {
    const routes = source('backend/src/routes/staff.routes.ts');
    expect(routes).toContain('staffRouter.use(verifyJWT, tenantContext, requireOwner)');
    expect(source('backend/src/middlewares/requireOwner.ts')).toContain("request.tenant?.role !== 'owner'");
  });

  it('realiza las mutaciones mediante RPC backend-only', () => {
    const controller = source('backend/src/controllers/staff.controller.ts');
    for (const rpc of ['update_staff_permissions_backend', 'update_staff_status_backend', 'revoke_staff_invitation']) {
      expect(controller).toContain(`rpc('${rpc}'`);
    }
    expect(controller).not.toMatch(/request\.supabase!\s*\.from\([^)]*\)\s*\.(?:insert|update|upsert|delete)\(/s);
  });

  it('protege las RPC 0021 y exige owner activo dentro de SQL', () => {
    const migration = source('supabase/migrations/0021_staff_accounts_permissions.sql');
    for (const functionName of [
      'register_staff_invitation', 'accept_portal_invitation',
      'update_staff_permissions_backend', 'update_staff_status_backend',
      'revoke_staff_invitation',
    ]) {
      expect(migration, functionName).toMatch(new RegExp(`revoke all on function public\\.${functionName}[\\s\\S]*?from public, anon, authenticated;`));
      expect(migration, functionName).toMatch(new RegExp(`grant execute on function public\\.${functionName}[\\s\\S]*?to service_role;`));
    }
    expect(migration).toMatch(/gu\.role = 'owner'[\s\S]*gu\.status = 'active'/);
    expect(migration).toContain("'staff.permissions_updated'");
    expect(migration).toContain("'staff.status_updated'");
  });

  it('acepta invitaciones de miembro y staff sin confiar en un rol del cliente', () => {
    const controller = source('backend/src/controllers/auth.controller.ts');
    expect(controller).toContain(".in('role', ['member', 'staff'])");
    expect(controller).toContain("rpc('accept_portal_invitation'");
    expect(controller).toContain('pendingInvitation.intended_role !== pendingAccount.role');
  });
});
