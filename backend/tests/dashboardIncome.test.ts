import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarizeDashboardIncome } from '../src/services/dashboardIncome.js';
import { localMidnightAsUtc } from '../src/utils/gymDate.js';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('ingresos mensuales del dashboard', () => {
  it('separa membresías, stock, actividades y pagos sin referencia sin mezclar monedas', () => {
    const summary = summarizeDashboardIncome([
      { amount: '35.00', currency: 'USD', membership_id: 'membership', sale_id: null, class_booking_id: null },
      { amount: '8.25', currency: 'USD', membership_id: null, sale_id: 'sale', class_booking_id: null },
      { amount: '4.50', currency: 'USD', membership_id: null, sale_id: null, class_booking_id: 'booking' },
      { amount: '2.00', currency: 'USD', membership_id: null, sale_id: null, class_booking_id: null },
      { amount: '10.00', currency: 'EUR', membership_id: null, sale_id: 'sale', class_booking_id: null },
    ], 'USD');

    expect(summary).toEqual([
      {
        currency: 'EUR', amount: 10, count: 1,
        categories: {
          memberships: { amount: 0, count: 0 }, stockSales: { amount: 10, count: 1 },
          activities: { amount: 0, count: 0 }, other: { amount: 0, count: 0 },
        },
      },
      {
        currency: 'USD', amount: 49.75, count: 4,
        categories: {
          memberships: { amount: 35, count: 1 }, stockSales: { amount: 8.25, count: 1 },
          activities: { amount: 4.5, count: 1 }, other: { amount: 2, count: 1 },
        },
      },
    ]);
  });

  it('devuelve cero en la moneda del gimnasio cuando todavía no hay cobros', () => {
    expect(summarizeDashboardIncome([], 'USD')).toEqual([{
      currency: 'USD', amount: 0, count: 0,
      categories: {
        memberships: { amount: 0, count: 0 }, stockSales: { amount: 0, count: 0 },
        activities: { amount: 0, count: 0 }, other: { amount: 0, count: 0 },
      },
    }]);
  });

  it('calcula los límites mensuales según la zona horaria del gimnasio', () => {
    expect(localMidnightAsUtc('2026-09-01', 'America/Guayaquil')).toBe('2026-09-01T05:00:00.000Z');
    expect(localMidnightAsUtc('2026-09-01', 'Europe/Madrid')).toBe('2026-08-31T22:00:00.000Z');
  });

  it('conserva el listado de membresías y protege el nuevo resumen con tenant y permiso financiero', () => {
    const controller = source('backend/src/controllers/payment.controller.ts');
    const routes = source('backend/src/routes/payment.routes.ts');
    const dashboard = source('frontend/src/pages/DashboardPage.tsx');
    expect(controller).toContain(".eq('gym_id', gymId).eq('status', 'confirmed')");
    expect(controller).toContain(".select('amount,currency,membership_id,sale_id,class_booking_id')");
    expect(controller).toContain(".eq('gym_id', request.tenant!.gymId).not('membership_id', 'is', null)");
    expect(routes).toContain("paymentRouter.get('/dashboard-summary', checkPermission('finances.view')");
    expect(dashboard).toContain("'/member-payments/dashboard-summary'");
  });
});
