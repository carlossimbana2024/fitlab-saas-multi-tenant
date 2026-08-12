export type GymRole = 'owner' | 'staff' | 'member';
export type PermissionAccessMode = 'allowed' | 'requires_pin' | 'denied' | null | undefined;
export type PermissionDecision = 'allow' | 'require_elevation' | 'deny';

export function decidePermission(role: GymRole, accessMode: PermissionAccessMode): PermissionDecision {
  if (role === 'owner') return 'allow';
  if (role !== 'staff') return 'deny';
  if (accessMode === 'allowed') return 'allow';
  if (accessMode === 'requires_pin') return 'require_elevation';
  return 'deny';
}
