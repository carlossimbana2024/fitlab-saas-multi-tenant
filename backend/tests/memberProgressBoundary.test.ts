import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('seguimiento privado de progreso del miembro', () => {
  it('crea el historial de peso con restricciones tenant-scoped y backfill inicial', () => {
    const migration = source('supabase/migrations/0034_member_progress_tracking.sql');
    expect(migration).toContain('create table public.member_weight_entries');
    expect(migration).toContain('unique (gym_id, member_user_id, measured_on)');
    expect(migration).toContain('weight_kg between 20 and 500');
    expect(migration).toContain('member_weight_entries_select_self');
    expect(migration).toContain('upsert_member_weight_backend');
    expect(migration).toContain('revoke all on function public.upsert_member_weight_backend');
    expect(migration).toContain('grant execute on function public.upsert_member_weight_backend');
    expect(migration).toContain('member_fitness_profiles_seed_weight');
    expect(migration).toContain("'onboarding'");
  });

  it('expone únicamente progreso y peso del miembro autenticado', () => {
    const controller = source('backend/src/controllers/member.controller.ts');
    const routes = source('backend/src/routes/member.routes.ts');
    expect(controller).toContain('export async function getMyProgress');
    expect(controller).toContain('export async function recordMyWeight');
    expect(controller).toContain("rpc('upsert_member_weight_backend'");
    expect(controller).toContain(".eq('gym_id', request.tenant!.gymId)");
    expect(controller).toContain(".eq('member_user_id', request.tenant!.gymUserId)");
    expect(routes).toContain("memberRouter.get('/me/progress'");
    expect(routes).toContain("memberRouter.post('/me/weight'");
  });

  it('muestra motivación, tendencias de asistencia y evolución privada de peso', () => {
    const portal = source('frontend/src/pages/MemberPortalPage.tsx');
    const styles = source('frontend/src/styles.css');
    expect(portal).toContain("'/members/me/progress'");
    expect(portal).toContain("'/members/me/weight'");
    expect(portal).toContain('progress-motivation');
    expect(portal).toContain('attendanceByMonth');
    expect(portal).toContain('weight-chart');
    expect(portal).toContain('Registrar peso');
    expect(styles).toContain('.attendance-chart');
    expect(styles).toContain('.weight-progress-track');
  });
});
