import { createHash } from 'node:crypto';

export function hashRateLimitSubject(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

export function normalizedEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : 'invalid-email';
}
