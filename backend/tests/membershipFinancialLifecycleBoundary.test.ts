import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');
const migration = source('supabase/migrations/0025_membership_renewal_receipts.sql');

describe('renovaciones, recibos y reversiones financieras', () => {
  it('reserva las mutaciones financieras para service_role', () => {
    for (const functionName of [
      'register_manual_membership_checkout',
      'cancel_membership_backend',
      'reverse_member_payment_backend',
    ]) {
      expect(migration, functionName).toMatch(
        new RegExp(`revoke all on function public\\.${functionName}[\\s\\S]*?from public, anon, authenticated;`),
      );
      expect(migration, functionName).toMatch(
        new RegExp(`grant execute on function public\\.${functionName}[\\s\\S]*?to service_role;`),
      );
    }
  });

  it('inmoviliza el recibo y conserva el precio de cada periodo', () => {
    expect(migration).toContain('PAYMENT_RECEIPT_IDENTITY_IS_IMMUTABLE');
    expect(migration).toContain('member_payments_receipt_number_idx');
    expect(migration).toContain('charged_amount numeric(12,2)');
    expect(migration).toMatch(/insert into public\.membership_periods[\s\S]*charged_amount, currency/);
  });

  it('diferencia cancelar contrato, anular pago y reembolsar', () => {
    expect(migration).toContain("'payments_unchanged', true");
    expect(migration).toContain("when 'voided' then 'payment.voided'");
    expect(migration).toContain("else 'payment.refunded'");
    expect(migration).toMatch(/old\.status = 'confirmed' and new\.status in \('voided', 'refunded'\)/);
  });

  it('usa RPC con tenant, actor y evidencia PIN desde el backend', () => {
    const membershipController = source('backend/src/controllers/membership.controller.ts');
    const paymentController = source('backend/src/controllers/payment.controller.ts');
    expect(membershipController).toContain("rpc('cancel_membership_backend'");
    expect(paymentController).toContain("rpc('reverse_member_payment_backend'");
    for (const controller of [membershipController, paymentController]) {
      expect(controller).toContain('target_gym_id: request.tenant!.gymId');
      expect(controller).toContain('supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false');
    }
    expect(paymentController).not.toMatch(/from\(['"]member_payments['"]\)\.update/);
  });
});
