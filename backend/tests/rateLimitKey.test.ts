import { describe, expect, it } from 'vitest';
import { hashRateLimitSubject, normalizedEmail } from '../src/security/rateLimitKey.js';

describe('claves de rate limiting', () => {
  it('normaliza el correo antes de construir la clave', () => {
    expect(normalizedEmail('  Persona@Ejemplo.COM ')).toBe('persona@ejemplo.com');
    expect(normalizedEmail(undefined)).toBe('invalid-email');
  });

  it('produce un hash SHA-256 estable sin conservar el dato original', () => {
    const first = hashRateLimitSubject('198.51.100.8:persona@ejemplo.com');
    const second = hashRateLimitSubject('198.51.100.8:persona@ejemplo.com');
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain('persona');
  });
});
