import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';

export type HistoryPage<T> = { items: T[]; nextCursor: string | null };

export function useMemberHistory<T>(queryKey: QueryKey, enabled: boolean, load: (cursor: string | null, signal: AbortSignal) => Promise<HistoryPage<T>>) {
  return useInfiniteQuery({
    queryKey, enabled, initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const page = await load(pageParam, signal);
      if (!Array.isArray(page?.items) || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) {
        throw new Error('El servidor devolvió una página de historial incompleta.');
      }
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Changing filters discards unused pages; never keep another filter's data on screen.
    gcTime: 0, staleTime: 0,
  });
}
