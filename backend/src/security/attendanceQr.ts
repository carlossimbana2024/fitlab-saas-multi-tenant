import { createHash, randomBytes } from 'node:crypto';

export function hashAttendanceQr(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createAttendanceQr(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashAttendanceQr(token) };
}
