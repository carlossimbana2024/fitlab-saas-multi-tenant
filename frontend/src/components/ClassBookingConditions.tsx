import { classTermsLabel, type ClassBookingEconomics } from '../utils/classBookingEconomics';

export function ClassBookingConditions({ booking }: { booking: ClassBookingEconomics }) {
  if (!('economic_terms' in booking)) return null;
  const versions = booking.economic_history ?? [];
  return <div className="class-booking-conditions" style={{ minWidth: 0, overflowWrap: 'anywhere', display: 'grid', gap: '0.25rem' }}>
    <small>{classTermsLabel(booking.economic_terms)}</small>
    {booking.economic_terms?.evidence_state === 'partial' && <small>Moneda original no documentada. Sin cobro adicional.</small>}
    {booking.economic_terms?.evidence_state === 'unknown' && booking.payment_state === 'confirmed' && <small>El pago se conserva; el importe cobrado no demuestra la cotización original.</small>}
    {versions.length > 1 && <details><summary>Historial de contrataciones ({versions.length})</summary>
      {versions.map(version => <p key={version.version}><strong>Contratación {version.version}</strong> · {classTermsLabel(version)}<br/>
        <small>{new Date(version.contracted_at).toLocaleString('es-EC')}{version.cancelled_at ? ` · Cancelada ${new Date(version.cancelled_at).toLocaleString('es-EC')}` : ''}
          {version.source === 'audit_event' ? ' · Evidencia de auditoría' : version.source === 'manual_resolution' ? ' · Resolución manual' : ''}</small>
      </p>)}
    </details>}
  </div>;
}
