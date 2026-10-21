// Contract evidence and money actually paid are independent facts.
// Never fill missing historical conditions from the current activity catalog.
export type ClassTermsRow = {
  version: number;
  billing_mode: 'included' | 'additional_fee' | null;
  agreed_amount: number | null;
  currency: string | null;
  contracted_at: string;
  cancelled_at: string | null;
  evidence_state: 'verified' | 'partial' | 'unknown';
  source: 'reservation' | 'audit_event' | 'historical_unknown' | 'manual_resolution';
  payment_evidence_id: string | null;
};
type Payment = { amount: number; currency: string; status: string };

export function classBookingEconomics(
  booking: { status: string; payment_id?: string | null },
  versions: ClassTermsRow[],
  payment?: Payment,
) {
  const history = [...versions].sort((a, b) => b.version - a.version);
  const current = history[0];
  const paymentState = payment ? payment.status
    : booking.payment_id || current?.payment_evidence_id ? 'registered'
    : current?.billing_mode === 'included' ? 'included'
    : current?.evidence_state === 'verified' && current.billing_mode === 'additional_fee' ? 'pending'
    : 'resolution_required';
  const publicTerms = (row: ClassTermsRow) => {
    const { payment_evidence_id: _paymentId, ...terms } = row;
    return terms;
  };
  return {
    economic_terms: current ? publicTerms(current) : null,
    economic_history: history.map(publicTerms),
    payment_state: paymentState,
    payment_summary: payment ? { amount: payment.amount, currency: payment.currency, status: payment.status } : null,
    can_collect_payment: booking.status === 'reserved' && paymentState === 'pending'
      && current?.evidence_state === 'verified' && current.billing_mode === 'additional_fee'
      && !booking.payment_id && !current.payment_evidence_id,
  };
}
