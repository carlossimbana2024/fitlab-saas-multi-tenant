import { isIP } from 'node:net';
import type { Request } from 'express';
import { supabaseAdmin } from '../config/supabase.js';

type AuditInput = {
  action: string;
  entityType: string;
  entityId?: string | null;
  permissionKey?: string | null;
  beforeData?: unknown;
  afterData?: unknown;
};

function requestIp(request: Request): string | null {
  const value = request.ip || request.socket.remoteAddress || '';
  const normalized = value.startsWith('::ffff:') ? value.slice(7) : value;
  return isIP(normalized) ? normalized : null;
}

export async function writeAuditLog(request: Request, input: AuditInput): Promise<void> {
  const tenant = request.tenant!;
  const { error } = await supabaseAdmin.from('audit_logs').insert({
    gym_id: tenant.gymId,
    actor_profile_id: request.authUser?.id ?? null,
    actor_gym_user_id: tenant.gymUserId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    permission_key: input.permissionKey ?? request.permissionContext?.permissionKey ?? null,
    used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
    before_data: input.beforeData ?? null,
    after_data: input.afterData ?? null,
    ip_address: requestIp(request),
    user_agent: request.get('user-agent')?.slice(0, 1000) ?? null,
  });
  if (error) console.error('AUDIT_LOG_WRITE_FAILED', error.message);
}
