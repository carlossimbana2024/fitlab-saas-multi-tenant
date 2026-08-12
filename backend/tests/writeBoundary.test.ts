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
      'backend/src/controllers/settings.controller.ts',
    ]) {
      expect(source(file), file).toContain(".eq('gym_id', request.tenant!.gymId)");
    }
  });

  it('revoca escrituras y RPC directas al rol authenticated', () => {
    const migration = source('supabase/migrations/0018_backend_only_writes.sql');
    expect(migration).toMatch(/revoke insert, update, delete, truncate, references, trigger[\s\S]*from authenticated;/);
    expect(migration).toMatch(/revoke execute[\s\S]*from public, anon, authenticated;/);
  });
});
