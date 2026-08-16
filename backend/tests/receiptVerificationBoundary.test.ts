import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('recibos verificables y marca del gimnasio', () => {
  const migration = source('supabase/migrations/0026_receipt_verification_branding.sql');

  it('crea un token aleatorio, único e inmutable sin cambiar la numeración', () => {
    expect(migration).toContain('receipt_verification_token uuid not null default gen_random_uuid()');
    expect(migration).toContain('member_payments_receipt_verification_token_idx');
    expect(migration).toContain('PAYMENT_RECEIPT_VERIFICATION_TOKEN_IS_IMMUTABLE');
    expect(migration).not.toMatch(/update public\.member_payments[\s\S]*receipt_number\s*=/);
  });

  it('reserva la actualización de marca para service_role y la audita', () => {
    expect(migration).toMatch(/revoke all on function public\.update_gym_receipt_branding_backend[\s\S]*from public, anon, authenticated;/);
    expect(migration).toMatch(/grant execute on function public\.update_gym_receipt_branding_backend[\s\S]*to service_role;/);
    expect(migration).toContain('private.authorize_settings_backend_actor');
    expect(migration).toContain("'settings.receipt_branding_updated'");
  });

  it('expone solamente la verificación por token antes de exigir sesión', () => {
    const routes = source('backend/src/routes/payment.routes.ts');
    expect(routes.indexOf("paymentRouter.get('/verify/:token'")).toBeGreaterThan(-1);
    expect(routes.indexOf("paymentRouter.get('/verify/:token'")).toBeLessThan(routes.indexOf('paymentRouter.use(verifyJWT, tenantContext)'));
    expect(routes).toContain("bucket: 'receipt.verify'");
  });

  it('mantiene el detalle privado bajo permiso y usa la ruta montada real', () => {
    const routes = source('backend/src/routes/payment.routes.ts');
    const page = source('frontend/src/pages/MembershipsPage.tsx');
    expect(routes).toContain("paymentRouter.get('/:id/receipt', checkPermission('finances.view')");
    expect(page).toContain("'/member-payments'");
    expect(page).toContain('`/member-payments/${receiptId}/receipt`');
    expect(page).toContain('`/member-payments/${reverseTarget?.payment.id}/${reverseTarget?.action}`');
  });
});
