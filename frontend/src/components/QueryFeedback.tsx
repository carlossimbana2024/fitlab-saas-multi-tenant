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
