import type { QueryClient } from '@tanstack/react-query';

export type ClassWaitlistEntry = {
  id: string;
  status: 'waiting' | 'offered';
  state: 'waiting' | 'offered';
  position: number;
  offer_id?: string | null;
  offered_at?: string | null;
  expires_at?: string | null;
};

// Presentation only. PostgreSQL decides expiry/availability on every mutation.
export function offerRemainingSeconds(expiresAt: string, serverTime: string | undefined, elapsedMs = 0): number | null {
  const expiry = Date.parse(expiresAt);
  const serverNow = serverTime ? Date.parse(serverTime) : NaN;
  if (!Number.isFinite(expiry) || !Number.isFinite(serverNow)) return null;
  return Math.max(0, Math.ceil((expiry - serverNow - Math.max(0, elapsedMs)) / 1000));
}

export function classWaitlistPollInterval(schedules: Array<{ myWaitlist?: ClassWaitlistEntry | null }> | undefined): number | false {
  if (schedules?.some(item => item.myWaitlist?.status === 'offered')) return 30_000;
  if (schedules?.some(item => item.myWaitlist?.status === 'waiting')) return 60_000;
  return false;
}

export function waitlistExitNotice(state: string | undefined): string {
  if (state === 'rejected') return 'Rechazaste el cupo. Para volver a participar debes unirte de nuevo.';
  if (state === 'expired') return 'La oferta ya había expirado según el servidor. Puedes volver a unirte si sigue llena.';
  if (state === 'accepted') return 'Esta oferta ya fue aceptada. Consulta tu reserva actualizada.';
  if (state === 'cancelled') return 'Tu entrada en la lista está cerrada. Para volver a participar debes unirte de nuevo.';
  return 'Estado de la lista actualizado. Consulta tus clases antes de volver a participar.';
}

export async function refreshClassQueries(client: Pick<QueryClient, 'invalidateQueries'>) {
  await Promise.all(['my-activities', 'activities', 'activity-summary'].map(key => client.invalidateQueries({ queryKey: [key] })));
}
