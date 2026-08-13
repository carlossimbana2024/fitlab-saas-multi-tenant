import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

function source(path: string) {
  return readFileSync(join(root, path), 'utf8');
}

describe('límite de escritura del backend', () => {
  it('no deja mutaciones de tablas en el cliente JWT', () => {
    const files = [
      'backend/src/controllers/attendance.controller.ts',
      'backend/src/controllers/calendar.controller.ts',
      'backend/src/controllers/member.controller.ts',
      'backend/src/controllers/payment.controller.ts',
      'backend/src/controllers/plan.controller.ts',
      'backend/src/controllers/settings.controller.ts',
    ];
    const userClientMutation = /request\.supabase!\s*\.from\([^)]*\)\s*\.(?:insert|update|upsert|delete)\(/s;

    for (const file of files) expect(source(file), file).not.toMatch(userClientMutation);
  });

  it('mantiene filtro de tenant en las actualizaciones sensibles', () => {
    for (const file of [
      'backend/src/controllers/attendance.controller.ts',
      'backend/src/controllers/payment.controller.ts',
    ]) {
      expect(source(file), file).toContain(".eq('gym_id', request.tenant!.gymId)");
    }
  });

  it('encapsula los cambios de configuraciÃ³n en RPC backend-only con actor y tenant', () => {
    const controller = source('backend/src/controllers/settings.controller.ts');
    expect(controller).toContain("rpc('update_gym_settings_backend'");
    expect(controller).toContain("rpc('update_location_settings_backend'");
    expect(controller).toContain('target_gym_id: request.tenant!.gymId');
    expect(controller).toContain('target_actor_gym_user_id: request.tenant!.gymUserId');
    expect(controller).not.toMatch(/supabaseAdmin\.from\(['"](?:gyms|gym_locations)['"]\)\.update/);
  });

  it('revoca escrituras y RPC directas al rol authenticated', () => {
    const migration = source('supabase/migrations/0018_backend_only_writes.sql');
    expect(migration).toMatch(/revoke insert, update, delete, truncate, references, trigger[\s\S]*from authenticated;/);
    expect(migration).toMatch(/revoke execute[\s\S]*from public, anon, authenticated;/);
  });

  it('reserva las RPC de configuraciÃ³n 0020 para service_role y audita dentro de SQL', () => {
    const migration = source('supabase/migrations/0020_backend_settings_writes.sql');
    for (const functionName of ['update_gym_settings_backend', 'update_location_settings_backend']) {
      expect(migration, functionName).toMatch(
        new RegExp(`revoke all on function public\\.${functionName}[\\s\\S]*?from public, anon, authenticated;`),
      );
      expect(migration, functionName).toMatch(
        new RegExp(`grant execute on function public\\.${functionName}[\\s\\S]*?to service_role;`),
      );
    }
    expect(migration).toContain("'settings.gym_updated'");
    expect(migration).toContain("'settings.location_updated'");
    expect(migration).toContain('private.authorize_settings_backend_actor');
  });
});
