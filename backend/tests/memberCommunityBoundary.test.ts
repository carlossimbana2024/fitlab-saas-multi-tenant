import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Comunidad privada del miembro', () => {
  it('guarda reacciones tenant-scoped y las limita a perfiles visibles', () => {
    const migration = source('supabase/migrations/0035_member_community_reactions.sql');
    expect(migration).toContain('create table public.member_community_reactions');
    expect(migration).toContain('unique (gym_id, actor_member_user_id, target_member_user_id)');
    expect(migration).toContain('member_community_reactions_validate');
    expect(migration).toContain('target_profile.show_in_community is not true');
    expect(migration).toContain('toggle_member_community_reaction_backend');
    expect(migration).toContain('revoke all on function public.toggle_member_community_reaction_backend');
    expect(migration).toContain('grant execute on function public.toggle_member_community_reaction_backend');
  });

  it('aplica el aislamiento por gimnasio y miembro autenticado en backend', () => {
    const controller = source('backend/src/controllers/memberCommunity.controller.ts');
    const routes = source('backend/src/routes/member.routes.ts');
    expect(controller).toContain('export async function listMemberCommunity');
    expect(controller).toContain('export async function toggleMemberCommunityReaction');
    expect(controller).toContain(".eq('gym_id', request.tenant!.gymId)");
    expect(controller).toContain("p_actor_member_user_id: request.tenant!.gymUserId");
    expect(controller).toContain('p_target_gym_id: request.tenant!.gymId');
    expect(controller).toContain('p_target_member_user_id: input.data.targetMemberUserId');
    expect(controller).toContain('p_supplied_reaction_type: input.data.reactionType');
    expect(controller).toContain('member.id !== request.tenant!.gymUserId');
    expect(controller).toContain('show_in_community');
    expect(routes).toContain("memberRouter.get('/me/community'");
    expect(routes).toContain("memberRouter.post('/me/community/reactions'");
  });

  it('ofrece filtros, perfiles sin datos sensibles y reacciones positivas', () => {
    const page = source('frontend/src/pages/MemberCommunityPage.tsx');
    const layout = source('frontend/src/components/MemberPortalLayout.tsx');
    const app = source('frontend/src/App.tsx');
    expect(page).toContain("'/members/me/community'");
    expect(page).toContain("'/members/me/community/reactions'");
    expect(page).toContain('Objetivos similares');
    expect(page).toContain('Me gusta');
    expect(page).toContain('Me encanta');
    expect(layout).toContain("'/portal/community'");
    expect(app).toContain('MemberCommunityPage');
  });
});
