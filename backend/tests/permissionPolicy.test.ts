import { describe, expect, it } from 'vitest';
import { decidePermission } from '../src/security/permissionPolicy.js';

describe('decidePermission', () => {
  it('permite siempre al owner', () => {
    expect(decidePermission('owner', null)).toBe('allow');
    expect(decidePermission('owner', 'denied')).toBe('allow');
  });

  it('permite al staff con access_mode allowed', () => {
    expect(decidePermission('staff', 'allowed')).toBe('allow');
  });

  it('exige elevación únicamente al staff con requires_pin', () => {
    expect(decidePermission('staff', 'requires_pin')).toBe('require_elevation');
  });

  it('deniega permisos ausentes o denied', () => {
    expect(decidePermission('staff', 'denied')).toBe('deny');
    expect(decidePermission('staff', undefined)).toBe('deny');
    expect(decidePermission('member', 'allowed')).toBe('deny');
  });
});
