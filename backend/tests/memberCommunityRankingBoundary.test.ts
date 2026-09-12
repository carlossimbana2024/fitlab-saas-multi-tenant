import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('límites de rankings mensuales de Comunidad', () => {
  it('reconstruye los períodos desde fuentes originales indexadas', () => {
    const migration = source('supabase/migrations/0036_community_ranking_indexes.sql');
    expect(migration).toContain('attendances_community_ranking_idx');
    expect(migration).toContain("where status = 'valid'");
    expect(migration).toContain('member_weight_entries_community_ranking_idx');
  });

  it('aplica gimnasio, privacidad y categorías independientes en backend', () => {
    const controller = source('backend/src/controllers/memberCommunityRanking.controller.ts');
    const routes = source('backend/src/routes/member.routes.ts');
    expect(controller).toContain(".eq('gym_id', request.tenant!.gymId)");
    expect(controller).toContain(".eq('show_in_community', true)");
    expect(controller).toContain('show_attendance_count');
    expect(controller).toContain('show_streak');
    expect(controller).toContain('show_weight_progress');
    expect(controller).toContain("historyMode: 'reconstructed'");
    expect(controller).toContain('nunca compara kilos absolutos');
    expect(routes).toContain("memberRouter.get('/me/community/rankings'");
  });

  it('muestra selector histórico y tres Top 3 separados', () => {
    const page = source('frontend/src/pages/MemberCommunityPage.tsx');
    const controller = source('backend/src/controllers/memberCommunityRanking.controller.ts');
    expect(page).toContain("'/members/me/community/rankings'");
    expect(page).toContain('Top 3 del mes');
    expect(page).toContain('ranking.categories.attendance');
    expect(page).toContain('ranking.categories.streak');
    expect(page).toContain('ranking.categories.progress');
    expect(controller).toContain('Más asistencias del mes');
    expect(controller).toContain('Mayor racha del mes');
    expect(controller).toContain('Mayor progreso hacia su meta');
  });
});
