export const membershipPaymentMethodLabels: Record<string, string> = { bank_transfer: 'Transferencia bancaria', deposit: 'Depósito', other: 'Otro método', cash: 'Efectivo', external_card: 'Tarjeta externa', external_deuna: 'DEUNA' };
export const membershipPaymentStatusLabels: Record<string, string> = { draft: 'Borrador', pending: 'En revisión', approved: 'Aprobado', rejected: 'Rechazado', revision_requested: 'Corrección solicitada', cancelled: 'Cancelado', confirmed: 'Confirmado', voided: 'Anulado', refunded: 'Reembolsado' };
export type MembershipPaymentPlan = { id: string; name: string; price: number; currency: string; duration_unit: string; duration_value: number };
export type MembershipPaymentRequest = { id: string; location_id: string; member_user_id: string; member_name?: string; plan_id: string; plan_snapshot: MembershipPaymentPlan; amount: number; currency: string; status: string; channel?: string; method?: string; paid_on?: string; reference?: string; comment?: string; review_reason?: string; expires_at: string; created_at: string; payment_id?: string };
export const membershipMoney = (amount: number, currency: string) => new Intl.NumberFormat('es-EC', { style: 'currency', currency }).format(Number(amount));
export function gymWhatsAppNumber(value: string | null | undefined): string | null {
  let number = value?.replace(/\D/g, '') ?? '';
  if (number.startsWith('00')) number = number.slice(2);
  if (/^09\d{8}$/.test(number)) number = `593${number.slice(1)}`;
  return /^[1-9]\d{7,14}$/.test(number) ? number : null;
}
export function membershipWhatsAppMessage(name: string, memberId: string, payment: MembershipPaymentRequest): string {
  return `Hola, soy ${name}. Realicé el pago de mi membresía de ${payment.plan_snapshot.name}.\nValor: ${membershipMoney(payment.amount, payment.currency)}\nFecha: ${payment.paid_on ?? ''}\nMiembro: ${memberId}\nSolicitud: ${payment.id}${payment.reference ? `\nReferencia: ${payment.reference}` : ''}\nTe envío mi comprobante para validación.`;
}
