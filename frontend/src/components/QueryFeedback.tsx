type ReadQuery = { data: unknown; isPending: boolean; isError: boolean; refetch: () => unknown };

/** undefined means no successful response yet; null/[]/0 may be valid data. */
export function QueryFeedback({ query, label }: { query: ReadQuery; label: string }) {
  if (query.isError) return <div className="alert error" role="alert">
    {query.data === undefined ? `No pudimos cargar ${label}.` : `No pudimos actualizar ${label}. Mostramos la última información disponible.`}
    {' '}<button type="button" onClick={() => void query.refetch()}>{`Reintentar ${label}`}</button>
  </div>;
  if (query.data === undefined && query.isPending) return <p role="status">Cargando {label}…</p>;
  return null;
}

type PagedReadQuery = ReadQuery & { isFetchNextPageError: boolean; isFetchingNextPage: boolean; isFetching: boolean; hasNextPage: boolean; fetchNextPage: () => unknown };

export function HistoryPageFeedback({ query, label }: { query: PagedReadQuery; label: string }) {
  if (query.isFetchNextPageError) return <div className="alert error" role="alert">
    No pudimos cargar más registros. Los anteriores siguen disponibles.{' '}
    <button type="button" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>Reintentar cargar más</button>
  </div>;
  return <>
    <QueryFeedback query={query} label={label}/>
    {query.hasNextPage && <button type="button" className="ghost" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Cargando más…' : 'Cargar más'}</button>}
  </>;
}
