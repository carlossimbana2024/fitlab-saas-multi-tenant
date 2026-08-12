import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const migration = readFileSync(join(root, 'supabase/migrations/0019_identity_abuse_audit_managed_members.sql'), 'utf8');

describe('lÃ­mite de identidad para miembros administrados', () => {
  it('exige que un miembro sin cuenta no tenga perfil Auth y sÃ­ tenga nombre', () => {
    expect(migration).toMatch(/account_mode = 'managed'[\s\S]*role = 'member'[\s\S]*profile_id is null/);
    expect(migration).toMatch(/managed_full_name is not null/);
  });

  it('mantiene las RPC sensibles reservadas para service_role', () => {
    for (const functionName of ['register_member_invitation', 'accept_member_invitation', 'revoke_member_invitation', 'create_managed_member', 'consume_api_rate_limit']) {
      expect(migration, functionName).toMatch(new RegExp(`revoke all on function public\\.${functionName}[\\s\\S]*?from public, anon, authenticated;`));
      expect(migration, functionName).toMatch(new RegExp(`grant execute on function public\\.${functionName}[\\s\\S]*?to service_role;`));
    }
  });

  it('contabiliza bloqueos de PIN por gimnasio y empleado', () => {
    expect(migration).toMatch(/primary key \(gym_id, staff_user_id\)/);
    expect(migration).toMatch(/next_failed_attempts >= 5[\s\S]*interval '15 minutes'/);
  });

  it('permite asistencia manual sin habilitar QR para una identidad administrada', () => {
    expect(migration).toMatch(/member_record\.id is null[\s\S]*ATTENDANCE_REQUIRES_ACTIVE_MEMBER/);
    expect(migration).toMatch(/new\.source = 'staff'[\s\S]*new\.source = 'qr'/);
    expect(migration).toMatch(/member_record\.account_mode <> 'portal'[\s\S]*QR_ATTENDANCE_REQUIRES_PORTAL_MEMBER/);
  });
});
