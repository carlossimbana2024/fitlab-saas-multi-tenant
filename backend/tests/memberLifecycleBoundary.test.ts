import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');
const migration = source('supabase/migrations/0024_member_lifecycle.sql');

describe('ciclo de vida seguro de miembros', () => {
  it('reserva las escrituras para service_role', () => {
    for (const functionName of [
      'update_member_backend',
      'change_member_status_backend',
      'convert_managed_member_to_portal_backend',
    ]) {
      expect(migration, functionName).toMatch(
        new RegExp(`revoke all on function public\\.${functionName}[\\s\\S]*?from public, anon, authenticated;`),
      );
      expect(migration, functionName).toMatch(
        new RegExp(`grant execute on function public\\.${functionName}[\\s\\S]*?to service_role;`),
      );
    }
  });

  it('autoriza members.manage y conserva la identidad al retirar o convertir', () => {
    expect(migration).toContain('private.authorize_members_backend_actor');
    expect(migration).toContain("permission.permission_key = 'members.manage'");
    expect(migration).toContain("'history_preserved', true");
    expect(migration).toMatch(/update public\.gym_users[\s\S]*account_mode = 'portal'/);
    expect(migration).toContain('joined_at = coalesce(joined_at, now())');
  });

  it('el controlador filtra siempre por gimnasio y usa RPC backend-only', () => {
    const controller = source('backend/src/controllers/member.controller.ts');
    expect(controller).toContain(".eq('gym_id', request.tenant!.gymId)");
    expect(controller).toContain("rpc('update_member_backend'");
    expect(controller).toContain("rpc('change_member_status_backend'");
    expect(controller).not.toMatch(/request\.supabase!\s*\.from\([^)]*\)\s*\.(?:insert|update|upsert|delete)\(/s);
  });

  it('separa el directorio enriquecido del cache de listas usado por el dashboard', () => {
    const membersPage = source('frontend/src/pages/MembersPage.tsx');
    const dashboard = source('frontend/src/pages/DashboardPage.tsx');
    expect(membersPage).toContain("queryKey: ['members-directory']");
    expect(membersPage).toContain("queryClient.invalidateQueries({ queryKey: ['members-directory'] })");
    expect(dashboard).toContain("queryKey: ['members']");
    expect(membersPage).not.toMatch(/useQuery\(\{ queryKey: \['members'\]/);
  });
});
