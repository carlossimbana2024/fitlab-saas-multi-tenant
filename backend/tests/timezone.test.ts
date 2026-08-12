import { describe, expect, it } from 'vitest';
import { isValidTimeZone } from '../src/utils/timezone.js';

describe('validaciÃ³n de zona horaria', () => {
  it('acepta zonas IANA disponibles en el runtime', () => {
    expect(isValidTimeZone('America/Guayaquil')).toBe(true);
    expect(isValidTimeZone('Europe/Madrid')).toBe(true);
  });

  it('rechaza nombres inventados o vacÃ­os', () => {
    expect(isValidTimeZone('FitLab/Quito')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
