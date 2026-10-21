export type ClassBookingTerms = {
  version: number;
  billing_mode: 'included' | 'additional_fee' | null;
  agreed_amount: number | null;
  currency: string | null;
  contracted_at: string;
  cancelled_at: string | null;
  evidence_state: 'verified' | 'partial' | 'unknown';
  source: 'reservation' | 'audit_event' | 'historical_unknown' | 'manual_resolution';
};
export type ClassBookingEconomics = {
  economic_terms?: ClassBookingTerms | null;
  economic_history?: ClassBookingTerms[];
  payment_state?: string;
  payment_summary?: { amount: number; currency: string; status: string } | null;
  can_collect_payment?: boolean;
};
const money = (amount: number, currency: string) => new Intl.NumberFormat('es-EC', { style: 'currency', currency }).format(Number(amount));

export function classTermsLabel(terms?: ClassBookingTerms | null): string {
  if (terms?.billing_mode === 'included') return 'Incluida en tu membresía';
  if (terms?.evidence_state === 'verified' && terms.agreed_amount != null && terms.currency) {
    return `${money(terms.agreed_amount, terms.currency)} · importe acordado`;
  }
  return 'Condiciones originales no verificadas';
}

export function classPaymentLabel(booking: ClassBookingEconomics): string {
  const paid = booking.payment_summary;
  const amount = paid ? money(paid.amount, paid.currency) : null;
  switch (booking.payment_state) {
    case 'confirmed': return amount ? `Pago confirmado: ${amount}` : 'Pago confirmado';
    case 'refunded': return amount ? `Reembolsado: ${amount}` : 'Pago reembolsado';
    case 'voided': return 'Pago anulado';
    case 'failed': return 'Pago fallido';
    case 'registered': return 'Pago registrado';
    case 'included': return 'Incluida';
    case 'pending': return 'Pago pendiente en recepción';
    default: return 'Condiciones pendientes de resolución en recepción';
  }
}
