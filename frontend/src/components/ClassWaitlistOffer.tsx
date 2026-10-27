import { useEffect, useRef, useState } from 'react';
import { offerRemainingSeconds, type ClassWaitlistEntry } from '../utils/classWaitlist';

export function ClassWaitlistOffer({ entry, serverTime, receivedAt, busy, disabled, onAccept, onReject, onRefresh }: {
  entry: ClassWaitlistEntry;
  serverTime?: string;
  receivedAt?: number;
  busy?: boolean;
  disabled?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
  onRefresh?: () => void;
}) {
  // Monotonic elapsed time avoids relying on the phone's wall clock/timezone.
  const [elapsedMs, setElapsedMs] = useState(0);
  const refreshed = useRef<string | null>(null);
  useEffect(() => {
    const start = receivedAt ?? performance.now();
    const tick = () => setElapsedMs(Math.max(0, performance.now() - start));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [serverTime, receivedAt, entry.offer_id]);
  const remaining = entry.expires_at ? offerRemainingSeconds(entry.expires_at, serverTime, elapsedMs) : null;
  useEffect(() => {
    if (remaining === 0 && entry.offer_id && refreshed.current !== entry.offer_id) {
      refreshed.current = entry.offer_id;
      onRefresh?.();
    }
  }, [remaining, entry.offer_id, onRefresh]);
  const label = remaining === null ? 'Consulta la vigencia al aceptar.' : remaining === 0
    ? 'Plazo visual finalizado. Verificando disponibilidad…'
    : `Tiempo aproximado: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  return <div className="class-waitlist-offer" style={{ display: 'grid', gap: '.45rem', minWidth: 0, overflowWrap: 'anywhere' }}>
    <strong>Se liberó un cupo para ti</strong>
    <small>{label}</small>
    {entry.expires_at && <small>Vence: <time dateTime={entry.expires_at}>{new Date(entry.expires_at).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}</time></small>}
    <button className="primary" disabled={busy || disabled || !entry.offer_id} onClick={onAccept}>{busy ? 'Procesando…' : 'Aceptar cupo'}</button>
    <button className="small-button danger-text" disabled={busy} onClick={onReject}>Rechazar</button>
    <small>El servidor confirma la vigencia. La oferta todavía no es una reserva.</small>
  </div>;
}
