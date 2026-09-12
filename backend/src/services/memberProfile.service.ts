import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';

export const MEMBER_AVATAR_BUCKET = 'member-avatars';
export const MEMBER_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const avatarExtensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const avatarPathPattern = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/i;

export function avatarExtension(contentType: string) {
  const extension = avatarExtensions[contentType.toLowerCase()];
  if (!extension) throw new AppError(400, 'UNSUPPORTED_AVATAR_TYPE', 'La foto debe ser JPG, PNG o WEBP.');
  return extension;
}

export function createAvatarPath(gymId: string, profileId: string, contentType: string) {
  return `${gymId}/${profileId}/${crypto.randomUUID()}.${avatarExtension(contentType)}`;
}

export function isInternalAvatarPath(path: string, gymId: string, profileId: string) {
  return path.startsWith(`${gymId}/${profileId}/`) && avatarPathPattern.test(path);
}

export async function signAvatarUrl(raw: string | null | undefined) {
  if (!raw) return null;
  // Preserve legacy external URLs while new uploads use private storage paths.
  if (/^https?:\/\//i.test(raw)) return raw;
  const { data, error } = await supabaseAdmin.storage
    .from(MEMBER_AVATAR_BUCKET)
    .createSignedUrl(raw, 60 * 60);
  if (error || !data?.signedUrl) {
    console.error('MEMBER_AVATAR_SIGN_FAILED', error?.message ?? 'signed URL missing');
    return null;
  }
  return data.signedUrl;
}
