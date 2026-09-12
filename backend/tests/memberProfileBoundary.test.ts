import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('perfil deportivo, privacidad y fotografía del miembro', () => {
  it('crea una tabla tenant-scoped con defaults privados y validaciones de perfil', () => {
    const migration = source('supabase/migrations/0033_member_profile_survey_privacy.sql');
    expect(migration).toContain('create table public.member_fitness_profiles');
    expect(migration).toContain('unique (member_user_id)');
    expect(migration).toContain("show_in_community boolean not null default false");
    expect(migration).toContain("show_weight_progress boolean not null default false");
    expect(migration).toContain('private.validate_member_fitness_profile');
    expect(migration).toContain("member_record.role <> 'member'");
    expect(migration).toContain("member_record.account_mode <> 'portal'");
    expect(migration).toContain('member_fitness_profiles_select_self');
  });

  it('mantiene la escritura del perfil en RPC backend-only y prepara storage privado', () => {
    const migration = source('supabase/migrations/0033_member_profile_survey_privacy.sql');
    const controller = source('backend/src/controllers/member.controller.ts');
    expect(migration).toContain('upsert_member_fitness_profile_backend');
    expect(migration).toContain('revoke all on function public.upsert_member_fitness_profile_backend');
    expect(migration).toContain('grant execute on function public.upsert_member_fitness_profile_backend');
    expect(migration).toContain("'member-avatars', 'member-avatars', false, 5242880");
    expect(controller).toContain("rpc('upsert_member_fitness_profile_backend'");
    expect(controller).toContain('export async function createMyAvatarUpload');
    expect(controller).toContain('export async function finalizeMyAvatar');
  });

  it('acota las rutas al miembro autenticado y no borra la foto al editar datos básicos', () => {
    const routes = source('backend/src/routes/member.routes.ts');
    const controller = source('backend/src/controllers/member.controller.ts');
    const auth = source('backend/src/controllers/auth.controller.ts');
    expect(routes).toContain("memberRouter.get('/me/fitness-profile'");
    expect(routes).toContain("memberRouter.put('/me/fitness-profile'");
    expect(routes).toContain("memberRouter.post('/me/avatar-upload'");
    expect(routes).toContain("memberRouter.put('/me/avatar'");
    expect(controller).toContain(".eq('gym_id', request.tenant!.gymId)");
    expect(controller).toContain(".eq('member_user_id', request.tenant!.gymUserId)");
    expect(controller).toContain('Object.prototype.hasOwnProperty.call(input.data, \'avatarUrl\')');
    expect(controller).toContain('isInternalAvatarPath');
    expect(auth).toContain('signAvatarUrl');
  });

  it('ofrece encuesta de primera entrada, carga directa y controles de privacidad', () => {
    const portal = source('frontend/src/pages/MemberPortalPage.tsx');
    expect(portal).toContain("'/members/me/fitness-profile'");
    expect(portal).toContain("'/members/me/avatar-upload'");
    expect(portal).toContain("new FormData()");
    expect(portal).toContain('member-avatar-input');
    expect(portal).toContain('showInCommunity');
    expect(portal).toContain('fitnessSetupRequired');
    expect(portal).not.toContain('URL de foto opcional');
  });
});
