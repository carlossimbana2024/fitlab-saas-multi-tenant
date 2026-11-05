import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock3 } from 'lucide-react';
import { api } from '../services/api';
import { statusDeadline, watchBranchStatus, type BranchOpenStatus as Status } from '../utils/branchOpenStatus';
import { formatBranchInstant } from '../utils/portalTime';

export function BranchOpenStatus({ gymId, memberId, locationId, name }: { gymId?: string; memberId?: string; locationId?: string | null; name?: string }) {
  const enabled = Boolean(gymId && memberId && locationId);
  const query = useQuery({
    queryKey: ['branch-open-status', gymId, memberId, locationId], enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<Status>('/calendar/open-status', { params: { locationId }, signal });
      if (typeof data.isOpenNow !== 'boolean' || !Number.isFinite(statusDeadline(data))) throw new Error('Invalid branch status');
      // Do not spin on an expired response (or a badly skewed device clock).
      if (statusDeadline(data) <= Date.now()) throw new Error('Expired branch status');
      return data;
    },
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: true,
  });
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof document === 'undefined') return;
    return watchBranchStatus(query.isError ? undefined : query.data, () => { void query.refetch({ cancelRefetch: false }); });
  }, [enabled, gymId, memberId, locationId, query.data, query.dataUpdatedAt, query.isError, query.refetch]);
  const unknown = !enabled || query.isError;
  const loading = query.isFetching || query.isPending;
  const state = unknown ? 'unknown' : loading ? 'loading' : query.data?.isOpenNow ? 'open' : 'closed';
  return <section className={`today-status ${state}`} aria-live="polite"><Clock3/><div>
    <strong>{state === 'unknown' ? 'Estado de sucursal no disponible' : state === 'loading' ? 'Consultando horario…' : state === 'open' ? 'Abierto ahora' : 'Cerrado ahora'}</strong>
    <span>{unknown ? 'No se pudo confirmar si está abierta.' : query.data?.timezone ? `Horario de la sucursal · ${query.data.timezone}` : 'Consultando la sucursal'}</span>
    {!unknown && !loading && query.data?.nextTransitionAt && query.data.nextState && <span>
      {query.data.nextState === 'open' ? 'Próxima apertura: ' : 'Próximo cierre: '}
      {formatBranchInstant(query.data.nextTransitionAt, query.data.timezone, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
    </span>}
    {enabled && query.isError && <button type="button" onClick={() => void query.refetch()}>Reintentar</button>}
  </div><small>{name}</small></section>;
}
