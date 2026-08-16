import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('operación rápida de recepción', () => {
  it('reutiliza la protección SQL contra doble asistencia y cobertura inválida', () => {
    const attendanceSchema = source('supabase/migrations/0005_attendance_classes_streaks.sql');
    const attendanceRules = source('supabase/migrations/0015_attendance_opening_hours.sql');
    const identityRules = source('supabase/migrations/0019_identity_abuse_audit_managed_members.sql');
    expect(attendanceSchema).toMatch(/create unique index attendances_one_valid_per_day_idx[\s\S]*where status = 'valid';/);
    expect(attendanceRules).toContain('ACTIVE_MEMBERSHIP_PERIOD_REQUIRED');
    expect(identityRules).toContain('ATTENDANCE_REQUIRES_ACTIVE_MEMBER');
  });

  it('expone una vista mínima de recepción protegida por members.view', () => {
    const routes = source('backend/src/routes/attendance.routes.ts');
    const controller = source('backend/src/controllers/attendance.controller.ts');
    expect(routes).toContain("attendanceRouter.get('/reception', checkPermission('members.view')");
    expect(routes).toContain("checkPermission('attendance.register')");
    for (const table of ['gym_users', 'memberships', 'gym_locations', 'attendances', 'user_streaks']) {
      expect(controller, table).toContain(`from('${table}')`);
    }
    expect(controller).toContain(".eq('gym_id', request.tenant!.gymId)");
  });

  it('distingue estados y motivos de bloqueo antes de registrar', () => {
    const controller = source('backend/src/controllers/attendance.controller.ts');
    for (const code of [
      'MEMBER_SUSPENDED',
      'MEMBER_RETIRED',
      'ATTENDANCE_ALREADY_REGISTERED_TODAY',
      'COVERAGE_NOT_STARTED',
      'COVERAGE_EXPIRED',
      'ACTIVE_COVERAGE_REQUIRED',
    ]) expect(controller, code).toContain(code);
  });

  it('usa un único agregado y conserva el registro manual existente en la interfaz', () => {
    const page = source('frontend/src/pages/AttendancesPage.tsx');
    expect(page).toContain("api.get<ReceptionOverview>('/attendances/reception')");
    expect(page).toContain("api.post('/attendances/staff'");
    expect(page).not.toContain("api.get<{ members:");
    expect(page).not.toContain("api.get<{ memberships:");
    expect(page).toContain('Nombre o teléfono del miembro');
  });
});
